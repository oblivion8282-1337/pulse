"""Public community-handle (vanity slug) validation — Stufe 4.

A handle is the human-readable part of a community's public address
(``<host>/c/<handle>``). It is **per-instance unique** (DB partial unique
index on ``guilds.handle``) and only resolves while the community is public.

Format (single source of truth — the route + tests import ``validate_handle``):

* 3–32 chars
* lowercase ASCII alnum + hyphens only
* must not start or end with a hyphen

Reserved words are rejected so a handle can never shadow a routing keyword the
SPA / future endpoints rely on (``/c/new``, ``/c/admin`` …). This is a thin
anti-squatting / anti-confusion guard, not full moderation (handle moderation is
a deliberately-open question in the plan).
"""

from __future__ import annotations

import re

# 3–32 chars total: an alnum edge, then up to 30 of alnum/hyphen, then an alnum
# edge. The ``{1,30}`` middle + two anchors gives the 3..32 length window.
_HANDLE_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$")

# Words a handle may never take — keeps the ``/c/<handle>`` namespace free of
# routing/keyword collisions. Lowercase (handles are already lowercased).
RESERVED_HANDLES: frozenset[str] = frozenset(
    {
        "new",
        "create",
        "join",
        "admin",
        "settings",
        "about",
        "help",
        "support",
        "api",
        "app",
        "www",
        "static",
        "assets",
        "null",
        "undefined",
        "pulse",
        "system",
        "everyone",
        "here",
    }
)


def is_valid_handle(handle: str) -> bool:
    """True iff ``handle`` matches the slug format and is not reserved."""
    if not _HANDLE_RE.match(handle):
        return False
    return handle not in RESERVED_HANDLES


def validate_handle(handle: str) -> str:
    """Return the validated handle or raise ``ValueError``.

    Does **not** lowercase/normalise: a handle is stored exactly as given and
    must already be lowercase to pass. Callers that want to be lenient should
    lowercase before calling; the API contract here is "reject, don't mangle"
    so an uppercase handle is a clear 422 rather than a silent rewrite that
    could surprise the client about what address it ended up with.
    """
    if not is_valid_handle(handle):
        raise ValueError(
            "handle must be 3–32 chars, lowercase letters/digits/hyphens, "
            "not starting or ending with a hyphen, and not a reserved word"
        )
    return handle


__all__ = ["RESERVED_HANDLES", "is_valid_handle", "validate_handle"]
