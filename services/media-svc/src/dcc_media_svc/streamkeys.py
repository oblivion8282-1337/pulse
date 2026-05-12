"""Redis key layout + channel↔MediaMTX-path mapping for the HQ-streaming flow.

Canonical spelling of the keys shared between ``media-svc`` (writer of
``stream:channel:*`` + ``stream:token:*``, publisher of ``stream:events``) and
``mediamtx-auth-hook`` (reader of ``stream:token:*``, writer of
``stream:active:*``). The two services share no code or DB — only these names.
Keep this in sync with ``dcc_mediamtx_auth_hook.shared``.

Streams are per *(channel, user)*: the MediaMTX path is
``channel-<channel_id>-<user_id>``, so several people can stream into the same
voice channel at once (each gets their own path / WHEP URL).
"""

from __future__ import annotations

import re

CHANNEL_PATH_PREFIX = "channel-"
# channel-<channel_id>-<user_id>  (both snowflakes, all digits)
CHANNEL_USER_PATH_RE = re.compile(r"^channel-(\d+)-(\d+)$")

# stream:token:<token>                → JSON {channel_id, user_id, scope:"publish", protocol, created_at}
#                                       issued by media-svc with TTL = TOKEN_TTL_S, consumed by the hook.
# stream:active:channel-<cid>-<uid>   → JSON {user_id, started_at}
#                                       written by the hook on a successful publish-auth, TTL self-heal.
# stream:channel:<cid>                → JSON {user_ids: [str, ...], since: iso8601}
#                                       the public per-channel set of HQ streamers, owned by the poller.
TOKEN_KEY = "stream:token:{token}"
ACTIVE_KEY = "stream:active:channel-{channel_id}-{user_id}"
ACTIVE_SCAN_FOR_CHANNEL = "stream:active:channel-{channel_id}-*"
CHANNEL_STATE_KEY = "stream:channel:{channel_id}"

# Pub/Sub channel — media-svc publishes per-channel stream-state changes here;
# chat-gateway subscribes and re-broadcasts. Event payload (the *full* current
# set after the change): {"channel_id": "<id>", "user_ids": ["<id>", ...]}.
STREAM_EVENTS_CHANNEL = "stream:events"


def parse_channel_user_path(path: str) -> tuple[str, str] | None:
    """``channel-<cid>-<uid>`` → ``(cid, uid)`` as strings, else ``None``."""
    m = CHANNEL_USER_PATH_RE.match(path or "")
    return (m.group(1), m.group(2)) if m else None


def path_for_channel_user(channel_id: str, user_id: str) -> str:
    return f"{CHANNEL_PATH_PREFIX}{channel_id}-{user_id}"
