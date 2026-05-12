"""Constants shared with media-svc (Redis key layout, channel-path mapping).

These two services do **not** share code or a DB — they only meet on a handful
of Redis keys. This module is the single place those names are spelled, copied
verbatim from ``dcc_media_svc.streamkeys``. Keep them in sync.

Streams are per *(channel, user)*: the MediaMTX path is
``channel-<channel_id>-<user_id>`` so several people can stream into the same
voice channel at once.
"""

from __future__ import annotations

import re

CHANNEL_PATH_PREFIX = "channel-"
# channel-<channel_id>-<user_id>  (both snowflakes, all digits)
CHANNEL_USER_PATH_RE = re.compile(r"^channel-(\d+)-(\d+)$")

# Redis keys (see dcc_media_svc.streamkeys for the authoritative comments).
#   stream:token:<token>              → JSON {channel_id, user_id, scope, protocol, created_at}
#   stream:active:channel-<cid>-<uid> → JSON {user_id, started_at}  (written here on publish-auth)
#   stream:channel:<cid>              → JSON {user_ids: [...], since: iso8601}  (owned by media-svc's poller)
TOKEN_KEY = "stream:token:{token}"
ACTIVE_KEY = "stream:active:channel-{channel_id}-{user_id}"
CHANNEL_STATE_KEY = "stream:channel:{channel_id}"

# Pub/Sub channel — media-svc publishes per-channel stream-state changes here,
# chat-gateway subscribes and re-broadcasts. Payload (full set after the change):
#   {"channel_id": "<id>", "user_ids": ["<id>", ...]}
STREAM_EVENTS_CHANNEL = "stream:events"


def parse_channel_user_path(path: str) -> tuple[str, str] | None:
    """``channel-<cid>-<uid>`` → ``(cid, uid)`` as strings, else ``None``."""
    m = CHANNEL_USER_PATH_RE.match(path or "")
    return (m.group(1), m.group(2)) if m else None
