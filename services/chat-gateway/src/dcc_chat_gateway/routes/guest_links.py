"""Gast-Links verwalten — erzeugen, auflisten, entwerten.

    POST   /channels/{channel_id}/guest-links   MOVE_MEMBERS
    GET    /guilds/{guild_id}/guest-links       MOVE_MEMBERS
    DELETE /guest-links/{link_id}               MOVE_MEMBERS

Der Beitritt selbst liegt in ``gast.py`` — er ist anonym und hat mit diesen
Routen nur den Code gemeinsam.

**Der Code wird genau einmal ausgeliefert**, in der Antwort auf das Erzeugen.
Danach gibt es ihn nicht mehr: gespeichert ist nur sein SHA-256 (Begründung im
Modell). Wer den Link verliert, erzeugt einen neuen und entwertet den alten.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from dcc_shared import gaeste as _geteilt

from dcc_chat_gateway import gaeste
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import CHANNEL_TYPE_VOICE, Channel, GuestLink
from dcc_chat_gateway.permissions import Permissions, check_permission
from dcc_chat_gateway.ratelimit import check as ratelimit_check
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id
from dcc_chat_gateway.zeit import als_utc
from dcc_chat_gateway.voice_evict import evict_gast

router = APIRouter()

# Vorgabe- und Höchstlaufzeit eines Links. Ein Tag deckt „wir treffen uns
# morgen um zehn" ab; eine Woche ist die Grenze, ab der ein weitergereichter
# Link zum stehenden Zugang würde, ohne dass es jemandem auffällt.
STANDARD_STUNDEN = 24
MAX_STUNDEN = 24 * 7


class GuestLinkIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    gueltig_stunden: Annotated[int, Field(ge=1, le=MAX_STUNDEN)] = STANDARD_STUNDEN


class GuestLinkOut(BaseModel):
    id: str
    channel_id: str
    guild_id: str
    expires_at: str
    revoked: bool
    created_by: str
    # Nur beim Erzeugen gesetzt — die Liste liefert ihn nie nach.
    code: str | None = None


def _out(link: GuestLink, *, code: str | None = None) -> GuestLinkOut:
    return GuestLinkOut(
        id=str(link.id),
        channel_id=str(link.channel_id),
        guild_id=str(link.guild_id),
        expires_at=link.expires_at.isoformat(),
        revoked=link.revoked_at is not None,
        created_by=str(link.created_by),
        code=code,
    )


@router.post("/channels/{channel_id}/guest-links", response_model=GuestLinkOut)
async def create_guest_link(
    channel_id: int,
    payload: GuestLinkIn,
    session: SessionDep,
    current: CurrentUser,
) -> GuestLinkOut:
    """Einen Besprechungslink für einen Sprachkanal erzeugen."""
    channel = await session.get(Channel, channel_id)
    if channel is None or channel.guild_id is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="channel not found")
    if channel.type != CHANNEL_TYPE_VOICE:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, detail="guest links are voice-channel only"
        )
    # MOVE_MEMBERS, kanalgenau geprüft: wer in genau diesem Kanal niemanden
    # bewegen darf, lädt auch niemanden hinein.
    await check_permission(
        session,
        current,
        channel.guild_id,
        Permissions.MOVE_MEMBERS,
        channel_id=channel_id,
    )
    if not ratelimit_check("guest_link", current.id):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limit exceeded"
        )
    code = gaeste.neuer_code()
    link = GuestLink(
        id=next_id(),
        guild_id=channel.guild_id,
        channel_id=channel_id,
        code_hash=gaeste.code_hash(code),
        created_by=current.id,
        expires_at=datetime.now(UTC) + timedelta(hours=payload.gueltig_stunden),
    )
    session.add(link)
    await session.commit()
    await session.refresh(link)
    return _out(link, code=code)


@router.get("/guilds/{guild_id}/guest-links", response_model=list[GuestLinkOut])
async def list_guest_links(
    guild_id: int,
    session: SessionDep,
    current: CurrentUser,
) -> list[GuestLinkOut]:
    """Die noch nicht abgelaufenen Links der Community.

    Abgelaufene fallen aus der Liste, entwertete bleiben sichtbar (solange sie
    nicht abgelaufen sind): „den habe ich abgeschaltet" ist eine Antwort, ein
    verschwundener Eintrag ist keine.
    """
    await check_permission(session, current, guild_id, Permissions.MOVE_MEMBERS)
    stmt = (
        select(GuestLink)
        .where(
            GuestLink.guild_id == guild_id,
            GuestLink.expires_at > datetime.now(UTC),
        )
        .order_by(GuestLink.id.desc())
        .limit(100)
    )
    return [_out(link) for link in (await session.execute(stmt)).scalars()]


@router.delete("/guest-links/{link_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_guest_link(
    link_id: int,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
) -> None:
    """Den Link entwerten UND alle Gäste rauswerfen, die über ihn drin sind.

    Beides gehört zusammen: ein Vermerk allein wirkte erst, wenn das letzte
    ausgestellte Ticket abgelaufen ist — bis zu vier Stunden später. Genau die
    Zeit, in der jemand die Besprechung verlassen soll.
    """
    link = await session.get(GuestLink, link_id)
    if link is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="guest link not found")
    await check_permission(
        session,
        current,
        link.guild_id,
        Permissions.MOVE_MEMBERS,
        channel_id=link.channel_id,
    )
    if link.revoked_at is None:
        link.revoked_at = datetime.now(UTC)
        await session.commit()

    redis = getattr(request.app.state, "redis", None)
    # ponytail: Schleife über die Gäste, drei Rundläufe je Gast (sperren,
    # Lese-Token, LiveKit). Decke: eine Besprechung hat eine Handvoll Gäste,
    # keine tausend. Aufstieg wäre ein Sammel-Aufruf an voice-signaling (den
    # es für Mitglieder schon gibt: ``channel_ids`` in einem Rutsch) — lohnt
    # sich erst, wenn jemand Gast-Links für Grossveranstaltungen benutzt.
    gast_ids = await gaeste.gaeste_des_links(redis, link_id)
    # Restlaufzeit als Sperrdauer: länger als das längstmögliche Ticket muss
    # die Sperre nie leben, kürzer darf sie nicht.
    rest = int((als_utc(link.expires_at) - datetime.now(UTC)).total_seconds())
    for gast_id in gast_ids:
        await _geteilt.sperren(redis, gast_id, min(max(rest, 1), _geteilt.TICKET_MAX_TTL_S))
        # Auch hier die Lese-Token wegnehmen — ein entwerteter Link, nach dem
        # ein Gast noch eine Stunde zusehen kann, ist nicht entwertet.
        await _geteilt.lese_token_loeschen(redis, gast_id)
        await evict_gast(link.channel_id, gast_id)
