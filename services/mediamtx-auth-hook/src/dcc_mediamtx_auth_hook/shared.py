"""Constants shared with media-svc (Redis key layout, channel-path mapping).

These two services do **not** share code or a DB — they only meet on a handful
of Redis keys. This module is the single place those names are spelled, copied
verbatim from ``dcc_media_svc.streamkeys``. Keep them in sync.

Streams are per *(channel, user, session-nonce)*: the MediaMTX path is
``channel-<channel_id>-<user_id>-<nonce>`` (nonce = 32 hex from
``secrets.token_hex(16)``) so every publish gets a fresh path, avoiding the
MediaMTX-1.17.1 ICE-race on rapid republish of the same path. See
``dcc_media_svc.streamkeys`` for the full rationale.
"""

from __future__ import annotations

import re

CHANNEL_PATH_PREFIX = "channel-"
# channel-<channel_id>-<user_id>-<nonce>
#   cid + uid are snowflakes (all digits), nonce is 32 lowercase hex.
CHANNEL_USER_PATH_RE = re.compile(r"^channel-(\d+)-(\d+)-([0-9a-f]{32})$")

# Redis keys (see dcc_media_svc.streamkeys for the authoritative comments).
#   stream:token:<token>              → JSON {channel_id, user_id, nonce, scope, protocol, created_at}
#   stream:active:channel-<cid>-<uid> → JSON {user_id, started_at, path}  (written here on publish-auth)
#   stream:channel:<cid>              → JSON {user_ids: [...], since: iso8601}  (owned by media-svc's poller)
TOKEN_KEY = "stream:token:{token}"
ACTIVE_KEY = "stream:active:channel-{channel_id}-{user_id}"
CHANNEL_STATE_KEY = "stream:channel:{channel_id}"

# Pub/Sub channel — media-svc publishes per-channel stream-state changes here,
# chat-gateway subscribes and re-broadcasts. Payload (full set after the change):
#   {"channel_id": "<id>", "user_ids": ["<id>", ...]}
STREAM_EVENTS_CHANNEL = "stream:events"


def parse_channel_user_path(path: str) -> tuple[str, str, str] | None:
    """``channel-<cid>-<uid>-<nonce>`` → ``(cid, uid, nonce)`` as strings, else ``None``."""
    m = CHANNEL_USER_PATH_RE.match(path or "")
    return (m.group(1), m.group(2), m.group(3)) if m else None
