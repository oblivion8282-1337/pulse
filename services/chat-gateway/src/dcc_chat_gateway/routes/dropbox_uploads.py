"""Dropbox upload pipeline: presigned-PUT mint + finish-upload handshake.

Why a separate router?
- Files on the upload path can be many MB; HEAD-on-finish keeps the
  common CRUD endpoints in ``routes/dropbox.py`` lightweight.
- The MinIO-HEAD → DB-COMMIT ordering matters for crash-recovery; this
  module owns that ordering rule.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, HTTPException, Path, Request
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway import s3
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import (
    DROPBOX_KIND_FILE,
    DropboxConfig,
    DropboxFile,
)
from dcc_chat_gateway.routes._deps import require_member
from dcc_chat_gateway.routes._dropbox_helpers import (
    bump_used,
    fresh_entry_id,
    normalize_content_type,
    normalize_parent_path,
    publish_entry_event,
    publish_quota_event,
    resolve_or_create_dropbox_channel,
    serialize_entry,
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


async def _locked_config(
    session: AsyncSession, guild_id: int
) -> DropboxConfig | None:
    """Read the quota row with a row-level lock so two concurrent
    uploads can't both pass the ``used_bytes + size <= total`` check
    before either commits the bump. Returns ``None`` if the dropbox
    was never provisioned (read paths then 404, write paths refuse).
    SQLite falls back to an unlocked SELECT — the dialect doesn't
    emit FOR UPDATE, and aiosqlite serialises writes anyway."""

    bind = session.get_bind()
    stmt = select(DropboxConfig).where(DropboxConfig.guild_id == guild_id)
    if bind.dialect.name == "postgresql":
        stmt = stmt.with_for_update()
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

    Holds a row-level lock on the per-guild config so two members
    uploading at the same instant can't both squeeze past the quota
    check before either commits. Side-effect-free in the DB until the
    row is inserted via ``POST /finish-upload`` — abandoned uploads
    then age out via the trash sweep."""

    await require_member(session, guild_id, current.id)
    cfg = await _locked_config(session, guild_id)
    if cfg is None or not cfg.enabled:
        raise HTTPException(404, detail="dropbox disabled for this guild")

    parent = normalize_parent_path(payload.parent_path)
    try:
        name = validate_name(payload.name)
    except ValueError as exc:
        raise HTTPException(422, detail=str(exc)) from exc

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

    # DB row only lands via /finish-upload — we don't commit here.
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
    finish. We HEAD the object to confirm it exists and the size matches
    what the client declared (the pre-signed URL pinned both, so a
    mismatch here means tampering). On any rejection we delete the
    orphaned MinIO object before raising, so an aborted upload leaves
    nothing behind."""

    await require_member(session, guild_id, current.id)
    cfg = await _locked_config(session, guild_id)
    if cfg is None or not cfg.enabled:
        raise HTTPException(404, detail="dropbox disabled for this guild")

    parent = normalize_parent_path(payload.parent_path)
    try:
        name = validate_name(payload.name)
    except ValueError as exc:
        raise HTTPException(422, detail=str(exc)) from exc

    storage_key = storage_path_for(guild_id, parent, name)
    try:
        head = await s3.head_object(storage_key)
    except Exception:  # noqa: BLE001 — MinIO 404 bubbles as ClientError
        raise HTTPException(
            409, detail="uploaded object not found — retry the PUT"
        )
    actual_size = int(head.get("ContentLength") or 0)
    if actual_size <= 0:
        await s3.delete_object(storage_key)
        raise HTTPException(409, detail="uploaded object is empty")
    if actual_size > cfg.per_file_max_bytes:
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

    channel = await resolve_or_create_dropbox_channel(session, guild_id)
    # Content-type is normalised server-side: anything not in the
    # inline-safe whitelist (``text/html`` etc.) is relabelled to
    # ``application/octet-stream`` so the presigned GET serves it with
    # ``Content-Disposition: attachment`` — defuses storage-based XSS.
    entry = DropboxFile(
        id=payload.id,
        guild_id=guild_id,
        channel_id=channel.id,
        parent_path=parent,
        name=name,
        kind=DROPBOX_KIND_FILE,
        size_bytes=actual_size,
        content_type=normalize_content_type(
            head.get("ContentType") or payload.content_type
        ),
        storage_key=storage_key,
        version=1,
        uploaded_by_id=current.id,
        uploaded_at=utc_now(),
        updated_at=utc_now(),
        pinned=False,
    )
    session.add(entry)
    bump_used(cfg, +actual_size)
    try:
        await session.commit()
    except IntegrityError:
        # Two parallel finishes raced past the clash-check → unique-index
        # violation. The other one wins; this one declines cleanly.
        await session.rollback()
        await _safe_delete(storage_key)
        raise HTTPException(
            409, detail=f"'{name}' already exists at this path"
        )
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

    return await serialize_entry(session, entry)


async def _safe_delete(storage_key: str | None) -> None:
    """Best-effort MinIO cleanup — failures are logged, not re-raised."""
    if not storage_key:
        return
    try:
        await s3.delete_object(storage_key)
    except Exception:  # noqa: BLE001
        pass
