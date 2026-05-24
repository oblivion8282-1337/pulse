"""Per-guild sound-override CRUD.

Every guild may override any of the 13 bundled sounds (see
``dcc_chat_gateway.sounds.VALID_SOUND_IDS``). The binary lives in
MinIO; the DB row carries metadata. Reads are gated on guild
membership; writes on the MANAGE_GUILD permission bit. The Pulse
instance admin caps per-file size via ``chat_settings.guild_sound_max_size_bytes``
(read on every PUT so a tightened limit takes effect without a
service restart).

On every mutation we publish ``guild_sound_updated`` on guild:events
so connected members can re-fetch the affected sound's URL.
"""

from __future__ import annotations

from datetime import datetime, timezone

import structlog
from fastapi import APIRouter, HTTPException, Request, UploadFile, status
from sqlalchemy import select

from dcc_chat_gateway import s3
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import ChatSettings, Guild, GuildSoundOverride
from dcc_chat_gateway.permissions import Permissions, check_permission
from dcc_chat_gateway.routes._deps import require_member
from dcc_chat_gateway.schemas import GuildSoundOverrideOut
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.sounds import (
    ALLOWED_CONTENT_TYPES,
    VALID_SOUND_IDS,
    storage_key,
)
from dcc_shared.events import GuildSoundUpdatedEvent

log = structlog.get_logger(__name__)
router = APIRouter()


_DEFAULT_MAX_BYTES = 524_288  # mirrors the migration default


def _validate_sound_id(sound_id: str) -> None:
    if sound_id not in VALID_SOUND_IDS:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail=f"unknown sound_id: {sound_id}",
        )


async def _max_bytes(session) -> int:
    """Read the current Pulse-admin-set per-file cap. Falls back to the
    migration default if the singleton row is somehow missing — keeps
    uploads working through a partial-migration window instead of 500-ing."""
    row = await session.get(ChatSettings, 1)
    if row is None:
        return _DEFAULT_MAX_BYTES
    return int(row.guild_sound_max_size_bytes)


async def _serialize(row: GuildSoundOverride) -> GuildSoundOverrideOut:
    url = await s3.presigned_get_url(row.storage_key)
    return GuildSoundOverrideOut(
        sound_id=row.sound_id,
        url=url,
        content_type=row.content_type,
        file_size=row.file_size,
        original_filename=row.original_filename,
        uploaded_by_id=row.uploaded_by_id,
        uploaded_at=row.uploaded_at,
    )


async def _publish_sound_event(
    request: Request, guild_id: int, sound_id: str, *, removed: bool
) -> None:
    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is None:
        return
    await mgr.publish_guild_event(
        GuildSoundUpdatedEvent(
            guild_id=str(guild_id),
            sound_id=sound_id,
            removed=removed,
        )
    )


@router.get(
    "/guilds/{guild_id}/sounds",
    response_model=list[GuildSoundOverrideOut],
)
async def list_sounds(
    guild_id: int,
    session: SessionDep,
    current: CurrentUser,
) -> list[GuildSoundOverrideOut]:
    guild = await session.get(Guild, guild_id)
    if guild is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="guild not found")
    await require_member(session, guild_id, current.id)

    rows = list(
        (
            await session.execute(
                select(GuildSoundOverride).where(
                    GuildSoundOverride.guild_id == guild_id
                )
            )
        ).scalars()
    )
    return [await _serialize(r) for r in rows]


@router.put(
    "/guilds/{guild_id}/sounds/{sound_id}",
    response_model=GuildSoundOverrideOut,
)
async def upload_sound(
    guild_id: int,
    sound_id: str,
    file: UploadFile,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
) -> GuildSoundOverrideOut:
    _validate_sound_id(sound_id)

    guild = await session.get(Guild, guild_id)
    if guild is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="guild not found")
    await check_permission(
        session,
        current,
        guild_id,
        Permissions.MANAGE_GUILD,
        detail="missing permission: MANAGE_GUILD",
    )

    if file.content_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="unsupported content-type (allowed: audio/ogg, audio/mpeg)",
        )

    max_bytes = await _max_bytes(session)
    # Read one byte past the cap to distinguish exact-fit from oversized.
    raw = await file.read(max_bytes + 1)
    if len(raw) > max_bytes:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail=f"file too large (max {max_bytes} bytes)",
        )
    if not raw:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, detail="empty file"
        )

    key = storage_key(guild_id, sound_id)
    await s3.put_object(key, body=raw, content_type=file.content_type)

    existing = await session.get(GuildSoundOverride, (guild_id, sound_id))
    if existing is None:
        existing = GuildSoundOverride(
            guild_id=guild_id,
            sound_id=sound_id,
            storage_key=key,
            content_type=file.content_type,
            file_size=len(raw),
            original_filename=file.filename or sound_id,
            uploaded_by_id=current.id,
        )
        session.add(existing)
    else:
        existing.storage_key = key
        existing.content_type = file.content_type
        existing.file_size = len(raw)
        existing.original_filename = file.filename or sound_id
        existing.uploaded_by_id = current.id
        # Bumped manually so the admin UI shows when *this* upload happened
        # — DB onupdate would fire on any UPDATE, including no-op resaves.
        existing.uploaded_at = datetime.now(timezone.utc)

    await session.commit()
    await session.refresh(existing)

    await _publish_sound_event(request, guild_id, sound_id, removed=False)
    log.info(
        "guild_sound_uploaded",
        guild_id=guild_id,
        sound_id=sound_id,
        user_id=current.id,
        bytes=len(raw),
    )
    return await _serialize(existing)


@router.delete(
    "/guilds/{guild_id}/sounds/{sound_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_sound(
    guild_id: int,
    sound_id: str,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
) -> None:
    _validate_sound_id(sound_id)

    guild = await session.get(Guild, guild_id)
    if guild is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="guild not found")
    await check_permission(
        session,
        current,
        guild_id,
        Permissions.MANAGE_GUILD,
        detail="missing permission: MANAGE_GUILD",
    )

    existing = await session.get(GuildSoundOverride, (guild_id, sound_id))
    if existing is None:
        return

    key = existing.storage_key
    await session.delete(existing)
    await session.commit()

    # MinIO delete after the DB commit so an S3-side failure doesn't leave
    # a dangling row pointing at non-existent storage. Reverse order (S3
    # first) would risk dangling rows on partial failures.
    try:
        await s3.delete_object(key)
    except Exception:  # noqa: BLE001
        log.warning(
            "guild_sound_minio_delete_failed",
            guild_id=guild_id,
            sound_id=sound_id,
            storage_key=key,
        )

    await _publish_sound_event(request, guild_id, sound_id, removed=True)
    log.info(
        "guild_sound_deleted",
        guild_id=guild_id,
        sound_id=sound_id,
        user_id=current.id,
    )
