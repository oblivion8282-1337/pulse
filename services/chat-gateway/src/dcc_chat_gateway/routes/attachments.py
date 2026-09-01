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
import re
import secrets
from datetime import UTC, datetime, timedelta
from typing import Iterable

import structlog
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete as sa_delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway import config as chat_config, ratelimit, s3
from dcc_chat_gateway.db import SessionDep, SessionLocal
from dcc_chat_gateway.models import (
    LEGACY_READONLY_DETAIL,
    Channel,
    ChatSettings,
    Guild,
    MessageAttachment,
)
from dcc_chat_gateway.permissions import (
    Permissions,
    check_permission,
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
from dcc_chat_gateway.guild_limits import LIMITS_BY_KEY, effective

log = structlog.get_logger(__name__)
router = APIRouter()

# ─── MIME allowlist ─────────────────────────────────────────────────────────
# Only safe MIME types that cannot be rendered as HTML by the browser are
# permitted.  text/html, application/javascript, text/css and similar are
# intentionally excluded to prevent stored-XSS via a crafted Content-Type on
# a presigned MinIO GET URL served from the same origin.

# NOTE: image/svg+xml is intentionally NOT allowed — an SVG can carry inline
# <script> and, when opened directly via its presigned MinIO URL (same origin),
# executes as a document. That is exactly the stored-XSS vector this allowlist
# exists to block.
_ALLOWED_MIME_RE = re.compile(
    r"^(?:"
    r"image/(jpeg|png|gif|webp|bmp|tiff|x-icon|avif|heic|heif)"
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
    """Raise 400 if the MIME type is not on the safe allowlist, or — on the
    Cloud — falls outside the narrower ``CLOUD_ATTACHMENT_MIME_PREFIXES``.

    The base allowlist blocks stored-XSS; the Cloud policy on top keeps the
    upload surface aligned with what hash-matching can actually inspect (see
    docs/medien-speicher-und-scanning.md). It lives inside this function
    rather than at the call site so no future upload path can forget it.
    Self-hosts are never restricted by it — their operator owns their content
    (cert model).

    The policy makes ``application/octet-stream`` unreachable under an
    ``image/`` prefix, which is the point: it is the fallback the browser
    uploader emits for unknown types and would otherwise let any file through
    a MIME-based filter."""
    if not _ALLOWED_MIME_RE.match(mime):
        raise HTTPException(400, detail=f"unsupported mime type: {mime!r}")
    settings = chat_config.get_settings()
    if settings.pulse_instance_mode != "cloud":
        return
    prefixes = settings.cloud_attachment_mime_prefix_list
    if prefixes and not any(mime.startswith(p) for p in prefixes):
        raise HTTPException(
            400,
            detail=(
                f"unsupported mime type: {mime!r} — this server accepts only "
                + ", ".join(f"{p}*" for p in prefixes)
            ),
        )


def _enforce_dm_attachment_policy(kind: str) -> None:
    """Raise 403 when attachments are switched off for DMs on this instance.

    Cloud-only: the DM path is the one surface we may not lawfully scan (the
    ePrivacy derogation covers interpersonal communication and has lapsed), so
    the Cloud does not offer an unscannable private upload channel at all.
    Self-hosts are unaffected. Reversible via CLOUD_DM_ATTACHMENTS_ENABLED."""
    settings = chat_config.get_settings()
    if kind != "dm" or settings.pulse_instance_mode != "cloud":
        return
    if not settings.cloud_dm_attachments_enabled:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail="attachments are disabled in direct messages on this server",
        )


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


async def _enforce_storage_quota(
    session: AsyncSession, guild_id: int, new_bytes: int
) -> None:
    """Reject the upload (413) if it would push the community over its total
    attachment-storage quota. NULL quota = unlimited. Drift-free: sums the
    live (non-deleted) attachment bytes on demand (same query as the owner
    list). A small overshoot under concurrent uploads is accepted — this is a
    cost cap, not a security boundary."""
    guild = await session.get(Guild, guild_id)  # identity-mapped; no extra query
    # Wirksamer Wert: hat die Community sich selbst enger gesetzt, gilt ihrer;
    # sonst die Obergrenze des Betreibers (beim Speichern geklemmt, kann also
    # nie darüber liegen).
    quota = (
        effective(guild, LIMITS_BY_KEY["attachment_storage_quota_bytes"])
        if guild
        else None
    )
    if quota is None:
        return
    used = (
        await session.execute(
            select(func.coalesce(func.sum(MessageAttachment.size), 0))
            .select_from(MessageAttachment)
            .join(Channel, Channel.id == MessageAttachment.channel_id)
            .where(
                Channel.guild_id == guild_id,
                MessageAttachment.deleted_at.is_(None),
            )
        )
    ).scalar_one()
    if used + new_bytes > quota:
        raise HTTPException(
            status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"community storage quota exceeded ({used} + {new_bytes} > {quota} bytes)",
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
    if kind == "guild" and getattr(ch, "ablage", False):
        # Mischzustand-Regel: Anhaenge von Ablage-Kanaelen verschluesselt der
        # Klient und legt sie in die Ablage — MinIO sieht hier nichts.
        raise HTTPException(
            403,
            detail="ablage channel: plaintext attachment upload is not accepted",
        )
    if kind == "guild" and getattr(ch, "legacy_readonly", False):
        # Umstellung (Entwurf §9, Etappe E9): eingefrorener Alt-Kanal — kein
        # neuer Anhang, egal ob er je an eine Nachricht gebunden würde.
        raise HTTPException(403, detail=LEGACY_READONLY_DETAIL)
    _enforce_dm_attachment_policy(kind)
    # ATTACH_FILES gate (guild channels only — DMs have no permission overlay).
    if kind == "guild":
        await check_permission(
            session, current, ch.guild_id, Permissions.ATTACH_FILES,
            channel_id=channel_id,
        )
    max_size, _max_count = await _limits_for_channel(session, kind=kind, ch=ch)

    if payload.size > max_size:
        raise HTTPException(
            status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"file too large ({payload.size} > {max_size} bytes)",
        )

    # Community-wide total-storage cap (guild channels only; DMs are covered by
    # the chat_settings DM limits, not a per-community quota).
    if kind == "guild":
        await _enforce_storage_quota(session, ch.guild_id, payload.size)

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
        # Ein verschluesselter Anhang (Etappe E) steht dauerhaft in diesem
        # Zweig: fuer ihn ist es die richtige Antwort — der Absender kommt an
        # seine eigenen Bytes, Empfaenger holen ihre Adresse ueber
        # ``routes/postfach_anhaenge.py`` gegen einen Zustellungsnachweis.
        if row.uploader_id != current.id:
            raise HTTPException(404, detail="attachment not found")
    else:
        # Bound to a message: caller must be able to view that channel.
        kind, ch = await resolve_channel_or_raise(session, row.channel_id, current.id)
        if kind == "guild":
            await check_permission(
                session, current, ch.guild_id, Permissions.VIEW_CHANNEL,
                channel_id=row.channel_id,
            )

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
        # Haengt der Anhang schon an einem verschluesselten Umschlag
        # (Etappe E), faellt er mit dessen letztem — die Nachricht zeigte
        # danach auf Bytes, die es nicht mehr gibt. Gegenrichtung:
        # ``postfach_anhaenge.py::binde_anhaenge``. Dieselbe Meldung wie
        # oben, weil sie zutrifft: gebunden, nur eben an einen Umschlag.
        if r.postfach_gebunden_am is not None:
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
    defer_s3: list[str] | None = None,
) -> int:
    """Hard-delete attachment rows + their MinIO objects.

    Exactly one of ``message_ids`` / ``attachment_ids`` should be passed.
    MinIO failures are logged but don't roll back the DB delete — better
    a slightly-orphaned object than a half-stuck message.

    When ``defer_s3`` is a list, the MinIO objects are NOT deleted here;
    instead their storage keys are appended to that list so the caller can
    purge them AFTER a successful ``session.commit()`` (see ``edit_message``
    for the rationale — deleting S3 before commit means a commit failure
    loses the bytes while the rows still reference them, invisible to the
    reaper). The ``deleted_at`` tombstone is still written here either way.
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
    if defer_s3 is not None:
        # Hand the keys back to the caller; they purge S3 after commit.
        defer_s3.extend(keys)
    else:
        await asyncio.gather(*[_drop(k) for k in keys])

    now = datetime.now(UTC)
    await session.execute(
        update(MessageAttachment)
        .where(MessageAttachment.id.in_([r.id for r in rows]))
        .values(deleted_at=now)
    )
    return len(rows)


async def purge_s3_keys(keys: list[str]) -> None:
    """Delete a list of MinIO/S3 keys best-effort (failures logged, not raised).

    Intended to run AFTER a successful ``session.commit()`` — pair it with
    ``hard_delete_attachments(..., defer_s3=keys)`` so the bytes are only
    dropped once the ``deleted_at`` tombstone is durably persisted.
    """
    if not keys:
        return

    async def _drop(key: str) -> None:
        try:
            await s3.delete_object(key)
        except Exception:  # noqa: BLE001
            log.exception("s3 delete failed after commit", key=key)

    await asyncio.gather(*[_drop(k) for k in keys])


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
                # Ein verschluesselter Anhang (Etappe E) traegt fuer immer
                # ``message_id IS NULL`` — verschluesselte Nachrichten
                # erzeugen keine ``messages``-Zeile. Ohne diese zweite
                # Bedingung loeschte der Reaper ihn eine Stunde nach dem
                # Hochladen, waehrend sein Umschlag noch auf Abholung
                # wartet. Zustaendig ist dafuer
                # ``postfach_pflege.py::sweep_verwaiste_anhaenge`` — genau
                # die Gegenbedingung, kein zweiter Lauf ueber dieselbe Menge.
                MessageAttachment.postfach_gebunden_am.is_(None),
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
    "purge_s3_keys",
    "reaper_loop",
]
