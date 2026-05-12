"""Constants shared with media-svc (Redis key layout, channel-path mapping).

These two services do **not** share code or a DB — they only meet on a handful
of Redis keys. This module is the single place those names are spelled, copied
verbatim into media-svc as ``dcc_media_svc.streamkeys``. Keep them in sync.
"""

from __future__ import annotations

import re

# MediaMTX path for a Pulse voice channel's HQ stream (mirrors the LiveKit room
# name pattern ``channel-<id>`` used by voice-signaling).
CHANNEL_PATH_PREFIX = "channel-"
CHANNEL_PATH_RE = re.compile(r"^channel-(\d+)$")

# Redis keys.
#   stream:token:<token>            → JSON {channel_id, user_id, scope, protocol, created_at}
#                                     issued by media-svc, TTL = TOKEN_TTL_S, consumed by the hook.
#   stream:active:channel-<id>      → JSON {user_id, started_at}
#                                     written by the hook on a successful publish-auth, TTL self-heal,
#                                     read/refreshed/cleared by media-svc's poller.
#   stream:channel:<id>             → JSON {active: bool, user_id?: str, since?: iso8601}
#                                     the public per-channel stream state, owned by media-svc's poller.
TOKEN_KEY = "stream:token:{token}"
ACTIVE_KEY = "stream:active:channel-{channel_id}"
CHANNEL_STATE_KEY = "stream:channel:{channel_id}"

# Pub/Sub channel — media-svc publishes per-channel stream-state changes here,
# chat-gateway (T5b) subscribes and re-broadcasts. Payload (one event):
#   {"channel_id": "<id>", "active": true|false, "user_id": "<id>"|null}
STREAM_EVENTS_CHANNEL = "stream:events"


def channel_id_from_path(path: str) -> str | None:
    """Return the snowflake channel-id string for a ``channel-<digits>`` path, else None."""
    m = CHANNEL_PATH_RE.match(path or "")
    return m.group(1) if m else None


def path_for_channel(channel_id: str) -> str:
    return f"{CHANNEL_PATH_PREFIX}{channel_id}"
