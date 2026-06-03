"""Two-phase attachment upload + MinIO signing.

Flow per design (PLAN.md / user-facing spec):

  1. Client picks files. For images, generates client-side thumbnails.
  2. POST /channels/{id}/attachments/upload-url with {filename, mime, size,
     has_thumb?, thumb_size?, …}.
  3. Server:
       - validates the user can write in this channel,
       - checks the size/count limits (per-guild for guild channels, the
         singleton chat_settings for DMs),
       - creates a pending MessageAttachment row (message_id=NULL),
       - hands out a presigned PUT URL (+ a second one for the thumbnail).
  4. Client PUTs the bytes directly to MinIO.
  5. Client POSTs /channels/{id}/messages with the new attachment_ids.
     ``messages.py`` calls ``bind_attachments`` from here, which checks
     ownership + channel + still-pending, then bumps message_id.

The same module hosts the download-url re-sign endpoint (client falls
back here when an existing presigned URL 403s after TTL), the helpers
``bind_attachments`` / ``serialize_attachments`` / ``hard_delete_attachments``
that messages.py uses, and the orphan reaper task.
"""

from __future__ import annotations

import asyncio
import logging
import re
import secrets
from datetime import UTC, datetime, timedelta
from typing import Annotated, Iterable

import structlog
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete as sa_delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway import ratelimit, s3
from dcc_chat_gateway.db import SessionDep, SessionLocal
from dcc_chat_gateway.models import ChatSettings, Guild, MessageAttachment
from dcc_chat_gateway.permissions import (
    Permissions,
    has_permission,
    resolve_permissions,
)
from dcc_chat_gateway.routes._deps import resolve_channel_or_raise
from dcc_chat_gateway.schemas import (
    AttachmentDownloadOut,
    AttachmentOut,
    AttachmentUploadIn,
    AttachmentUploadOut,
)
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id

log = structlog.get_logger(__name__)
router = APIRouter()

# ─── MIME allowlist ─────────────────────────────────────────────────────────
# Only safe MIME types that cannot be rendered as HTML by the browser are
# permitted.  text/html, application/javascript, text/css and similar are
# intentionally excluded to prevent stored-XSS via a crafted Content-Type on
# a presigned MinIO GET URL served from the same origin.

_ALLOWED_MIME_RE = re.compile(
    r"^(?:"
    r"image/(jpeg|png|gif|webp|svg\+xml|bmp|tiff|x-icon|avif|heic|heif)"
    r"|video/(mp4|webm|ogg|quicktime|x-msvideo|x-matroska|3gpp)"
    r"|audio/(mpeg|ogg|wav|webm|aac|flac|x-flac|mp4|opus)"
    r"|application/pdf"
    r"|application/zip"
    r"|application/(x-)?7z-compressed"
    r"|application/x-tar"
    r"|application/(x-)?rar-compressed"
    r"|application/gzip"
    r"|application/octet-stream"
    r"|text/plain"
    r")$"
)


def _validate_mime(mime: str) -> None:
    """Raise 400 if the MIME type is not on the safe allowlist."""
    if not _ALLOWED_MIME_RE.match(mime):
        raise HTTPException(400, detail=f"unsupported mime type: {mime!r}")


# ─── Limit lookup ───────────────────────────────────────────────────────────


async def _limits_for_channel(
    session: AsyncSession, *, kind: str, ch: Guild | object
) -> tuple[int, int]:
    """Return ``(max_size_bytes, max_count_per_message)`` for either a
    guild Channel (use the Guild row's columns) or a DM channel (use the
    chat_settings singleton)."""
    if kind == "guild":
        guild = await session.get(Guild, ch.guild_id)
        if guild is None:
            raise HTTPException(404, detail="guild not found")
        return guild.attachment_max_size_bytes, guild.attachment_max_count_per_message
    # DM
    settings = await session.get(ChatSettings, 1)
    if settings is None:
        # Should be seeded by migration 0006; fall back to safe defaults.
        return 26214400, 4
    return (
        settings.dm_attachment_max_size_bytes,
        settings.dm_attachment_max_count_per_message,
    )


def _storage_key(prefix: str, channel_id: int, attachment_id: int) -> str:
    """Unguessable key: prefix/<cid>/<aid>-<random>. Defence in depth — even
    with our auth-gated download-url endpoint, a leaked direct MinIO link
    would still need to know this random component."""
    return f"{prefix}/{channel_id}/{attachment_id}-{secrets.token_urlsafe(12)}"


# ─── Upload-URL endpoint ────────────────────────────────────────────────────


@router.post(
    "/channels/{channel_id}/attachments/upload-url",
    response_model=AttachmentUploadOut,
    status_code=201,
)
async def create_upload_url(
    channel_id: int,
    payload: AttachmentUploadIn,
    session: SessionDep,
    current: CurrentUser,
):
    if not ratelimit.check("attach", current.id):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limit exceeded"
        )
    _validate_mime(payload.mime)
    kind, ch = await resolve_channel_or_raise(session, channel_id, current.id)
    # ATTACH_FILES gate (guild channels only — DMs have no permission overlay).
    if kind == "guild":
        perms = await resolve_permissions(
            session, current, ch.guild_id, channel_id=channel_id
        )
        if not has_permission(perms, Permissions.ATTACH_FILES):
            raise HTTPException(403, detail="missing permission: ATTACH_FILES")
    max_size, _max_count = await _limits_for_channel(session, kind=kind, ch=ch)

    if payload.size > max_size:
        raise HTTPException(
            status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"file too large ({payload.size} > {max_size} bytes)",
        )

    # Count-limit is enforced on the *message* side at POST /messages, not
    # here — clients can upload more files than they'll send (e.g. dragged
    # five, drops one before sending). The reaper cleans up the leftovers.

    aid = next_id()
    storage_key = _storage_key("att", channel_id, aid)
    thumb_key: str | None = None
    if payload.has_thumb:
        if payload.thumb_size is None:
            raise HTTPException(400, detail="thumb_size required when has_thumb=true")
        if payload.thumb_size > max_size:
            raise HTTPException(413, detail="thumbnail too large")
        thumb_key = _storage_key("thumb", channel_id, aid)

    row = MessageAttachment(
        id=aid,
        message_id=None,
        channel_id=channel_id,
        uploader_id=current.id,
        filename=payload.filename,
        storage_key=storage_key,
        mime=payload.mime,
        size=payload.size,
        width=payload.width,
        height=payload.height,
        thumb_storage_key=thumb_key,
        thumb_width=payload.thumb_width,
        thumb_height=payload.thumb_height,
    )
    session.add(row)
    await session.commit()

    upload_url = await s3.presigned_put_url(
        storage_key, content_type=payload.mime, content_length=payload.size
    )
    thumb_upload_url: str | None = None
    if thumb_key is not None:
        thumb_upload_url = await s3.presigned_put_url(
            thumb_key,
            content_type="image/webp",  # client always emits webp thumbs
            content_length=payload.thumb_size,
        )

    return AttachmentUploadOut(
        id=aid, upload_url=upload_url, thumb_upload_url=thumb_upload_url
    )


# ─── Download-URL re-sign endpoint ─────────────────────────────────────────


@router.get(
    "/attachments/{attachment_id}/download-url",
    response_model=AttachmentDownloadOut,
)
async def refresh_download_url(
    attachment_id: int, session: SessionDep, current: CurrentUser
):
    """Client hits this when an existing presigned URL 403s post-TTL."""
    row = await session.get(MessageAttachment, attachment_id)
    if row is None or row.deleted_at is not None:
        raise HTTPException(404, detail="attachment not found")
    if row.message_id is None:
        # Pending row — only the uploader can re-sign it (no other user
        # could know the id anyway, but defense in depth).
        if row.uploader_id != current.id:
            raise HTTPException(404, detail="attachment not found")
    else:
        # Bound to a message: caller must have access to that channel.
        await resolve_channel_or_raise(session, row.channel_id, current.id)

    inline = _is_inline_mime(row.mime)
    url = await s3.presigned_get_url(
        row.storage_key, filename=row.filename, inline=inline
    )
    thumb_url: str | None = None
    if row.thumb_storage_key is not None:
        thumb_url = await s3.presigned_get_url(row.thumb_storage_key)
    return AttachmentDownloadOut(url=url, thumb_url=thumb_url)


_INLINE_PREFIXES = ("image/", "video/", "audio/")
_INLINE_EXACT = {"application/pdf"}


def _is_inline_mime(mime: str | None) -> bool:
    if not mime:
        return False
    if mime in _INLINE_EXACT:
        return True
    return any(mime.startswith(p) for p in _INLINE_PREFIXES)


# ─── Helpers used by messages.py ───────────────────────────────────────────


async def bind_attachments(
    session: AsyncSession,
    *,
    attachment_ids: list[int],
    message_id: int,
    channel_id: int,
    uploader_id: int,
) -> None:
    """Associate pending attachments with a newly-created message.

    Raises 400 if any id doesn't match (wrong user, wrong channel, already
    bound, deleted, or doesn't exist). Whole batch fails atomically — the
    session rolls back on the caller side.
    """
    if not attachment_ids:
        return
    rows = (
        await session.execute(
            select(MessageAttachment).where(MessageAttachment.id.in_(attachment_ids))
        )
    ).scalars().all()
    by_id = {r.id: r for r in rows}
    for aid in attachment_ids:
        r = by_id.get(aid)
        if r is None:
            raise HTTPException(400, detail=f"attachment {aid} not found")
        if r.deleted_at is not None:
            raise HTTPException(400, detail=f"attachment {aid} deleted")
        if r.uploader_id != uploader_id:
            raise HTTPException(400, detail=f"attachment {aid} not yours")
        if r.channel_id != channel_id:
            raise HTTPException(400, detail=f"attachment {aid} in wrong channel")
        if r.message_id is not None and r.message_id != message_id:
            raise HTTPException(400, detail=f"attachment {aid} already bound")
        r.message_id = message_id
    # caller commits


async def serialize_attachments(
    session: AsyncSession, message_ids: Iterable[int]
) -> dict[int, list[AttachmentOut]]:
    """Fetch attachments for ``message_ids`` + presign download URLs (in
    parallel). Returns ``{msg_id: [AttachmentOut, …]}``."""
    ids = list(message_ids)
    if not ids:
        return {}
    rows = (
        await session.execute(
            select(MessageAttachment).where(
                MessageAttachment.message_id.in_(ids),
                MessageAttachment.deleted_at.is_(None),
            )
        )
    ).scalars().all()
    if not rows:
        return {}

    # Sign all URLs concurrently. Each call is a no-roundtrip HMAC compute,
    # but the aiobotocore client-create has setup cost — gather to amortize.
    async def _make(row: MessageAttachment) -> tuple[int, AttachmentOut]:
        inline = _is_inline_mime(row.mime)
        url = await s3.presigned_get_url(
            row.storage_key, filename=row.filename, inline=inline
        )
        thumb_url = None
        if row.thumb_storage_key is not None:
            thumb_url = await s3.presigned_get_url(row.thumb_storage_key)
        return row.message_id, AttachmentOut(
            id=row.id,
            filename=row.filename,
            mime=row.mime,
            size=row.size,
            width=row.width,
            height=row.height,
            thumb_width=row.thumb_width,
            thumb_height=row.thumb_height,
            url=url,
            thumb_url=thumb_url,
        )

    results = await asyncio.gather(*[_make(r) for r in rows])
    out: dict[int, list[AttachmentOut]] = {}
    for mid, att in results:
        out.setdefault(mid, []).append(att)
    return out


async def hard_delete_attachments(
    session: AsyncSession, *, message_ids: Iterable[int] | None = None,
    attachment_ids: Iterable[int] | None = None,
) -> int:
    """Hard-delete attachment rows + their MinIO objects.

    Exactly one of ``message_ids`` / ``attachment_ids`` should be passed.
    MinIO failures are logged but don't roll back the DB delete — better
    a slightly-orphaned object than a half-stuck message.
    """
    stmt = select(MessageAttachment).where(MessageAttachment.deleted_at.is_(None))
    if message_ids is not None:
        ids = list(message_ids)
        if not ids:
            return 0
        stmt = stmt.where(MessageAttachment.message_id.in_(ids))
    elif attachment_ids is not None:
        ids = list(attachment_ids)
        if not ids:
            return 0
        stmt = stmt.where(MessageAttachment.id.in_(ids))
    else:
        raise ValueError("pass message_ids or attachment_ids")

    rows = (await session.execute(stmt)).scalars().all()
    if not rows:
        return 0

    # Delete MinIO objects in parallel; swallow failures.
    async def _drop(key: str) -> None:
        try:
            await s3.delete_object(key)
        except Exception:  # noqa: BLE001
            log.exception("s3 delete failed", key=key)

    keys: list[str] = []
    for r in rows:
        keys.append(r.storage_key)
        if r.thumb_storage_key:
            keys.append(r.thumb_storage_key)
    await asyncio.gather(*[_drop(k) for k in keys])

    now = datetime.now(UTC)
    await session.execute(
        update(MessageAttachment)
        .where(MessageAttachment.id.in_([r.id for r in rows]))
        .values(deleted_at=now)
    )
    return len(rows)


# ─── Reaper ────────────────────────────────────────────────────────────────


REAPER_INTERVAL_S = 600   # 10 min
ORPHAN_AGE_S = 3600       # 1 h


async def reaper_loop() -> None:
    """Periodically nuke pending attachments older than ORPHAN_AGE_S.

    Started from the chat-gateway lifespan. Errors log + sleep — never let
    a transient DB hiccup kill the task forever.
    """
    log.info("attachments reaper start", interval_s=REAPER_INTERVAL_S)
    while True:
        # Erst schlafen, dann reapen. So macht der Task in (kurzlebigen) Tests, die
        # den echten Lifespan starten, NIE eine DB-Iteration → kein Greenlet-/
        # Connection-Fehler (sqlalchemy e3q8), wenn das Test-Teardown die Engine
        # disposed während eine reap-Query läuft (CI-Flake, rutschte durch die
        # --reruns-Filter). In Produktion ist der Initial-Delay irrelevant:
        # Orphans werden erst ab ORPHAN_AGE_S (>1 h) eingesammelt.
        await asyncio.sleep(REAPER_INTERVAL_S)
        try:
            await _reap_once()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.exception("attachments reaper iteration failed")


REAPER_BATCH_SIZE = 500


async def _reap_once() -> int:
    cutoff = datetime.now(UTC) - timedelta(seconds=ORPHAN_AGE_S)
    async with SessionLocal() as session:
        # Project only the columns we need — avoids transferring the full row.
        result = await session.execute(
            select(
                MessageAttachment.id,
                MessageAttachment.storage_key,
                MessageAttachment.thumb_storage_key,
            ).where(
                MessageAttachment.message_id.is_(None),
                MessageAttachment.created_at < cutoff,
            ).limit(REAPER_BATCH_SIZE)
        )
        rows = result.all()
        if not rows:
            return 0

        async def _drop(key: str) -> None:
            try:
                await s3.delete_object(key)
            except Exception:  # noqa: BLE001
                log.exception("reaper s3 delete failed", key=key)

        keys: list[str] = []
        for r in rows:
            keys.append(r.storage_key)
            if r.thumb_storage_key:
                keys.append(r.thumb_storage_key)
        await asyncio.gather(*[_drop(k) for k in keys])

        await session.execute(
            sa_delete(MessageAttachment).where(
                MessageAttachment.id.in_([r.id for r in rows])
            )
        )
        await session.commit()
        log.info("reaped orphan attachments", count=len(rows))
        return len(rows)


__all__ = [
    "router",
    "bind_attachments",
    "serialize_attachments",
    "hard_delete_attachments",
    "reaper_loop",
]
