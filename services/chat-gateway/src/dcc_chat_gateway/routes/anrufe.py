"""Anrufe aus DMs und privaten Gruppen (Übergabe P0, Anrufe-Epic A+B).

Die Call-Entität lebt hier, weil die Mitgliedschaften hier sitzen (DM-
Paare, Gruppen-Mitglieder); voice-signaling löst nur den LiveKit-Token
und fragt dafür ``GET /anrufe/{id}/mitgliedschaft`` mit dem User-Bearer
an (``routes/call_token.py`` dort).

Signalisierung läuft als Ephemeral-Events an konkrete Teilnehmerkonten
(``publish_user_event``, Muster wie die Freundes-Events) — kein Gap-Fill,
wer offline ist, verpasst den Anruf (Push folgt mit P0.1/FCM).

Bewusste Grenzen (ponytail): kein Teilnehmer-je-Anruf-Ring im Server —
wer im LiveKit-Raum ist, weiß die Presence-Schicht dort; die
Systemzeile „Verpasst/Dauer“ baut der Klient beim Ende selbst in den
Chat (in E2EE-DMs darf der Server die Zeile ohnehin nicht sehen).
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Body, HTTPException, Request, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from dcc_chat_gateway import anruf_push
from dcc_chat_gateway.db import SessionDep, SessionLocal
from dcc_chat_gateway.friend_helpers import block_exists_either_way, friendship_exists
from dcc_chat_gateway.models import (
    Anruf,
    ART_DM,
    ART_GRUPPE,
    DirectMessageChannel,
    PrivateGroupMember,
    ZUSTAND_BEENDET,
    ZUSTAND_KLINGELND,
    ZUSTAND_LAEUFEND,
    GRUND_AUFGELEGT,
    GRUND_ABGELEHNT,
    GRUND_VERPASST,
)
from dcc_chat_gateway import ratelimit
from dcc_chat_gateway.routes._deps import CloudOnly, dm_member_check
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id
from dcc_shared.events import (
    CallAbgelehntEvent,
    CallAngenommenEvent,
    CallEndeEvent,
    CallKlingeltEvent,
)

log = logging.getLogger(__name__)

router = APIRouter(dependencies=[CloudOnly])

GRUND_NAMEN = {GRUND_AUFGELEGT: "aufgelegt", GRUND_ABGELEHNT: "abgelehnt", GRUND_VERPASST: "verpasst"}


class AnrufIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    art: Literal["dm", "gruppe"]
    channel_id: int


class AnrufOut(BaseModel):
    id: str


class AnrufAktionIn(BaseModel):
    """Optionaler Rumpf von annehmen/ablehnen/auflegen.

    ``geraet_id`` ist die Push-Kennung des HANDELNDEN Geräts (dieselbe, mit
    der es seinen VoIP-Token angemeldet hat). Dort ist der Anruf schon zu —
    ein Abbruch-Push dorthin fände keinen Anruf, den die Hülle melden könnte,
    und das ist genau der Push, der iOS dazu bringt, die App zu beenden
    (Bughunt 2026-10-11, K3; Begründung in ``anruf_push.py``). Ältere Klienten
    schicken keinen Rumpf; dann geht der Abbruch an alle geklingelten Geräte,
    wie zuvor.
    """

    model_config = ConfigDict(extra="forbid")

    geraet_id: str | None = Field(default=None, min_length=1, max_length=128)


AktionDep = Annotated[AnrufAktionIn | None, Body()]


def _handelndes_geraet(user_id: int, aktion: AnrufAktionIn | None) -> tuple[int, str] | None:
    if aktion is None or aktion.geraet_id is None:
        return None
    return (user_id, aktion.geraet_id)


def _push_umfeld(request: Request) -> dict[str, Any]:
    """Redis und Sitzungsfabrik für den Push-Weg. Die Fabrik des Managers, wo
    es einen gibt — sonst sähen die Tests eine andere Datenbank als die Route
    (Muster: ``manager._session_factory``, s. CLAUDE.md, Plugin-Abschnitt)."""
    manager = getattr(request.app.state, "connection_manager", None)
    return {
        "redis": getattr(request.app.state, "redis", None) or getattr(manager, "redis", None),
        "session_factory": getattr(manager, "_session_factory", None) or SessionLocal,
    }


async def _teilnehmer(session, anruf: Anruf) -> list[int]:
    """Alle Teilnehmerkonten des Anrufs (Initiator inklusive)."""
    if anruf.art == ART_DM:
        dm = await session.get(DirectMessageChannel, anruf.channel_id)
        if dm is None:
            return []
        return [dm.user_a_id, dm.user_b_id]
    rows = await session.execute(
        select(PrivateGroupMember.user_id).where(PrivateGroupMember.gruppe_id == anruf.channel_id)
    )
    return [r for r in rows.scalars().all()]


async def _anruf_als_mitglied(session, anruf_id: int, user_id: int) -> Anruf:
    """Lädt den Anruf nur, wenn der Aufrufer Teilnehmer ist (beide Arten)."""
    anruf = await session.get(Anruf, anruf_id)
    if anruf is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="anruf_not_found")
    if user_id not in await _teilnehmer(session, anruf):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="anruf_not_found")
    return anruf


async def _publish(request: Request, konten: list[int], ereignis) -> None:
    """Best-effort an alle Teilnehmerkonten — Muster wie postfach/lesestand."""
    manager = getattr(request.app.state, "connection_manager", None)
    if manager is None:
        return
    for konto in set(konten):
        try:
            await manager.publish_user_event(konto, ereignis)
        except Exception:
            log.exception("call event publish failed for user %s", konto)


async def _beenden(
    session,
    request: Request,
    anruf: Anruf,
    grund: int,
    *,
    dauer_sek: int,
    ausser: tuple[int, str] | None,
) -> None:
    """Finalisiert den Anruf und meldet das Ende an alle Teilnehmer."""
    anruf.zustand = ZUSTAND_BEENDET
    anruf.grund = grund
    anruf.beendet_at = datetime.now(tz=timezone.utc)
    await session.commit()
    teilnehmer = await _teilnehmer(session, anruf)
    await _publish(
        request,
        teilnehmer,
        CallEndeEvent(call_id=str(anruf.id), grund=GRUND_NAMEN[grund], dauer_sek=dauer_sek),
    )
    # Abbruch-Push: ohne ihn klingelt ein iPhone mit eingefrorener Oberfläche
    # ins Leere. Nur an Geräte, die noch klingeln (s. ``anruf_push.abbrechen``)
    # — nicht an den Anrufer, nicht an das handelnde Gerät.
    await anruf_push.abbrechen(**_push_umfeld(request), call_id=str(anruf.id), ausser=ausser)


@router.post("/anrufe", response_model=AnrufOut, status_code=status.HTTP_201_CREATED)
async def anruf_starten(
    payload: AnrufIn,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
) -> AnrufOut:
    """Klingeln lassen: legt den Anruf an und ruft alle weiteren Teilnehmer."""
    # Schritt 0, vor jeder DB-Runde (Muster postfach): das Klingeln geht als
    # Fan-out an alle Geräte einer ganzen Gruppe — ohne Bremse ein Spam-Vektor.
    if not ratelimit.check("anruf_start", current.id):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limit exceeded")
    art_code = ART_DM if payload.art == "dm" else ART_GRUPPE

    if art_code == ART_DM:
        dm = await dm_member_check(session, payload.channel_id, current.id)
        if dm is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="dm_channel_not_found")
        andere = [uid for uid in (dm.user_a_id, dm.user_b_id) if uid != current.id]
        # **Dieselbe Regel wie beim Schreiben** (``_postfach_deps.py``): keine
        # Blockierung in keiner Richtung, und befreundet. Bis zum 2026-10-11
        # prüfte diese Route nur die Mitgliedschaft — und seit dem VoIP-Push
        # klingelt ein Anruf per CallKit auch bei geschlossener App, bis zu
        # fünfmal je Minute, von jemandem, den man blockiert hat (Bughunt T3).
        # Die Reihenfolge der beiden Prüfungen und ihre Texte sind die des
        # Postfachs, damit ein Klient beide Wege gleich deuten kann.
        if await block_exists_either_way(session, current.id, andere[0]):
            raise HTTPException(status.HTTP_403_FORBIDDEN, detail="blocked")
        if not await friendship_exists(session, current.id, andere[0]):
            raise HTTPException(status.HTTP_403_FORBIDDEN, detail="not_friends")
    else:
        rows = await session.execute(
            select(PrivateGroupMember.user_id).where(
                PrivateGroupMember.gruppe_id == payload.channel_id
            )
        )
        mitglieder = list(rows.scalars().all())
        if current.id not in mitglieder:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="gruppe_not_found")
        andere = [uid for uid in mitglieder if uid != current.id]

    anruf = Anruf(
        id=next_id(),
        art=art_code,
        channel_id=payload.channel_id,
        einleiter_id=current.id,
        zustand=ZUSTAND_KLINGELND,
    )
    session.add(anruf)
    await session.commit()

    await _publish(
        request,
        andere,
        CallKlingeltEvent(
            call_id=str(anruf.id),
            art=payload.art,
            channel_id=str(anruf.channel_id),
            einleiter_id=str(current.id),
        ),
    )
    # VoIP-Push an alle iOS-Geräte der Gerufenen (Punkt 40). Ohne ihn
    # erreicht ein Anruf nur, wer eine offene Verbindung hat — wer das Telefon
    # in der Tasche hat, verpasst ihn, ohne dass irgendwo etwas schiefgeht
    # (Begründung im Kopf von ``apns_voip.py``, warum ohne Frische-Prüfung im
    # Kopf von ``anruf_push.py``). Gesendet wird im Hintergrund — die Antwort
    # mit der Kennung wartet nicht auf Apple (T17). Fail-open: ohne
    # APNs-Schlüssel passiert hier nichts.
    await anruf_push.klingeln(
        session=session,
        **_push_umfeld(request),
        empfaenger_ids=set(andere),
        call_id=str(anruf.id),
        art=payload.art,
        channel_id=str(anruf.channel_id),
        einleiter_id=str(current.id),
        einleiter_name=current.username,
    )
    return AnrufOut(id=str(anruf.id))


@router.post("/anrufe/{anruf_id}/annehmen", status_code=status.HTTP_204_NO_CONTENT)
async def anruf_annehmen(
    anruf_id: int,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
    aktion: AktionDep = None,
) -> None:
    anruf = await _anruf_als_mitglied(session, anruf_id, current.id)
    if anruf.zustand == ZUSTAND_BEENDET:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="anruf_vorbei")
    # Das Klingeln der ÜBRIGEN Geräte beenden — bis zum 2026-10-11 tat das
    # niemand, ein per Push klingelndes Zweit-iPhone klingelte also weiter,
    # bis das ganze Gespräch vorbei war (Bughunt T4). Im Gruppenanruf nur die
    # eigenen: die anderen Mitglieder dürfen weiter beitreten.
    await anruf_push.abbrechen(
        **_push_umfeld(request),
        call_id=str(anruf.id),
        nur_konten={current.id} if anruf.art == ART_GRUPPE else None,
        ausser=_handelndes_geraet(current.id, aktion),
    )
    if anruf.zustand == ZUSTAND_KLINGELND:
        anruf.zustand = ZUSTAND_LAEUFEND
        anruf.verbunden_at = datetime.now(tz=timezone.utc)
        await session.commit()
        # Nur beim echten Übergang klingelnd → laufend: ein Zweitgerät, das
        # denselben Anruf ebenfalls „annimmt“, darf die Annahme-Nachricht
        # nicht erneut ausspielen — sie erreichte sonst JEDES Gerät des
        # Kontos ein zweites Mal und war der Einstieg für Doppel-Verbindungen.
        await _publish(
            request,
            await _teilnehmer(session, anruf),
            CallAngenommenEvent(call_id=str(anruf.id), user_id=str(current.id)),
        )


@router.post("/anrufe/{anruf_id}/ablehnen", status_code=status.HTTP_204_NO_CONTENT)
async def anruf_ablehnen(
    anruf_id: int,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
    aktion: AktionDep = None,
) -> None:
    anruf = await _anruf_als_mitglied(session, anruf_id, current.id)
    if anruf.zustand == ZUSTAND_BEENDET:
        return
    geraet = _handelndes_geraet(current.id, aktion)
    if anruf.zustand == ZUSTAND_LAEUFEND and anruf.art == ART_DM:
        # Ein laufender Anruf ist angenommen — ein „Ablehnen“ (der 45-s-Wecker
        # eines Zweitgeräts, das die Annahme verpasst hat) darf ihn nicht
        # totschlagen. Das Gerät räumt lokal auf, der Anruf läuft weiter.
        raise HTTPException(status.HTTP_409_CONFLICT, detail="anruf_laeuft")
    await _publish(
        request,
        await _teilnehmer(session, anruf),
        CallAbgelehntEvent(call_id=str(anruf.id), user_id=str(current.id)),
    )
    # 1:1: eine Ablehnung ist das Ende. Gruppenanrufe laufen weiter — auch
    # schon laufende: wer dort ablehnt, tritt nur nicht bei. Bis zum
    # 2026-10-11 antwortete ein laufender Gruppenanruf hier mit 409, und ein
    # Mitglied, dessen iPhone noch klingelte, kam nie aus dem Klingeln heraus
    # (Bughunt T4). Seine eigenen Geräte hören auf zu klingeln.
    if anruf.art == ART_DM:
        await _beenden(session, request, anruf, GRUND_ABGELEHNT, dauer_sek=0, ausser=geraet)
    else:
        await anruf_push.abbrechen(
            **_push_umfeld(request), call_id=str(anruf.id), nur_konten={current.id}, ausser=geraet
        )


@router.post("/anrufe/{anruf_id}/auflegen", status_code=status.HTTP_204_NO_CONTENT)
async def anruf_auflegen(
    anruf_id: int,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
    aktion: AktionDep = None,
) -> None:
    anruf = await _anruf_als_mitglied(session, anruf_id, current.id)
    if anruf.zustand == ZUSTAND_BEENDET:
        return
    geraet = _handelndes_geraet(current.id, aktion)

    if anruf.zustand == ZUSTAND_LAEUFEND and anruf.art == ART_GRUPPE:
        # Gruppenanruf: ein Auflegen beendet nur den eigenen Weg — der Anruf
        # läuft für die übrigen Teilnehmer weiter (wie bei ablehnen). Ob noch
        # jemand drin ist, weiß nur die LiveKit-Präsenz; der Server führt
        # bewusst keinen Teilnehmer-Ring (ponytail, Modul-Kopf).
        return

    if anruf.zustand == ZUSTAND_LAEUFEND and anruf.verbunden_at is not None:
        jetzt = datetime.now(tz=timezone.utc)
        verbunden = anruf.verbunden_at
        # SQLite (Tests) liefert naive Datetimes — als UTC interpretieren.
        if verbunden.tzinfo is None:
            verbunden = verbunden.replace(tzinfo=timezone.utc)
        grund = GRUND_AUFGELEGT
        dauer_sek = int((jetzt - verbunden).total_seconds())
    else:
        # Nie verbunden: Ausgehender Ruf ohne Annahme bzw. abgebrochenes
        # Klingeln → für die Gegenseite verpasst.
        grund = GRUND_VERPASST
        dauer_sek = 0
    await _beenden(session, request, anruf, grund, dauer_sek=dauer_sek, ausser=geraet)


@router.get("/anrufe/{anruf_id}/mitgliedschaft")
async def anruf_mitgliedschaft(
    anruf_id: int,
    session: SessionDep,
    current: CurrentUser,
):
    """Membership-Auskunft für voice-signaling (``POST /call/token`` dort):
    nur Teilnehmer bekommen den Raumnamen — fail-closed 404."""
    anruf = await _anruf_als_mitglied(session, anruf_id, current.id)
    return {"room": anruf.raum()}
