"""Beitritt und Sicht eines Gastes — die einzigen Routen ohne Konto.

    GET  /gast/{code}                   anonym — was für eine Besprechung?
    POST /gast/{code}/beitritt          anonym — Name rein, Ticket raus
    GET  /gast/sitzung/stream-state     Ticket — läuft gerade eine Übertragung?
    GET  /gast/sitzung/whep             Ticket — Zuschau-URL für eine Übertragung

Die beiden Ticket-Routen liegen unter ``/gast/sitzung/…`` und nicht direkt
unter ``/gast/…``: ``/gast/{code}`` frisst jeden einsegmentigen Pfad darunter,
und ein ``/gast/stream-state`` wäre je nach Registrierungsreihenfolge mal
Route, mal „Code nicht gefunden". Die Trennung liegt damit in der Form des
Pfades statt in der Reihenfolge im Quelltext — eine Umsortierung kann sie
nicht mehr kaputt machen. (Genau so passiert, beim ersten Testlauf: 404 statt
403.)

Die ersten beiden sind die **ersten unauthentifizierten Routen im
chat-gateway**. Der vorhandene Zähler (``ratelimit.py``) hängt an einer
Nutzer-ID und lebt im Prozess; für Anonyme greift er nicht und hinter mehreren
Instanzen wäre er ein Zähler je Instanz. Beide bremsen deshalb über Redis
(``gaeste.bremse_pruefen``), zweifach: pro IP und pro Code.

Abgelaufen, entwertet und unbekannt antworten **gleich** (404). Sonst verriete
die Antwort, welche Codes es einmal gab.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

import httpx
from fastapi import APIRouter, Header, HTTPException, Path, Query, Request, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from dcc_shared import gaeste as _geteilt

from dcc_chat_gateway import gaeste
from dcc_chat_gateway.config import get_settings
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import Channel, GuestLink, Guild
from dcc_chat_gateway.routes.streaming import SlotQuery, _bearer_from_header
from dcc_chat_gateway.security import CurrentGast
from dcc_chat_gateway.snowflake import next_id
from dcc_chat_gateway.zeit import als_utc

router = APIRouter()

# Der Code ist 22 Zeichen lang (128 bit, ``gaeste.neuer_code``). Die Schranke
# steht trotzdem da: ohne sie nimmt die Route jeden beliebig langen Pfad
# entgegen und hasht ihn, bevor irgendeine Bremse greift.
CodePfad = Annotated[str, Path(min_length=1, max_length=64)]


class GastInfoOut(BaseModel):
    guild_name: str
    channel_name: str
    expires_at: str


class BeitrittIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Annotated[str, Field(min_length=1, max_length=32)]


class BeitrittOut(BaseModel):
    ticket: str
    expires_in: int
    gast_id: str
    channel_id: str
    guild_id: str
    guild_name: str
    channel_name: str


def _absender_ip(request: Request) -> str | None:
    """Die IP des Aufrufers, wie sie hinter dem Proxy ankommt.

    ``X-Forwarded-For`` kann der Aufrufer selbst setzen — als
    Sicherheitsmerkmal wäre der Wert wertlos. Für eine Bremse taugt er
    trotzdem: wer ihn fälscht, umgeht die IP-Zählung und läuft in die
    Code-Zählung, die daneben steht und nicht fälschbar ist.
    """
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()[:64]
    return request.client.host if request.client else None


async def _link_holen(session, code: str, redis, request: Request, aktion: str):
    """Den lebenden Link zu einem Code — oder 404 für jede Art von „nein"."""
    code_h = gaeste.code_hash(code)
    await gaeste.bremse_pruefen(
        redis, ip=_absender_ip(request), code_h=code_h, aktion=aktion
    )
    link = (
        await session.execute(select(GuestLink).where(GuestLink.code_hash == code_h))
    ).scalar_one_or_none()
    if (
        link is None
        or link.revoked_at is not None
        or als_utc(link.expires_at) <= datetime.now(UTC)
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="link not found")
    return link


async def _namen(session, link: GuestLink) -> tuple[str, str]:
    guild = await session.get(Guild, link.guild_id)
    channel = await session.get(Channel, link.channel_id)
    if guild is None or channel is None:
        # Kanal oder Community sind weg — der Link zeigt ins Leere. Für den
        # Aufrufer ununterscheidbar von einem falschen Code, und das ist auch
        # richtig so: er kann so oder so nicht beitreten.
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="link not found")
    return guild.name, channel.name


async def _limit_pruefen(session, redis, channel_id: int) -> None:
    """409, wenn der Sprachkanal schon voll ist.

    Das Benutzerlimit gilt für einen Gast wie für jeden anderen — er belegt
    einen Platz. Geprüft wird hier und nicht bei der Token-Ausgabe in
    voice-signaling: die Kanal-Zeile mit dem Limit liegt in DIESER Datenbank,
    und der Gast-Weg dort hat keinen Nutzer-Bearer, mit dem er danach fragen
    könnte. Ein zweiter Weg an dieselbe Zahl wäre eine zweite Wahrheit.

    Weich wie das bestehende Limit (dieselbe Begründung wie in
    ``voice-signaling/routes/token.py``): zwei gleichzeitige Beitritte können
    es um eins überschreiten, und ein Redis-Ausfall hebt es auf.
    """
    channel = await session.get(Channel, channel_id)
    limit = int(getattr(channel, "user_limit", 0) or 0)
    if limit <= 0 or redis is None:
        return
    try:
        belegt = await redis.scard(f"voice:room:channel-{channel_id}")
    except Exception:  # noqa: BLE001 — Redis-Transportfehler → fail-open
        return
    if belegt >= limit:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="voice channel is full")


@router.get("/gast/{code}", response_model=GastInfoOut)
async def gast_info(
    code: CodePfad,
    session: SessionDep,
    request: Request,
) -> GastInfoOut:
    """Vorschau für den Vorraum: welche Community, welcher Kanal, wie lange."""
    redis = getattr(request.app.state, "redis", None)
    link = await _link_holen(session, code, redis, request, "info")
    guild_name, channel_name = await _namen(session, link)
    return GastInfoOut(
        guild_name=guild_name,
        channel_name=channel_name,
        expires_at=link.expires_at.isoformat(),
    )


@router.post("/gast/{code}/beitritt", response_model=BeitrittOut)
async def gast_beitritt(
    code: CodePfad,
    payload: BeitrittIn,
    session: SessionDep,
    request: Request,
) -> BeitrittOut:
    """Ein Gast-Ticket für diesen Link ausstellen lassen.

    Die Laufzeit ist die Restlaufzeit des Links, gedeckelt auf vier Stunden
    (``dcc_shared.gaeste.TICKET_MAX_TTL_S`` — dieselbe Zahl, die auth-svc beim
    Ausstellen deckelt).
    Ein Ticket lebt damit nie länger als der Link, der es rechtfertigt — und
    weil ``ticket_holen`` jede Laufzeit unter einer Minute anhebt, wird ein
    Link in seiner letzten Minute gar nicht mehr eingelöst (s. unten).
    """
    redis = getattr(request.app.state, "redis", None)
    link = await _link_holen(session, code, redis, request, "beitritt")
    guild_name, channel_name = await _namen(session, link)
    name = payload.name.strip()
    if not name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="name required")

    await _limit_pruefen(session, redis, link.channel_id)

    rest = int((als_utc(link.expires_at) - datetime.now(UTC)).total_seconds())
    if rest < _geteilt.TICKET_MIN_TTL_S:
        # Ein Link, der in unter einer Minute abläuft, taugt nicht mehr als
        # Zutritt. Ihn trotzdem einzulösen hiesse, ein Ticket auszustellen,
        # das den Link ÜBERLEBT — ``ticket_holen`` hebt jede kürzere Laufzeit
        # auf diese Untergrenze an (auth-svc nimmt darunter nichts an). Für
        # den Gast ist das dasselbe wie abgelaufen, also dieselbe Antwort.
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="link not found")

    gast_id = f"gast-{next_id()}"
    ttl = min(rest, _geteilt.TICKET_MAX_TTL_S)
    ticket, ttl = await gaeste.ticket_holen(
        gast_id=gast_id,
        guild_id=link.guild_id,
        channel_id=link.channel_id,
        name=name,
        ttl_s=ttl,
    )
    await gaeste.gast_eintragen(
        redis,
        gast_id=gast_id,
        name=name,
        link_id=link.id,
        guild_id=link.guild_id,
        channel_id=link.channel_id,
        ttl_s=ttl,
    )
    return BeitrittOut(
        ticket=ticket,
        expires_in=ttl,
        gast_id=gast_id,
        channel_id=str(link.channel_id),
        guild_id=str(link.guild_id),
        guild_name=guild_name,
        channel_name=channel_name,
    )


async def _gast_pruefen(gast: CurrentGast, request: Request, channel_id: str) -> None:
    """Kanalbindung + Rauswurf-Sperre. Beides oder nichts."""
    if gast.channel_id != channel_id:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, detail="ticket is for another channel"
        )
    redis = getattr(request.app.state, "redis", None)
    if await _geteilt.ist_gesperrt(redis, gast.gast_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="removed from the meeting")


@router.get("/gast/sitzung/stream-state")
async def gast_stream_state(
    gast: CurrentGast,
    request: Request,
) -> dict[str, list[dict[str, object]]]:
    """Wer überträgt gerade in DEM Kanal des Tickets.

    ponytail: Abfrage statt Zustellung. Decke: der Gast erfährt Anfang und Ende
    einer Übertragung um die Abfragefrist verzögert (Klient: 5 s), und jeder
    Gast kostet eine Anfrage alle 5 s. Aufstieg: ein schlanker Gast-WebSocket
    — er kostet aber einen zweiten Zugangsweg mit eigener Rechteprüfung, und
    dafür ist die Verzögerung hier zu billig.
    """
    await _gast_pruefen(gast, request, gast.channel_id)
    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is None:
        return {"stream_states": []}
    return {"stream_states": await mgr.stream_states_for([gast.channel_id])}


@router.get("/gast/sitzung/whep")
async def gast_whep(
    gast: CurrentGast,
    request: Request,
    user_id: Annotated[str, Query(min_length=1, max_length=20, pattern=r"^\d+$")],
    # Dieselbe Schranke wie auf dem Mitglieder-Weg, aus derselben Quelle: eine
    # eigene Zahl hier liesse Plätze durch, die media-svc nie annimmt (sie
    # stand kurzzeitig auf 99, SLOT_MAX ist 98 — der Gast bekam dafür ein
    # weitergereichtes 422 statt einer sauberen Abweisung).
    slot: SlotQuery = 0,
    authorization: Annotated[str | None, Header()] = None,
) -> dict[str, object]:
    """Zuschau-URL für die HQ-Übertragung eines Mitglieds im Ticket-Kanal.

    Reicht das Gast-Ticket an media-svc weiter, das dort eine eigene
    Gast-Route hat (``GET /gast/whep``) — dieselbe Aufteilung wie beim
    Mitglied, nur ohne Mitgliedschaftsprüfung: die Kanalbindung des Tickets
    IST die Berechtigung.
    """
    await _gast_pruefen(gast, request, gast.channel_id)
    settings = get_settings()
    # Den vorhandenen Helfer nehmen statt selbst zu zerlegen: er wirft bei
    # einem Header ohne ``Bearer``-Präfix, wo die Handarbeit hier den ganzen
    # Wert als Token durchgereicht hätte.
    bearer = _bearer_from_header(authorization)
    url = (
        settings.media_svc_url.rstrip("/")
        + f"/gast/whep?channel_id={gast.channel_id}&user_id={user_id}&slot={slot}"
    )
    http = getattr(request.app.state, "media_svc_http", None)
    try:
        if http is not None:
            resp = await http.get(url, headers={"Authorization": f"Bearer {bearer}"})
        else:
            async with httpx.AsyncClient(timeout=settings.media_svc_timeout_s) as client:
                resp = await client.get(
                    url, headers={"Authorization": f"Bearer {bearer}"}
                )
    except httpx.HTTPError as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, detail="media service unavailable"
        ) from exc
    if resp.status_code >= 400:
        raise HTTPException(resp.status_code, detail="media service rejected the request")
    return resp.json()
