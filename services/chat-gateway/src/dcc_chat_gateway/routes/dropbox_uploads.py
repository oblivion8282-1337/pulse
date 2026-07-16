"""Dropbox upload pipeline: presigned-PUT mint + finish-upload handshake.

Why a separate router?
- Files on the upload path can be many MB; HEAD-on-finish keeps the
  common CRUD endpoints in ``routes/dropbox.py`` lightweight.
- The MinIO-HEAD → DB-COMMIT ordering matters for crash-recovery; this
  module owns that ordering rule.

Anti-attribution invariant
--------------------------
Every ``mint_upload_url`` call INSERTs a ``dropbox_pending_uploads``
row that ties the reserved Snowflake id to the calling user. The
row carries ``uploader_id``, ``guild_id``, ``parent_path``, ``name``
and ``size_bytes`` — i.e. exactly what the client declared. A
``finish_upload`` call only commits a ``DropboxFile`` row when:

  1. the id matches a non-expired pending row,
  2. ``uploader_id == current.id`` (member A cannot finish a
     upload minted by member B — closes the quota-theft + audit-
     trail-spoof vector),
  3. the parent_path / name / size_bytes the client echoes back
     match the pending row (prevents a tampered request from
     "rerouting" the pending PUT to a different destination).

The pending row is DELETEd in the same transaction as the file
INSERT so a successful finish leaves no trace. Orphan rows
(expired mints that never finished) are reaped by the sweep.

Quota-race hardening
--------------------
``_locked_config`` opts into ``SELECT ... FOR UPDATE`` on Postgres
(no-op on SQLite). Both routes wrap the read-then-bump critical
section in ``_with_quota_lock`` — a per-guild ``asyncio.Lock``
that's redundant on Postgres (the row lock is authoritative) but
bridges the SQLite reader/writer gap. Process-local; doesn't
share across worker processes (in prod those run on Postgres
where the DB lock is enough).
"""

from __future__ import annotations

import asyncio
import contextlib
from datetime import timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, HTTPException, Path, Request
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway import ratelimit, s3
from dcc_chat_gateway.config import get_settings
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import (
    DROPBOX_KIND_FILE,
    DropboxConfig,
    DropboxFile,
    DropboxPendingUpload,
)
from dcc_chat_gateway.routes._deps import require_member
from dcc_chat_gateway.routes._dropbox_helpers import (
    bump_used,
    fresh_entry_id,
    locked_config,
    normalize_content_type,
    normalize_parent_path,
    publish_entry_event,
    publish_quota_event,
    resolve_or_create_dropbox_channel,
    serialize_entry,
    storage_path_for,
    utc_now,
    validate_name,
    with_quota_lock,
)
from dcc_chat_gateway.routes._dropbox_schemas import (
    DropboxEntryOut,
    DropboxFinishUploadIn,
    DropboxUploadUrlIn,
    DropboxUploadUrlOut,
)
from dcc_chat_gateway.security import CurrentUser

router = APIRouter(tags=["dropbox"])


# Process-local per-guild locks + locked-config helper live in
# ``_dropbox_helpers`` so every quota-mutating route (mint / finish /
# delete / restore / settings-patch) shares the same locking primitives.


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
    """Mint a presigned PUT URL + a reserved Snowflake id, AND register
    the upload in ``dropbox_pending_uploads`` so a later ``finish``
    call can verify the minter.

    Holds the per-guild quota lock for the full mint path so two
    parallel mints can't both squeeze past the quota check before
    either commits."""

    await require_member(session, guild_id, current.id)
    if not ratelimit.check("dropbox_mint", current.id):
        raise HTTPException(
            429, detail="too many upload-url mints — slow down"
        )
    async with with_quota_lock(guild_id):
        cfg = await locked_config(session, guild_id)
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
        storage_key = storage_path_for(guild_id, new_id)

        # Bind the reserved id to this minter + the declared upload
        # context. finish_upload refuses any call that doesn't match
        # this row, so a leaked id is unusable by another member.
        settings = get_settings()
        pending = DropboxPendingUpload(
            id=new_id,
            uploader_id=current.id,
            guild_id=guild_id,
            parent_path=parent,
            name=name,
            size_bytes=payload.size_bytes,
            expires_at=utc_now() + timedelta(seconds=settings.s3_presigned_ttl_seconds),
        )
        session.add(pending)
        try:
            await session.commit()
        except IntegrityError:
            # Snowflake collision — vanishingly rare with a 42-bit ms
            # base, but the failure mode is "try again with a fresh id".
            await session.rollback()
            raise HTTPException(
                409, detail="id collision — mint again"
            )

        upload_url = await s3.presigned_put_url(
            storage_key,
            content_type=payload.content_type,
            content_length=payload.size_bytes,
        )
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
    finish — but we do verify the declared context matches the
    pending row (which was bound to the *original* minter at mint
    time). Tampered finishes (different parent/name/size) and
    cross-user finishes (member B trying to finish A's mint) are
    both refused at the pending-row lookup."""

    await require_member(session, guild_id, current.id)
    if not ratelimit.check("dropbox_finish", current.id):
        raise HTTPException(
            429, detail="too many finish-upload calls — slow down"
        )
    # Hold the per-guild application lock for the whole finish
    # path. Two parallel finishes can't both pass the
    # ``used + size <= total`` gate and double-bump — the
    # Postgres ``FOR UPDATE`` is belt-and-braces on top.
    async with with_quota_lock(guild_id):
        return await _finish_upload_locked(
            guild_id, payload, session, current, request
        )


async def _finish_upload_locked(
    guild_id: int,
    payload: DropboxFinishUploadIn,
    session: AsyncSession,
    current: CurrentUser,
    request: Request,
) -> DropboxEntryOut:
    """Finish-upload body, executed under the per-guild quota lock.
    Split into its own function so the lock-acquire / lock-release
    boundary is unambiguous."""

    cfg = await locked_config(session, guild_id)
    if cfg is None or not cfg.enabled:
        raise HTTPException(404, detail="dropbox disabled for this guild")

    parent = normalize_parent_path(payload.parent_path)
    try:
        name = validate_name(payload.name)
    except ValueError as exc:
        raise HTTPException(422, detail=str(exc)) from exc

    # The pending row is the source of truth for who is allowed to
    # finish, and with what declared context. Read it first; refuse
    # anything that doesn't match.
    pending = (
        await session.execute(
            select(DropboxPendingUpload).where(
                DropboxPendingUpload.id == payload.id
            )
        )
    ).scalars().first()
    if pending is None:
        raise HTTPException(
            409, detail="upload not found — mint again"
        )
    # Re-read the row so external writes (e.g. a test that backdates
    # ``expires_at``) are visible — without this, the cached identity-
    # map copy can show the original 10-min-out value and falsely
    # pass the expiry check.
    await session.refresh(pending)
    now = utc_now()
    # ``expires_at`` round-trips through SQLAlchemy/SQLite without
    # tz info on the SQLite path even though the column declares
    # ``DateTime(timezone=True)``. Promote to UTC-aware before the
    # compare so we don't crash on the naive/aware mix and so the
    # comparison is semantically right regardless of dialect.
    expires_at = (
        pending.expires_at.replace(tzinfo=timezone.utc)
        if pending.expires_at.tzinfo is None
        else pending.expires_at
    )
    if expires_at < now:
        raise HTTPException(
            409, detail="upload expired — mint again"
        )
    if pending.uploader_id != current.id:
        # Member B trying to finish A's mint. Without this check B
        # would consume A's bytes against B's quota + set
        # uploaded_by_id=B, corrupting both the audit trail and the
        # per-user quota accounting.
        raise HTTPException(
            403, detail="upload was minted by another user"
        )
    if pending.parent_path != parent or pending.name != name:
        raise HTTPException(
            409,
            detail=(
                "parent/name mismatch — declared upload context "
                "must match the mint"
            ),
        )
    if pending.size_bytes != payload.size_bytes:
        raise HTTPException(
            409, detail="size mismatch with the mint"
        )

    storage_key = storage_path_for(guild_id, pending.id)
    try:
        head = await s3.head_object(storage_key)
    except Exception:  # noqa: BLE001 — MinIO 404 bubbles as ClientError
        # Clean up the pending row so the orphan sweep doesn't keep
        # retrying forever; the user's next mint will issue a fresh
        # presigned URL.
        await session.delete(pending)
        await session.commit()
        raise HTTPException(
            409, detail="uploaded object not found — retry the PUT"
        )
    actual_size = int(head.get("ContentLength") or 0)
    if actual_size <= 0:
        await s3.delete_object(storage_key)
        await session.delete(pending)
        await session.commit()
        raise HTTPException(409, detail="uploaded object is empty")
    if actual_size > cfg.per_file_max_bytes:
        await s3.delete_object(storage_key)
        await session.delete(pending)
        await session.commit()
        raise HTTPException(
            413,
            detail=(
                f"object size ({actual_size}) exceeds per-file cap "
                f"({cfg.per_file_max_bytes})"
            ),
        )
    if cfg.used_bytes + actual_size > cfg.total_quota_bytes:
        await s3.delete_object(storage_key)
        await session.delete(pending)
        await session.commit()
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
        uploaded_by_id=pending.uploader_id,
        uploaded_at=now,
        updated_at=now,
        pinned=False,
    )
    session.add(entry)
    bump_used(cfg, +actual_size)
    await session.delete(pending)
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