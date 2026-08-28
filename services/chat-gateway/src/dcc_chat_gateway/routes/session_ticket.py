"""``POST /session`` — ein Cloud-Ticket gegen eine Sitzung dieses Servers tauschen.

Die Reihenfolge der Prüfungen ist nicht beliebig: Sperre der Instanz, Ticket,
Bann des Nutzers, Beitritt. Zuerst das, was den ganzen Server betrifft, dann das
Papier, dann die Person. Wer sie umstellt, verrät einem Fremden Dinge, die ihn
nichts angehen — etwa dass er auf diesem Server gebannt ist, obwohl sein Ticket
gar nicht gilt.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select

# Modul-Zugriff statt ``from … import get_settings``: Der Name waere sonst zur
# Importzeit an die LRU-gecachte Originalfunktion gebunden, und ein Austausch
# des Anbieters (Tests) ginge daran vorbei. Dieselbe Falle steht in
# ``owner_check.py`` und ``capabilities.py`` beschrieben — ich bin trotzdem
# hineingelaufen, und drei Tests haben es gefangen.
from dcc_chat_gateway import config as chat_config
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.identitaet_umschreiben import umschreiben
from dcc_chat_gateway.models import CachedUserProfile
from dcc_chat_gateway.routes.gates import enforce_ban_gate, enforce_join_gate
from dcc_chat_gateway.session_tokens import issue_session_token
from dcc_chat_gateway.suspend_poller import raise_if_suspended
from dcc_chat_gateway.ticket_pruefung import TicketFehler, pruefe_ticket

router = APIRouter(tags=["self-host"])

#: Eine Stunde.
#:
#: Nicht länger, weil das Bann-Gate beim Ausstellen greift: Ein gebannter Nutzer
#: käme sonst so lange weiter durch die REST-Schnittstelle. Für die lebende
#: Verbindung gibt es diesen Nachlauf gar nicht — ein Bann schliesst den Socket
#: sofort.
#:
#: Nicht kürzer, weil die früheren fünf Minuten den stillen Wiederanmelde-Sturm
#: erzeugten (alle vier Minuten ein voller Cert-Login je Tab), der diesen Umbau
#: ausgelöst hat.
#:
#: Der Socket kann ein frisches Token entgegennehmen (``ws_token_renewal``), aber
#: er STELLT keines aus — der Klient holt es hier, mit einem Ticket. Ein
#: Cloud-Ausfall beendet deshalb jede Sitzung binnen einer Stunde. Das ist
#: hingenommen (Entscheidung 2 der Spec) und ausdrücklich KEIN Stück
#: Cloud-Unabhängigkeit; ein früherer Kommentar behauptete das und lag falsch.
SITZUNGSDAUER_S = 3600

#: Läuft die Umschreibung schon, hält diese Marke einen zweiten Anlauf ab. Sie
#: hängt am Nutzer, nicht am Ticket — zwei gleichzeitige Anmeldungen desselben
#: Kontos dürfen sie nicht zweimal anstossen.
_UMSCHREIBUNG_MARKE = "umschreibung:erledigt:"


class SitzungEin(BaseModel):
    ticket: str = Field(..., min_length=1, max_length=8192)
    #: Optionale Zugänge für den ERSTEN Besuch. Ein Ticket beweist, wer jemand
    #: ist — nicht, dass er hier hereindarf. Wer noch kein Mitglied ist, legt
    #: hier seine Erlaubnis vor: einen Community-Einladungscode oder die
    #: öffentliche Adresse einer Community auf diesem Server. Beide werden
    #: NICHT verbraucht; die Einlösung geschieht später beim Beitritt zur
    #: Community selbst.
    community_grant_code: str | None = Field(default=None, max_length=128)
    public_join_handle: str | None = Field(default=None, max_length=64)


class SitzungAus(BaseModel):
    session_token: str
    expires_in: int


async def _altes_pseudonym(session, legacy_uid: int) -> str:
    """Das Pseudonym, unter dem dieser Nutzer bisher auf diesem Server lief.

    Es steht nicht im Ticket, und das ist Absicht: Der Server kann es selbst
    nachschlagen, weil ``cached_user_profiles`` beide Kennungen nebeneinander
    führt. Was der Empfänger selbst weiss, muss nicht über die Leitung.

    Leerer Rückgabewert heisst: kein Bestand für diesen Nutzer auf diesem Server.
    Die beiden Text-Spalten haben dann nichts umzuschreiben — die ``UPDATE``s
    laufen ins Leere, was richtig ist und nicht abgefangen werden muss.
    """
    return (
        await session.execute(
            select(CachedUserProfile.user_identifier).where(
                CachedUserProfile.synthetic_user_id == legacy_uid
            )
        )
    ).scalars().first() or ""


@router.post("/session", response_model=SitzungAus)
async def sitzung_aus_ticket(
    payload: SitzungEin, request: Request, session: SessionDep
) -> SitzungAus:
    settings = chat_config.get_settings()
    redis = request.app.state.redis

    await raise_if_suspended(redis)

    try:
        daten = await pruefe_ticket(
            payload.ticket,
            instanz_id=settings.pulse_instance_id,
            cloud_issuer=settings.pulse_oidc_issuer,
            redis=redis,
        )
    except TicketFehler as exc:
        # Der Code wandert unveraendert in die Antwort. Er ist der Unterschied
        # zwischen „hier ist der Handgriff" und der Sammelmeldung, die am
        # 2026-08-28 zwei Stunden Fehlersuche an einem gesunden Server kostete.
        raise HTTPException(status_code=403, detail=exc.code) from exc

    kennung = daten.sub
    ist_betreiber = bool(settings.pulse_instance_owner_id) and (
        kennung == str(settings.pulse_instance_owner_id)
    )

    await enforce_ban_gate(session, kennung, ist_betreiber)
    if settings.pulse_instance_mode == "self-host":
        await enforce_join_gate(
            session,
            kennung,
            ist_betreiber,
            payload.community_grant_code,
            payload.public_join_handle,
        )

    if daten.legacy_uid is not None:
        await _umschreiben_einmal(session, redis, kennung, daten.legacy_uid)

    return SitzungAus(
        session_token=issue_session_token(
            kennung,
            daten.jti,
            key_path=settings.session_signing_key_file,
            admin=ist_betreiber,
            ttl_seconds=SITZUNGSDAUER_S,
            # ``sub`` ist die Cloud-Kennung, kein Pseudonym. Ohne diesen Hinweis
            # jagte ``_decode_self_host_session_token`` sie durch
            # ``synthesize_self_host_user_id`` und machte aus einer Identitaet
            # wieder zwei.
            idform="cloud",
        ),
        expires_in=SITZUNGSDAUER_S,
    )


async def _umschreiben_einmal(session, redis, kennung: str, legacy_uid: int) -> None:
    """Hebt die Bestandszeilen dieses Nutzers, genau einmal.

    Scheitert die Umschreibung an einer Kollision, wird sie zurückgenommen und
    die Anmeldung läuft trotzdem durch: Der Nutzer kann nichts dafür, und ihn
    auszusperren machte die Lage schlechter statt besser. Die Marke fällt dabei
    mit, damit ein späterer Anlauf es erneut versuchen kann.
    """
    marke = f"{_UMSCHREIBUNG_MARKE}{kennung}"
    if not await redis.set(marke, "1", nx=True, ex=86400):
        return
    try:
        await umschreiben(
            session,
            alt_uid=legacy_uid,
            neu_uid=int(kennung),
            alt_text=await _altes_pseudonym(session, legacy_uid),
            neu_text=kennung,
        )
        await session.commit()
    except ValueError:
        await session.rollback()
        await redis.delete(marke)
