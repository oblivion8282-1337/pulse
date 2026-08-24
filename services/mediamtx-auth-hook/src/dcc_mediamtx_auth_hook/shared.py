"""Constants shared with media-svc (Redis key layout, channel-path mapping).

These two services do **not** share code or a DB — they only meet on a handful
of Redis keys. This module is the single place those names are spelled, copied
verbatim from ``dcc_media_svc.streamkeys``. Keep them in sync.

Streams are per *(channel, user, slot, session-nonce)*: the MediaMTX path is
``channel-<channel_id>-<user_id>[-s<slot>]-<nonce>`` (nonce = 32 hex from
``secrets.token_hex(16)``) so every publish gets a fresh path, avoiding the
MediaMTX-1.17.1 ICE-race on rapid republish of the same path. **Slot** (0, 1, …)
is the stable per-user stream index that lets one user run several streams at
once; **slot 0 is spelled like the legacy single-stream format** (no ``-s0``
segment / key suffix), and the regex tolerates both so a rolling deploy with
in-flight streams never flaps. See ``dcc_media_svc.streamkeys`` for the full
rationale.
"""

from __future__ import annotations

import re

CHANNEL_PATH_PREFIX = "channel-"
# channel-<channel_id>-<user_id>[-s<slot>]-<nonce>
#   cid + uid are snowflakes (all digits), slot is an optional small int
#   (segment absent == slot 0 / legacy), nonce is 32 lowercase hex.
CHANNEL_USER_PATH_RE = re.compile(r"^channel-(\d+)-(\d+)(?:-s(\d+))?-([0-9a-f]{32})$")

# Redis keys (see dcc_media_svc.streamkeys for the authoritative comments).
#   stream:token:<token>                        → JSON {channel_id, user_id, nonce, scope, protocol,
#                                                  created_at, slot? (omitted when 0), label? (omitted when empty),
#                                                  ten_bit? (omitted when false), monitor_index? (omitted when unset)}
#   stream:active:channel-<cid>-<uid>[-s<slot>] → JSON {user_id, started_at, path, label?, ten_bit?, monitor_index?}  (written here on publish-auth)
#   stream:channel:<cid>                        → JSON {user_ids: [...], streams?: [...], since}  (owned by poller)
# ``TOKEN_KEY`` steht seit 2026-08-13 kanonisch in ``dcc_shared.streaming``
# (chat-gateway loescht den Datensatz beim Bann). Diese Kopie bleibt bewusst
# stehen: dieser Dienst hat keine ``dcc-shared``-Abhaengigkeit. Aendert sich
# das Praefix dort, muss es hier mit.
TOKEN_KEY = "stream:token:{token}"
ACTIVE_KEY = "stream:active:channel-{channel_id}-{user_id}"
CHANNEL_STATE_KEY = "stream:channel:{channel_id}"

# Pub/Sub channel — media-svc publishes per-channel stream-state changes here,
# chat-gateway subscribes and re-broadcasts. Payload (full set after the change):
#   {"channel_id": "<id>", "user_ids": ["<id>", ...], "streams"?: [{"user_id", "slot"}]}
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


def active_key(channel_id: str, user_id: str, slot: int = 0) -> str:
    """``stream:active`` key for one (channel, user, slot). Slot 0 → the legacy
    key with no ``-s0`` suffix (so existing single-stream records are untouched)."""
    return ACTIVE_KEY.format(channel_id=channel_id, user_id=user_id) + _slot_suffix(slot)
