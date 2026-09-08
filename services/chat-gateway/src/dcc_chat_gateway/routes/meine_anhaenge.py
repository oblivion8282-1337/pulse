"""Backfill eigener Anhang-Metadaten („Medien-Nachziehen", Stufe A1).

Der Klient kann damit auf einem frisch gekoppelten Gerät seine
Upload-Historie Seiten abholen und einen geräteweiten Medien-Index
füllen — ohne in jedem Chat bis zum Anfang blättern zu müssen. Plan:
``docs/plans/2026-09-08-medien-nachziehen.md``.

Endpunkt
--------
* ``GET /meine-anhaenge?limit=&before=`` — eigene Uploads, newest-first,
  exklusiver Cursor ``before``, max. 100 je Seite.

Bewusste Grenze: der Server liefert nur, was er sehen darf. Bei
E2EE-Anhängen sind ``filename``/``mime``/``width``/``height`` in der Zeile
NULL (leben im verschlüsselten Umschlag) — Namen ergänzt der Klient aus
seinem lokalen Verlauf. Keine vorsignierten URLs: Bytes bleiben hinter
den bestehenden Abruf-Routen mit deren Rechteprüfungen.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, field_serializer
from sqlalchemy import select

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import MessageAttachment
from dcc_chat_gateway.ratelimit import check as ratelimit_check
from dcc_chat_gateway.schemas import _id_str
from dcc_chat_gateway.security import CurrentUser

router = APIRouter(tags=["anhaenge"])


class AnhangMetadaten(BaseModel):
    id: int
    channel_id: int
    #: NULL bei verschlüsselten Anhängen — der Name lebt im Umschlag.
    filename: str | None
    mime: str | None
    width: int | None
    height: int | None
    size: int
    hat_thumb: bool
    thumb_width: int | None
    thumb_height: int | None
    erstellt_am: datetime
    verschluesselt: bool
    #: True, sobald die Bytes im eigenen Cloud-Laufwerk liegen (§11.1) —
    #: der Objektspeicher antwortet dann 410, der Klient liest lokal.
    laufwerk_verteilt: bool

    #: Snowflakes als Strings — wie bei jedem anderen Out-Schema
    #: (``AttachmentOut`` & Co.): als JSON-Number verlöre JS jenseits von
    #: 2^53 still Bits, und der Klient braucht die id exakt (Cursor und
    #: Primärschlüssel seines Medien-Index).
    @field_serializer("id", "channel_id")
    def _ser_ids(self, v: int) -> str:
        return _id_str(v)


def _serialize(a: MessageAttachment) -> AnhangMetadaten:
    return AnhangMetadaten(
        id=a.id,
        channel_id=a.channel_id,
        filename=a.filename,
        mime=a.mime,
        width=a.width,
        height=a.height,
        size=a.size,
        hat_thumb=a.thumb_storage_key is not None,
        thumb_width=a.thumb_width,
        thumb_height=a.thumb_height,
        erstellt_am=a.created_at,
        verschluesselt=a.filename is None and a.mime is None,
        laufwerk_verteilt=a.laufwerk_verteilt_am is not None,
    )


@router.get("/meine-anhaenge", response_model=list[AnhangMetadaten])
async def meine_anhaenge(
    session: SessionDep,
    current: CurrentUser,
    before: Annotated[int | None, Query(ge=0)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
) -> list[Any]:
    """Eigene Anhang-Metadaten, newest-first, seitenweise (Stufe A1)."""
    if not ratelimit_check("attach", current.id):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limit exceeded"
        )
    stmt = select(MessageAttachment).where(
        MessageAttachment.uploader_id == current.id,
        MessageAttachment.deleted_at.is_(None),
        # Nur Zustellbares: pendente Uploads (Reaper-Gebiet) und nie
        # eingelieferte Hüllen bleiben außen — dieselbe Linie wie im Plan.
        (
            (MessageAttachment.message_id.is_not(None))
            | (MessageAttachment.postfach_gebunden_am.is_not(None))
        ),
    )
    if before is not None:
        stmt = stmt.where(MessageAttachment.id < before)  # exklusiver Cursor
    stmt = stmt.order_by(MessageAttachment.id.desc()).limit(limit)
    rows = (await session.execute(stmt)).scalars().all()
    return [_serialize(a) for a in rows]
