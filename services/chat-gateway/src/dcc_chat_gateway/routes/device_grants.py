"""Freigabeliste eines Standplatz-Geräts — lesen und ersetzen.

**Nur der Besitzer, lesend wie schreibend.** ``MANAGE_GUILD`` darf ein Gerät
räumen und umbenennen (``routes/devices.py``), aber nicht in seine Freigaben
sehen und nicht freigeben: Räumen ist Hausrecht, Freigeben wäre der
Admin-Fernschalter, den der Entwurf gerade ausschliesst. Hineinsehen wäre dessen
Vorstufe und hat keinen Zweck, den Räumen nicht schon erfüllt.

**Ersetzen statt einzeln ändern.** Ein ``PUT`` der ganzen Liste hat keinen
Zwischenzustand „scharf, aber für niemanden" — dieselbe Begründung, aus der die
gerätelokale Fassung genau einen Weg hinein hatte.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, field_validator
from sqlalchemy import delete, select

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import SUBJECT_EVERYONE, SUBJECT_TYPES, Device, DeviceGrant
from dcc_chat_gateway.routes._deps import require_member
from dcc_chat_gateway.schemas import SnowflakeId
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id

router = APIRouter(prefix="/guilds/{guild_id}/devices/{device_id}/grants", tags=["devices"])


class GrantIn(BaseModel):
    subject_type: str
    subject_id: SnowflakeId | None = None
    expires_at: datetime | None = None

    @field_validator("subject_type")
    @classmethod
    def _art(cls, wert: str) -> str:
        if wert not in SUBJECT_TYPES:
            raise ValueError(f"subject_type must be one of {SUBJECT_TYPES}")
        return wert

    @field_validator("subject_id")
    @classmethod
    def _kennung(cls, wert: int | None, info) -> int | None:
        # ``everyone`` trägt keine Kennung, die beiden anderen brauchen eine.
        # Ohne diese Prüfung entstünde eine Zeile, die nie jemanden meint — und
        # sie sähe in der Oberfläche aus wie eine erteilte Freigabe.
        art = info.data.get("subject_type")
        if art == SUBJECT_EVERYONE and wert is not None:
            raise ValueError("everyone carries no subject_id")
        if art in ("user", "role") and wert is None:
            raise ValueError("subject_id is required for user and role grants")
        return wert


class GrantsIn(BaseModel):
    grants: list[GrantIn]


class GrantOut(BaseModel):
    id: str
    subject_type: str
    subject_id: str | None
    expires_at: datetime | None
    created_at: datetime


def _out(zeile: DeviceGrant) -> GrantOut:
    return GrantOut(
        id=str(zeile.id),
        subject_type=zeile.subject_type,
        subject_id=str(zeile.subject_id) if zeile.subject_id is not None else None,
        expires_at=zeile.expires_at,
        created_at=zeile.created_at,
    )


async def _eigenes_geraet(session, guild_id: int, device_id: int, user) -> Device:
    """Das Gerät laden — und nur, wenn es dem Rufer gehört.

    404 statt 403 für ein fremdes Gerät: die Antwort soll nicht verraten, wem
    welche Kennung gehört. Für den Besitzer ist der Unterschied unsichtbar.
    """
    device = await session.get(Device, device_id)
    if device is None or device.guild_id != guild_id or device.owner_user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="device not found")
    return device


@router.get("", response_model=list[GrantOut])
async def list_grants(
    guild_id: SnowflakeId, device_id: SnowflakeId, user: CurrentUser, session: SessionDep
) -> list[GrantOut]:
    await require_member(session, guild_id, user.id)
    await _eigenes_geraet(session, guild_id, device_id, user)
    treffer = await session.execute(
        select(DeviceGrant).where(DeviceGrant.device_id == device_id)
    )
    return [_out(z) for z in treffer.scalars()]


@router.put("", response_model=list[GrantOut])
async def set_grants(
    guild_id: SnowflakeId,
    device_id: SnowflakeId,
    body: GrantsIn,
    user: CurrentUser,
    session: SessionDep,
) -> list[GrantOut]:
    await require_member(session, guild_id, user.id)
    await _eigenes_geraet(session, guild_id, device_id, user)
    await session.execute(delete(DeviceGrant).where(DeviceGrant.device_id == device_id))
    neu = [
        DeviceGrant(
            id=next_id(),
            device_id=device_id,
            subject_type=g.subject_type,
            subject_id=g.subject_id,
            expires_at=g.expires_at,
            created_by_user_id=user.id,
        )
        for g in body.grants
    ]
    session.add_all(neu)
    await session.commit()
    for z in neu:
        await session.refresh(z)
    return [_out(z) for z in neu]
