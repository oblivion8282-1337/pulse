"""Dropbox upload pipeline: presigned-PUT mint + finish-upload handshake.

Why a separate router?
- Files on the upload path can be many MB; HEAD-on-finish keeps the
  common CRUD endpoints in ``routes/dropbox.py`` lightweight.
- The MinIO-HEAD → DB-COMMIT ordering matters for crash-recovery; this
  module owns that ordering rule.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, HTTPException, Path, Request, status
from sqlalchemy import select

from dcc_chat_gateway import s3
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import (
    DROPBOX_KIND_FILE,
    Channel,
    DropboxConfig,
    DropboxFile,
)
from dcc_chat_gateway.routes._deps import require_member
from dcc_chat_gateway.routes._dropbox_helpers import (
    bump_used,
    fresh_entry_id,
    normalize_parent_path,
    publish_entry_event,
    publish_quota_event,
    storage_path_for,
    utc_now,
    validate_name,
)
from dcc_chat_gateway.routes._dropbox_schemas import (
    DropboxEntryOut,
    DropboxFinishUploadIn,
    DropboxUploadUrlIn,
    DropboxUploadUrlOut,
)
from dcc_chat_gateway.security import CurrentUser

router = APIRouter(tags=["dropbox"])


async def _resolve_channel(session, guild_id: int) -> Channel | None:
    stmt = select(Channel).where(
        Channel.guild_id == guild_id,
        Channel.type == 2,  # CHANNEL_TYPE_DROPBOX — avoid the cross-import
    )
    return (await session.execute(stmt)).scalars().first()


@router.post(
    "/guilds/{guild_id}/dropbox/upload-url",
    response_model=DropboxUploadUrlOut,
)
async def mint_upload_url(
    guild_id: Annotated[int, Path(ge=1)],
    payload: DropboxUploadUrlIn,
    session: SessionDep,
    current: CurrentUser,
) -> DropboxUploadUrlOut:
    """Mint a presigned PUT URL + a reserved snowflake id for the file.

    Side-effect-free in the DB — we only hand the client an id and a
    URL. The actual row lands when ``POST /finish-upload`` confirms the
    PUT succeeded. Keeps abandoned uploads cheap to GC."""

    await require_member(session, guild_id, current.id)
    cfg = await session.get(DropboxConfig, guild_id)
    if cfg is None:
        cfg = DropboxConfig(guild_id=guild_id)
        session.add(cfg)
        await session.flush()
    if not cfg.enabled:
        raise HTTPException(404, detail="dropbox disabled for this guild")

    parent = normalize_parent_path(payload.parent_path)
    name = validate_name(payload.name)

    if payload.size_bytes > cfg.per_file_max_bytes:
        raise HTTPException(
            413,
            detail=(
                f"file too large ({payload.size_bytes} > "
                f"{cfg.per_file_max_bytes} bytes cap)"
            ),
        )
    if cfg.used_bytes + payload.size_bytes > cfg.total_quota_bytes:
        raise HTTPException(
            413,
            detail="not enough free space in this community's dropbox",
        )

    clash = await session.execute(
        select(DropboxFile.id).where(
            DropboxFile.guild_id == guild_id,
            DropboxFile.parent_path == parent,
            DropboxFile.name == name,
            DropboxFile.deleted_at.is_(None),
        )
    )
    if clash.scalar_one_or_none() is not None:
        raise HTTPException(409, detail=f"'{name}' already exists at this path")

    new_id = fresh_entry_id()
    storage_key = storage_path_for(guild_id, parent, name)
    upload_url = await s3.presigned_put_url(
        storage_key,
        content_type=payload.content_type,
        content_length=payload.size_bytes,
    )

    # No DB row is created here — the row arrives via /finish-upload.
    # We don't commit; this method is side-effect-free until you
    # mutate the session, and we don't.
    return DropboxUploadUrlOut(
        id=new_id,
        upload_url=upload_url,
        storage_key=storage_key,
    )


@router.post(
    "/guilds/{guild_id}/dropbox/finish-upload",
    response_model=DropboxEntryOut,
)
async def finish_upload(
    guild_id: Annotated[int, Path(ge=1)],
    payload: DropboxFinishUploadIn,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
) -> DropboxEntryOut:
    """Confirm the PUT completed and persist the row.

    The client echoes back the upload context (parent + name + size +
    content_type) so we don't need server-side state between mint and
    finish. We HEAD the object to confirm a) it exists and b) the size
    matches what the client declared (the pre-signed URL pinned both,
    so a mismatch here means tampering)."""

    await require_member(session, guild_id, current.id)
    cfg = await session.get(DropboxConfig, guild_id)
    if cfg is None or not cfg.enabled:
        raise HTTPException(404, detail="dropbox disabled for this guild")

    parent = normalize_parent_path(payload.parent_path)
    name = validate_name(payload.name)

    # Head-check on MinIO before we write to PG; if the PUT never landed
    # the client retried with a stale id, we tell it now instead of
    # leaving an orphan row.
    storage_key = storage_path_for(guild_id, parent, name)
    head = await s3.head_object(storage_key)
    actual_size = int(head.get("ContentLength") or 0)
    if actual_size <= 0:
        raise HTTPException(409, detail="uploaded object is empty")
    if actual_size > cfg.per_file_max_bytes:
        # Should not happen (the presigned URL capped the size) but
        # belt-and-braces against a tampered request that bypassed the
        # URL signing.
        await s3.delete_object(storage_key)
        raise HTTPException(
            413,
            detail=(
                f"object size ({actual_size}) exceeds per-file cap "
                f"({cfg.per_file_max_bytes})"
            ),
        )
    if cfg.used_bytes + actual_size > cfg.total_quota_bytes:
        await s3.delete_object(storage_key)
        raise HTTPException(
            413,
            detail="not enough free space in this community's dropbox",
        )

    channel = await _resolve_channel(session, guild_id)
    if channel is None:
        # Channel was deleted between mint and finish — make it lazy.
        channel = Channel(
            id=fresh_entry_id(),
            guild_id=guild_id,
            name="ablage",
            type=2,
            position=0,
        )
        session.add(channel)
        await session.flush()

    entry = DropboxFile(
        id=payload.id,
        guild_id=guild_id,
        channel_id=channel.id,
        parent_path=parent,
        name=name,
        kind=DROPBOX_KIND_FILE,
        size_bytes=actual_size,
        content_type=payload.content_type or head.get("ContentType"),
        storage_key=storage_key,
        version=1,
        uploaded_by_id=current.id,
        uploaded_at=utc_now(),
        updated_at=utc_now(),
        pinned=False,
    )
    session.add(entry)
    bump_used(cfg, +actual_size)
    await session.commit()
    await session.refresh(entry)

    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is not None:
        await publish_entry_event(
            mgr,
            kind="created",
            guild_id=guild_id,
            entry=entry,
        )
        await publish_quota_event(mgr, cfg)

    # Sign a fresh GET URL (the entry serializer does the same — kept
    # inline here so the response carries a usable url without a
    # second roundtrip).
    try:
        url = await s3.presigned_get_url(entry.storage_key, inline=True)
    except Exception:  # noqa: BLE001
        url = None
    return DropboxEntryOut(
        id=entry.id,
        guild_id=entry.guild_id,
        channel_id=entry.channel_id,
        parent_path=entry.parent_path,
        name=entry.name,
        kind=entry.kind,
        size_bytes=entry.size_bytes,
        content_type=entry.content_type,
        version=entry.version,
        uploaded_by_id=entry.uploaded_by_id,
        uploaded_at=entry.uploaded_at,
        updated_at=entry.updated_at,
        pinned=bool(entry.pinned),
        url=url,
    )
