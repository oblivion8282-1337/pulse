"""Redis key layout + channel↔MediaMTX-path mapping for the HQ-streaming flow.

Canonical spelling of the keys shared between ``media-svc`` (writer of
``stream:channel:*`` + ``stream:token:*``, publisher of ``stream:events``) and
``mediamtx-auth-hook`` (reader of ``stream:token:*``, writer of
``stream:active:*``). The two services share no code or DB — only these names.
Keep this in sync with ``dcc_mediamtx_auth_hook.shared``.

Streams are per *(channel, user, slot, session-nonce)*: the MediaMTX path is
``channel-<channel_id>-<user_id>[-s<slot>]-<nonce>`` (nonce = 32 hex chars from
``secrets.token_hex(16)``, fresh per stream-token issue). The nonce gives every
publish a brand-new MediaMTX path so we side-step the WebRTC ICE-race that
MediaMTX 1.17.1 hits when the *same* path is republished within a few seconds
("deadline exceeded while waiting connection"; root cause is upstream in
pion/ice and fixed in v4.2.5 = MediaMTX 1.18+, which Pulse can't take yet
because of [[mediamtx-1-17-pinned]]). Several people can still stream into the
same voice channel at once — they have different ``user_id`` values and so
disjoint paths regardless of nonce.

**Slot** is the stable per-user stream index (0, 1, …) that lets ONE user run
several HQ streams at once (e.g. two monitors as separate viewer tiles). Unlike
the nonce (which churns on every reconnect), the slot is fixed for a stream's
lifetime, so it — not the nonce — is the identity dimension layered on top of
``user_id``. **Slot 0 is spelled exactly like the legacy single-stream format**
(no ``-s0`` path segment, no ``slot`` key suffix, no ``slot`` token field): a
single-stream deploy is byte-for-byte unchanged, and the regex below tolerates
both spellings so a rolling deploy with in-flight streams never flaps. Only
slot ≥ 1 carries the ``-s<slot>`` segment; the ``_slot_suffix`` helper encodes
that "slot 0 == legacy spelling" rule in one place for every path/key builder.
See ``docs/plans/2026-06-23-multi-hq-stream.md``.
"""

from __future__ import annotations

import re
from typing import Any

CHANNEL_PATH_PREFIX = "channel-"
# channel-<channel_id>-<user_id>[-s<slot>]-<nonce>
#   cid + uid are snowflakes (all digits), slot is an optional small int
#   (segment absent == slot 0 / legacy), nonce is 32 lowercase hex.
CHANNEL_USER_PATH_RE = re.compile(r"^channel-(\d+)-(\d+)(?:-s(\d+))?-([0-9a-f]{32})$")

# stream:token:<token>                   → JSON {channel_id, user_id, nonce, scope:"publish", protocol,
#                                          created_at, slot? (omitted when 0), label? (omitted when empty),
#                                          ten_bit? (omitted when false)}
#                                          issued by media-svc with TTL = TOKEN_TTL_S, consumed by the hook.
#                                          ``ten_bit`` rides along so the viewer can pick a playback path
#                                          BEFORE decoding (only the native player renders >8 bit) — the hook
#                                          copies it into ``stream:active`` and ``GET /whep`` returns it.
#                                          This line listed neither field until 2026-08-04, while
#                                          ``routes.py`` had been writing them for weeks; the auth-hook copy
#                                          (which calls THIS file authoritative) already carried them.
# stream:active:channel-<cid>-<uid>[-s<slot>] → JSON {user_id, started_at, path, label?, ten_bit?}
#                                          written by the hook on a successful publish-auth (path carries the
#                                          nonce so viewers can locate the live MediaMTX path). ``label`` is
#                                          copied from the token record so the poller can surface it without
#                                          a second lookup source. TTL self-heal.
#                                          Build via ``active_key()`` — slot 0 drops the ``-s0`` suffix.
# stream:channel:<cid>                   → JSON {user_ids: [str, ...], streams?: [{user_id, slot, label?}], since: iso8601}
#                                          the public per-channel set of HQ streamers, owned by the poller.
#                                          ``streams`` is additive + only present when a user runs slot ≥ 1.
TOKEN_KEY = "stream:token:{token}"
ACTIVE_KEY = "stream:active:channel-{channel_id}-{user_id}"
CHANNEL_STATE_KEY = "stream:channel:{channel_id}"
# stream:stopping:channel-<cid>-<uid>[-s<slot>] → "1" (short TTL = stop_suppression_s)
#   Set by the explicit-stop route; the poller treats a (cid,uid,slot) carrying it
#   as "not publishing" even while MediaMTX still lists the path (its disconnect
#   detection lags the user's stop click). media-svc-only — the auth-hook never
#   reads it. Cleared when a fresh stream-token is issued (restart un-suppresses).
#   Build via ``stopping_key()`` — slot 0 drops the ``-s0`` suffix.
STOPPING_KEY = "stream:stopping:channel-{channel_id}-{user_id}"

# Pub/Sub channel — media-svc publishes per-channel stream-state changes here;
# chat-gateway subscribes and re-broadcasts. Event payload (the *full* current
# set after the change): {"channel_id": "<id>", "user_ids": ["<id>", ...],
# "streams"?: [{"user_id", "slot", "label"?}]} — ``streams`` only when a user
# runs slot ≥ 1.
STREAM_EVENTS_CHANNEL = "stream:events"


def parse_channel_user_path(path: str) -> tuple[str, str, str, str] | None:
    """``channel-<cid>-<uid>[-s<slot>]-<nonce>`` → ``(cid, uid, slot, nonce)`` as
    strings, else ``None``. A legacy path without the ``-s<slot>`` segment yields
    ``slot == "0"`` so callers need no special-casing."""
    m = CHANNEL_USER_PATH_RE.match(path or "")
    if m is None:
        return None
    return (m.group(1), m.group(2), m.group(3) or "0", m.group(4))


def _slot_suffix(slot: int) -> str:
    """The ``-s<slot>`` path/key segment — empty for slot 0. This is the single
    place the "slot 0 == legacy spelling (no suffix)" rule lives, shared by the
    path and key builders so they can never drift out of sync."""
    return "" if int(slot) == 0 else f"-s{slot}"


def path_for_channel_user(channel_id: str, user_id: str, nonce: str, slot: int = 0) -> str:
    """Build the MediaMTX path. Slot 0 → legacy ``channel-<cid>-<uid>-<nonce>``
    (no ``-s0``); slot ≥ 1 → ``channel-<cid>-<uid>-s<slot>-<nonce>``."""
    return f"{CHANNEL_PATH_PREFIX}{channel_id}-{user_id}{_slot_suffix(slot)}-{nonce}"


def active_key(channel_id: str, user_id: str, slot: int = 0) -> str:
    """``stream:active`` key for one (channel, user, slot). Slot 0 → the legacy
    key with no ``-s0`` suffix (so existing single-stream records are untouched)."""
    return ACTIVE_KEY.format(channel_id=channel_id, user_id=user_id) + _slot_suffix(slot)


def stopping_key(channel_id: str, user_id: str, slot: int = 0) -> str:
    """``stream:stopping`` tombstone key for one (channel, user, slot). Slot 0 →
    the legacy key with no ``-s0`` suffix."""
    return STOPPING_KEY.format(channel_id=channel_id, user_id=user_id) + _slot_suffix(slot)


def streams_from_state(state: dict[str, Any]) -> list[dict[str, Any]]:
    """Pull the additive ``streams`` list out of a ``stream:channel`` record,
    normalised to ``[{"user_id": str, "slot": int, "label"?: str}]`` and
    tolerant of legacy records that have no ``streams`` key (→ ``[]``). ``label``
    is carried only when present + non-empty so legacy records stay byte-identical."""
    out: list[dict[str, Any]] = []
    for d in state.get("streams") or []:
        if not isinstance(d, dict):
            continue
        uid = d.get("user_id")
        if not uid:
            continue
        try:
            slot = int(d.get("slot", 0))
        except (TypeError, ValueError):
            continue
        entry: dict[str, Any] = {"user_id": str(uid), "slot": slot}
        label = d.get("label")
        if isinstance(label, str) and label:
            entry["label"] = label
        out.append(entry)
    return out
