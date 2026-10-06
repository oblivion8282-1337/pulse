"""Shared helpers for the dropbox feature — used across all dropbox route
modules so we don't have to duplicate name validation, content-type
relabelling and event-publish logic.

Split out from ``routes/dropbox.py`` to keep each file under the
350-line soft cap (PLAN.md §12.1). The *permission* side — who may use the
Ablage at all and how much room they get — lives in ``_dropbox_policy.py``.
"""

from __future__ import annotations

import asyncio
import contextlib
import unicodedata
from datetime import datetime, timezone

from dcc_shared.events import (
    DropboxEntryPurgedEvent,
    DropboxQuotaUpdatedEvent,
)

from dcc_chat_gateway import s3
from dcc_chat_gateway.models import DropboxConfig
from dcc_chat_gateway.snowflake import next_id

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


def _fold_name(name: str) -> str:
    """Die kanonische Form, die tatsächlich gespeichert wird.

    Reihenfolge ist hier alles: (1) **NFKC zuerst** — die Normalisierung
    bildet unauffällige Kompatibilitätsformen auf genau die Zeichen ab, die
    geprüft werden müssen (U+FF0E → ``.``, U+FF0F → ``/``, U+2024 → ``.``,
    U+3000 → Leerzeichen). (2) **Dann die unsichtbaren Zeichen streichen** —
    auch das Streichen erzeugt erst die verbotene Form (``.``+ZWSP+``.`` →
    ``..``). (3) **Noch einmal NFKC** — das Streichen kann zwei Zeichen
    zusammenrücken, die zusammen zerlegbar sind (``e``+ZWJ+Combining Acute →
    ``é``); sonst wäre der Rückgabewert nicht sicher normalisiert und
    derselbe Name stünde in zwei Schreibweisen vor dem Unique-Index.

    Idempotent: ``_fold_name(_fold_name(x)) == _fold_name(x)``.
    """

    folded = unicodedata.normalize("NFKC", name)
    folded = "".join(
        c for c in folded
        if c not in _BIDI_FORMAT and c not in _ZW_INVISIBLE
    )
    return unicodedata.normalize("NFKC", folded)


def validate_name(name: str, *, max_len: int = 255) -> str:
    """Validate that ``name`` is a safe basename (no path separators,
    no control chars, no leading/trailing dots/whitespace). Returns the
    canonical form.

    **Jede Prüfung läuft gegen die kanonische Form** (``_fold_name``), also
    gegen genau den String, der gespeichert, in ``full_path()``
    zusammengesetzt und von ``dropbox_downloads.py`` als ZIP-Eintragsname
    geschrieben wird. Bis 17.08.2026 normalisierte erst der Rückgabewert:
    ``．．`` bzw. ``．．／evil.txt`` (Vollbreiten-Homoglyphe) kamen an allen
    Prüfungen vorbei und wurden als ``..`` bzw. ``../evil.txt`` gespeichert.

    Hardens against:
      - Path-traversal / NUL injection (``/`` ``\\`` ``\\0``)
      - Homograph attacks (NFKC-normalised so ``gоod.exe`` matches
        ``good.exe`` for clash checks elsewhere)
      - Bidirectional-override phishing (``evil\\u202Evbs.exe`` would
        display as ``vbsexe.exe.vbs``) — control chars stripped.
    """

    if not name:
        raise ValueError("name is empty")
    if len(name) > max_len:
        raise ValueError(f"name longer than {max_len} chars")
    cleaned = _fold_name(name)
    # NFKC darf einen Namen verlängern (``ﷺ`` → mehrere Zeichen) und das
    # Streichen darf ihn leeren — beides erst nach der Faltung messbar.
    if not cleaned:
        raise ValueError("name is empty")
    # Bughunt Runde 14: die Faltung NACH der Längenprüfung erneut messen —
    # sonst lief ein 4-Zeichen-Name (``ﷺﷺﷺﷺ``) durch die 422-Bound, faltete
    # auf 72 Zeichen und sprengte die String(64)-Spalte → 500 statt 422.
    if len(cleaned) > max_len:
        raise ValueError(f"name longer than {max_len} chars after normalisation")
    if any(c in _FORBIDDEN_NAME_CHARS for c in cleaned):
        raise ValueError("name contains forbidden character (/ \\ \\0)")
    # Steuerzeichen (C0/C1). Der Docstring verspricht sie seit jeher, geprüft
    # wurden bisher nur ``/ \\ \\0``. Ein ``\\r\\n`` im Namen bricht den
    # ZIP-Eintragsnamen und den ``Content-Disposition``-Header.
    if any(ord(c) < 0x20 or 0x7F <= ord(c) <= 0x9F for c in cleaned):
        raise ValueError("name contains a control character")
    if cleaned in (".", ".."):
        raise ValueError(f"name '{cleaned}' is reserved")
    if cleaned != cleaned.strip():
        raise ValueError("name has leading or trailing whitespace")
    # Führender Punkt bleibt erlaubt — versteckte POSIX-Dateien (``.env``,
    # ``.gitignore``) sind ein gültiger Upload. ``.`` und ``..`` sind oben
    # bereits abgewiesen.
    return cleaned


# Event helpers -------------------------------------------------------


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

    The ``.o`` segment hält neue Schlüssel von den alten, pfadabgeleiteten
    getrennt. Achtung: die frühere Begründung („``validate_name`` rejects any
    name starting with a dot") stimmt nicht — führende Punkte sind erlaubt
    (``.env``). Ein Altbestand mit einem Wurzelordner ``.o`` trüge denselben
    Präfix; neue Schlüssel entstehen nur noch hier.

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
