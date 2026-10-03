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
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select

from dcc_chat_gateway.db import SessionDep
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
    session, request: Request, anruf: Anruf, grund: int, *, dauer_sek: int
) -> None:
    """Finalisiert den Anruf und meldet das Ende an alle Teilnehmer."""
    anruf.zustand = ZUSTAND_BEENDET
    anruf.grund = grund
    anruf.beendet_at = datetime.now(tz=timezone.utc)
    await session.commit()
    await _publish(
        request,
        await _teilnehmer(session, anruf),
        CallEndeEvent(call_id=str(anruf.id), grund=GRUND_NAMEN[grund], dauer_sek=dauer_sek),
    )


@router.post("/anrufe", response_model=AnrufOut, status_code=status.HTTP_201_CREATED)
async def anruf_starten(
    payload: AnrufIn,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
) -> AnrufOut:
    """Klingeln lassen: legt den Anruf an und ruft alle weiteren Teilnehmer."""
    art_code = ART_DM if payload.art == "dm" else ART_GRUPPE

    if art_code == ART_DM:
        dm = await dm_member_check(session, payload.channel_id, current.id)
        if dm is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="dm_channel_not_found")
        andere = [uid for uid in (dm.user_a_id, dm.user_b_id) if uid != current.id]
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
    return AnrufOut(id=str(anruf.id))


@router.post("/anrufe/{anruf_id}/annehmen", status_code=status.HTTP_204_NO_CONTENT)
async def anruf_annehmen(
    anruf_id: int,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
) -> None:
    anruf = await _anruf_als_mitglied(session, anruf_id, current.id)
    if anruf.zustand == ZUSTAND_BEENDET:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="anruf_vorbei")
    if anruf.zustand == ZUSTAND_KLINGELND:
        anruf.zustand = ZUSTAND_LAEUFEND
        anruf.verbunden_at = datetime.now(tz=timezone.utc)
        await session.commit()
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
) -> None:
    anruf = await _anruf_als_mitglied(session, anruf_id, current.id)
    await _publish(
        request,
        await _teilnehmer(session, anruf),
        CallAbgelehntEvent(call_id=str(anruf.id), user_id=str(current.id)),
    )
    # 1:1: eine Ablehnung ist das Ende. Gruppenanrufe laufen weiter.
    if anruf.art == ART_DM:
        await _beenden(session, request, anruf, GRUND_ABGELEHNT, dauer_sek=0)


@router.post("/anrufe/{anruf_id}/auflegen", status_code=status.HTTP_204_NO_CONTENT)
async def anruf_auflegen(
    anruf_id: int,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
) -> None:
    anruf = await _anruf_als_mitglied(session, anruf_id, current.id)
    if anruf.zustand == ZUSTAND_BEENDET:
        return

    if anruf.zustand == ZUSTAND_LAEUFEND and anruf.verbunden_at is not None:
        jetzt = datetime.now(tz=timezone.utc)
        verbunden = anruf.verbunden_at
        # SQLite (Tests) liefert naive Datetimes — als UTC interpretieren.
        if verbunden.tzinfo is None:
            verbunden = verbunden.replace(tzinfo=timezone.utc)
        await _beenden(
            session, request, anruf, GRUND_AUFGELEGT, dauer_sek=int((jetzt - verbunden).total_seconds())
        )
    else:
        # Nie verbunden: Ausgehender Ruf ohne Annahme bzw. abgebrochenes
        # Klingeln → für die Gegenseite verpasst.
        await _beenden(session, request, anruf, GRUND_VERPASST, dauer_sek=0)


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
