"""Shared helpers for the dropbox feature — used across all dropbox route
modules so we don't have to duplicate path-normalisation, quota mutation
and event-publish logic.

Split out from ``routes/dropbox.py`` to keep each file under the
350-line soft cap (PLAN.md §12.1). The *permission* side — who may use the
Ablage at all and how much room they get — lives in ``_dropbox_policy.py``.
"""

from __future__ import annotations

import asyncio
import contextlib
import unicodedata
from datetime import datetime, timezone

from fastapi import HTTPException

from dcc_chat_gateway import s3
from dcc_chat_gateway.models import (
    DROPBOX_KIND_FILE,
    Channel,
    DropboxConfig,
    DropboxFile,
)
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from dcc_chat_gateway.routes._dropbox_schemas import DropboxEntryOut
from dcc_chat_gateway.snowflake import next_id
from dcc_shared.events import (
    DropboxEntryCreatedEvent,
    DropboxEntryDeletedEvent,
    DropboxEntryPurgedEvent,
    DropboxEntryRestoredEvent,
    DropboxEntryUpdatedEvent,
    DropboxQuotaUpdatedEvent,
)


# Path + name validation -----------------------------------------------

_FORBIDDEN_NAME_CHARS = set("/\\\x00")

# Unicode bidi-override / isolate characters. Stripping these denies
# members the ``evil‮vbs.exe`` → ``vbsexe.exe.vbs`` trick. The
# block is intentionally narrow — only the explicit bidi-formatting
# controls; legitimate CJK filenames are unaffected.
_BIDI_FORMAT = frozenset(
    "‪‫‬‭‮⁦⁧⁨⁩"
)

# Zero-width / invisible characters. None of these have a
# legitimate use inside a file basename — ``vi​cus`` and
# ``.env​`` are display-spoofing tricks that pass the
# bidi-strip but still confuse the user reading the sidebar.
_ZW_INVISIBLE = frozenset(
    "​‌‍⁠﻿"
)

# Content-Types we'll happily store with ``Content-Disposition: inline``
# on the presigned GET. Anything else gets relabelled
# ``application/octet-stream`` and served with ``attachment`` to defuse
# the ``text/html`` → in-browser-XSS attack. Order matters: more
# specific prefixes come first. ``image/svg+xml`` is intentionally
# excluded from the ``image/`` prefix — SVG can carry inline
# ``<script>`` and ``<foreignObject>`` and would re-introduce the
# XSS vector we're trying to close. Matched explicitly below.
_INLINE_PREFIXES = (
    "image/",  # matched; ``image/svg+xml`` is blocked separately
    "application/pdf",
    "audio/",
    "video/",
    "text/plain",
)

# Specific types that share an otherwise-allowed prefix but must
# still be relabelled to ``application/octet-stream``. Matched
# case-insensitively against the bare type (no ``;charset=``).
_DENY_INLINE_TYPES = frozenset(
    {
        "image/svg+xml",
        # Belt-and-braces: rare text subtypes that some browsers
        # still render in-document even with ``Content-Disposition:
        # inline`` would be sniffed here. None today; the set is
        # empty on purpose — explicit denylist only, never deny by
        # omission.
    }
)


def is_safe_inline_content_type(ct: str | None) -> bool:
    """True if ``ct`` is in the inline-safe whitelist. None / empty
    / unknown types default to False (will be re-labelled)."""

    if not ct:
        return False
    c = ct.split(";", 1)[0].strip().lower()
    if c in _DENY_INLINE_TYPES:
        return False
    return any(c.startswith(p) for p in _INLINE_PREFIXES)


def normalize_content_type(ct: str | None) -> str:
    """Return a safe content-type for the row. Anything not in the
    inline-safe whitelist is relabelled to ``application/octet-stream``
    so the presigned GET serves it with ``Content-Disposition: attachment``
    — defuses storage-based XSS via ``text/html``."""

    if is_safe_inline_content_type(ct):
        return ct.split(";", 1)[0].strip().lower()
    return "application/octet-stream"


def normalize_parent_path(raw: str | None) -> str:
    """Return the canonical ``parent_path`` representation.

    * empty / None → ``""`` (root)
    * leading + trailing ``/`` → stripped
    * double slashes → collapsed
    * backslashes normalised to forward-slashes (Windows-Pickup from the
      ``webkitGetAsEntry`` API can hand us those)

    Rejects empty components (the result of leading/trailing slashes
    after stripping) so a "foo//bar" doesn't sneak through."""

    if raw is None:
        return ""
    # Normalise Windows separators + collapse runs.
    cleaned = raw.replace("\\", "/").strip("/")
    if not cleaned:
        return ""
    parts = [p for p in cleaned.split("/") if p]
    if any(p in ("",) for p in parts):
        # Defensive — split+filter already drops empties, but a ".."
        # would survive and let a user escape the dropbox root.
        raise ValueError("parent_path contains empty component")
    for p in parts:
        if p in (".", ".."):
            raise ValueError(
                f"parent_path must not contain '{p}' components"
            )
    return "/".join(parts)


def validate_name(name: str) -> str:
    """Validate that ``name`` is a safe basename (no path separators,
    no control chars, no leading/trailing dots/whitespace). Returns the
    canonical form.

    Hardens against:
      - Path-traversal / NUL injection (``/`` ``\\`` ``\\0``)
      - Homograph attacks (NFKC-normalised so ``gоod.exe`` matches
        ``good.exe`` for clash checks elsewhere)
      - Bidirectional-override phishing (``evil\\u202Evbs.exe`` would
        display as ``vbsexe.exe.vbs``) — control chars stripped.
    """

    if not name:
        raise ValueError("name is empty")
    if len(name) > 255:
        raise ValueError("name longer than 255 chars")
    # Strip bidi-format + zero-width-invisible chars BEFORE the
    # forbidden-char check (which only catches a narrow set of
    # bytes anyway).
    cleaned = "".join(
        c for c in name
        if c not in _BIDI_FORMAT and c not in _ZW_INVISIBLE
    )
    if any(c in _FORBIDDEN_NAME_CHARS for c in cleaned):
        raise ValueError("name contains forbidden character (/ \\ \\0)")
    if cleaned in (".", ".."):
        raise ValueError(f"name '{cleaned}' is reserved")
    if cleaned != cleaned.strip():
        raise ValueError("name has leading or trailing whitespace")
    if cleaned.startswith("."):
        # Hidden files on POSIX uploads are fine (``.env``, ``.gitignore``)
        # — only a single leading dot at the start. Reject ``..`` already
        # handled above.
        pass
    return unicodedata.normalize("NFKC", cleaned)


def full_path(parent_path: str, name: str) -> str:
    """Combine a normalized parent path + validated name into the full
    MinIO-relative path. Empty root → just the name. Public so the
    upload route can build the storage key without redefining it."""

    if not parent_path:
        return name
    return f"{parent_path}/{name}"


# Quota mutation ------------------------------------------------------


def bump_used(config: DropboxConfig, delta: int) -> None:
    """Adjust the cached ``used_bytes`` by ``delta`` (positive on upload,
    negative on delete / restore-from-trash → - used). The sweep task
    reconciles against MinIO truth at startup.

    Synchronous because we only mutate an attribute the session already
    tracks — caller's own ``commit()`` makes the change durable."""

    new_val = config.used_bytes + delta
    # Guard against underflow — the cached counter must never go
    # negative. The sweep will reconcile if a buggy path let this drift.
    config.used_bytes = max(0, new_val)


async def locked_config(
    session: AsyncSession, guild_id: int
) -> DropboxConfig | None:
    """Read the quota row with a row-level lock so two concurrent
    quota-mutating requests can't both pass the check before either
    commits the bump. Returns ``None`` if the dropbox was never
    provisioned.

    The per-guild ``asyncio.Lock`` (``with_quota_lock``) is the
    caller-side synchronisation; this bare helper only adds the DB
    row-lock where the dialect supports it (Postgres). On SQLite the
    app-level lock alone closes the reader/writer gap."""

    bind = session.get_bind()
    stmt = select(DropboxConfig).where(DropboxConfig.guild_id == guild_id)
    if bind.dialect.name == "postgresql":
        stmt = stmt.with_for_update()
    return (await session.execute(stmt)).scalars().first()


# Event helpers -------------------------------------------------------


def entry_dict(entry: DropboxFile) -> dict[str, object]:
    """Wire-shape of a dropbox entry — used everywhere an event fires.

    Same field names + snowflake-as-string serialization as the
    Pydantic ``DropboxEntryOut`` so the listener + FE can treat them
    interchangeably."""

    return DropboxEntryOut.model_validate(entry).model_dump(mode="json")


async def resolve_or_create_dropbox_channel(
    session, guild_id: int, *, name: str = "ablage"
) -> Channel:
    """Lazy-resolve the dropbox channel — re-creates on the
    finish-upload path if the row was deleted between mint and finish.
    ``routes.dropbox._get_or_create_dropbox_channel`` is the equivalent
    for the routes-side first-access path; this one lives here so the
    upload module doesn't need to import the route module."""

    from dcc_chat_gateway.models import CHANNEL_TYPE_DROPBOX  # avoid cycle

    stmt = (
        select(Channel)
        .where(
            Channel.guild_id == guild_id,
            Channel.type == CHANNEL_TYPE_DROPBOX,
        )
        .order_by(Channel.position.desc())
        .limit(1)
    )
    channel = (await session.execute(stmt)).scalars().first()
    if channel is not None:
        return channel
    channel = Channel(
        id=fresh_entry_id(),
        guild_id=guild_id,
        name=name,
        type=CHANNEL_TYPE_DROPBOX,
        position=0,
    )
    session.add(channel)
    await session.flush()
    return channel


async def serialize_entry(session, entry: DropboxFile) -> DropboxEntryOut:
    """DB-row → wire dict, with a fresh presigned GET URL for files.

    Single source of truth used by every dropbox route (list, folder,
    patch, delete, restore, finish-upload). The presigned URL is
    best-effort — transient MinIO outage degrades to ``url=None``
    instead of failing the whole call.

    The presigned URL is signed with ``inline=False`` when the row's
    content-type is NOT in the inline-safe whitelist (set by
    ``finish_upload`` via ``normalize_content_type``). That way the
    browser downloads the file instead of rendering it — defuses the
    ``text/html`` → in-browser-XSS vector. ``filename`` is the
    row's display name so the saved file keeps its on-platform name."""

    out = DropboxEntryOut.model_validate(entry)
    if entry.kind == DROPBOX_KIND_FILE and entry.storage_key:
        try:
            inline = is_safe_inline_content_type(entry.content_type)
            out.url = await s3.presigned_get_url(
                entry.storage_key,
                filename=entry.name if not inline else None,
                inline=inline,
            )
        except Exception:  # noqa: BLE001 — transient MinIO outage
            out.url = None
    return out


async def publish_entry_event(mgr, *, kind: str, guild_id: int, entry: DropboxFile) -> None:
    """Fan out a dropbox-mutation event on the guild channel.

    ``kind`` is one of ``created``, ``updated``, ``deleted``,
    ``restored``. ``purged`` is handled separately because that one
    doesn't carry a full entry (the row is gone by then)."""

    if mgr is None:
        return
    payload = entry_dict(entry)
    if kind == "created":
        await mgr.publish_guild_event(
            DropboxEntryCreatedEvent(guild_id=str(guild_id), entry=payload)
        )
    elif kind == "updated":
        await mgr.publish_guild_event(
            DropboxEntryUpdatedEvent(guild_id=str(guild_id), entry=payload)
        )
    elif kind == "deleted":
        await mgr.publish_guild_event(
            DropboxEntryDeletedEvent(guild_id=str(guild_id), entry=payload)
        )
    elif kind == "restored":
        await mgr.publish_guild_event(
            DropboxEntryRestoredEvent(guild_id=str(guild_id), entry=payload)
        )


async def publish_purge_event(mgr, *, guild_id: int, entry_id: int, kind: int) -> None:
    if mgr is None:
        return
    await mgr.publish_guild_event(
        DropboxEntryPurgedEvent(
            guild_id=str(guild_id),
            entry_id=str(entry_id),
            kind=kind,
        )
    )


async def publish_quota_event(mgr, config: DropboxConfig) -> None:
    if mgr is None:
        return
    await mgr.publish_guild_event(
        DropboxQuotaUpdatedEvent(
            guild_id=str(config.guild_id),
            enabled=bool(config.enabled),
            total_quota_bytes=int(config.total_quota_bytes),
            per_file_max_bytes=int(config.per_file_max_bytes),
            used_bytes=int(config.used_bytes),
            trash_retention_days=int(config.trash_retention_days),
        )
    )


# Cold helpers --------------------------------------------------------


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def fresh_entry_id() -> int:
    """Snowflake id for the next entry. Wraps ``next_id`` so the test
    suite can monkeypatch here instead of chasing the snowflake worker
    across modules."""

    return next_id()


def storage_path_for(guild_id: int, entry_id: int) -> str:
    """Build the MinIO key for a file's primary storage (v1+).

    Keyed by the entry's snowflake id, NOT by its path. A path-derived key
    silently aliases as soon as an entry moves: rename/move rewrites
    ``parent_path``/``name`` but cannot rewrite the bytes' location, so the row
    would keep pointing at the old key while its logical path frees up — and the
    next upload to that freed path would be handed the very same key, letting one
    member overwrite (or, via the trash sweep, destroy) another member's file.
    An id-derived key is unique by construction and path-independent, so moves
    need not touch it at all.

    The ``.o`` segment keeps new keys disjoint from the legacy path-derived ones
    still in the table: ``validate_name`` rejects any name starting with a dot,
    so no legacy key can contain this segment.

    Versioning puts historical versions under ``<base>_v<n>`` — see
    ``routes/dropbox.py::finish_upload`` where v1 is the initial and v>=2
    are kept around on overwrite. Only the *current* version's key is
    referenced by the live row; old versions stay in place until the
    trash-sweep purges the row."""

    return s3.dropbox_storage_path(guild_id, f".o/{entry_id}")


# Per-guild application-level locks for quota-mutating endpoints.
# Process-local: redundant on Postgres where ``SELECT FOR UPDATE``
# is authoritative, but closes the SQLite reader/writer gap (the
# ``FOR UPDATE`` is a no-op on SQLite). Entries are evicted in
# ``purge_guild_dropbox_objects``'s caller path when a guild is
# hard-deleted (TODO tracked separately); the dict is bounded by the
# number of *currently active* guilds, which the platform caps.
_QUOTA_LOCKS: dict[int, asyncio.Lock] = {}


def _guild_lock(guild_id: int) -> asyncio.Lock:
    lock = _QUOTA_LOCKS.get(guild_id)
    if lock is None:
        lock = asyncio.Lock()
        _QUOTA_LOCKS[guild_id] = lock
    return lock


@contextlib.asynccontextmanager
async def with_quota_lock(guild_id: int):
    """Hold the per-guild app-level lock for the duration of the
    caller block. Use around any read-then-bump on
    ``DropboxConfig.used_bytes`` so two parallel quota-mutating
    requests can't both pass the check before either commits.

    Belt-and-braces: ``_locked_config`` inside the locked block also
    opts into the Postgres row-level ``SELECT ... FOR UPDATE``. On
    SQLite that ``FOR UPDATE`` is a no-op, so this app-level lock is
    the only synchronisation between requests in one process."""

    async with _guild_lock(guild_id):
        yield


def evict_quota_lock(guild_id: int) -> None:
    """Drop the per-guild lock from ``_QUOTA_LOCKS``.

    Called from ``purge_guild_dropbox_objects`` (run at guild-delete
    time, both directly and via the orphan-sweep cascade) so a
    long-running server doesn't accumulate one lock per guild that
    ever touched the dropbox. Safe to call from outside the lock —
    the entry may be in-use by an in-flight request; that request
    will release the lock as usual, the next caller on the
    (newly-deleted) guild id will allocate a fresh ``asyncio.Lock``
    that's never contended."""

    _QUOTA_LOCKS.pop(guild_id, None)
