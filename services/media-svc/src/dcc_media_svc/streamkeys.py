"""Redis key layout + channel↔MediaMTX-path mapping for the HQ-streaming flow.

Canonical spelling of the keys shared between ``media-svc`` (writer of
``stream:channel:*`` + ``stream:token:*``, publisher of ``stream:events``) and
``mediamtx-auth-hook`` (reader of ``stream:token:*``, writer of
``stream:active:*``). The two services share no code or DB — only these names.
Keep this in sync with ``dcc_mediamtx_auth_hook.shared``.

Streams are per *(channel, user, session-nonce)*: the MediaMTX path is
``channel-<channel_id>-<user_id>-<nonce>`` (nonce = 32 hex chars from
``secrets.token_hex(16)``, fresh per stream-token issue). The nonce gives every
publish a brand-new MediaMTX path so we side-step the WebRTC ICE-race that
MediaMTX 1.17.1 hits when the *same* path is republished within a few seconds
("deadline exceeded while waiting connection"; root cause is upstream in
pion/ice and fixed in v4.2.5 = MediaMTX 1.18+, which Pulse can't take yet
because of [[mediamtx-1-17-pinned]]). Several people can still stream into the
same voice channel at once — they have different ``user_id`` values and so
disjoint paths regardless of nonce.
"""

from __future__ import annotations

import re

CHANNEL_PATH_PREFIX = "channel-"
# channel-<channel_id>-<user_id>-<nonce>
#   cid + uid are snowflakes (all digits), nonce is 32 lowercase hex.
CHANNEL_USER_PATH_RE = re.compile(r"^channel-(\d+)-(\d+)-([0-9a-f]{32})$")

# stream:token:<token>                → JSON {channel_id, user_id, nonce, scope:"publish", protocol, created_at}
#                                       issued by media-svc with TTL = TOKEN_TTL_S, consumed by the hook.
# stream:active:channel-<cid>-<uid>   → JSON {user_id, started_at, path}
#                                       written by the hook on a successful publish-auth (path carries the
#                                       nonce so viewers can locate the live MediaMTX path). TTL self-heal.
# stream:channel:<cid>                → JSON {user_ids: [str, ...], since: iso8601}
#                                       the public per-channel set of HQ streamers, owned by the poller.
TOKEN_KEY = "stream:token:{token}"
ACTIVE_KEY = "stream:active:channel-{channel_id}-{user_id}"
CHANNEL_STATE_KEY = "stream:channel:{channel_id}"

# Pub/Sub channel — media-svc publishes per-channel stream-state changes here;
# chat-gateway subscribes and re-broadcasts. Event payload (the *full* current
# set after the change): {"channel_id": "<id>", "user_ids": ["<id>", ...]}.
STREAM_EVENTS_CHANNEL = "stream:events"


def parse_channel_user_path(path: str) -> tuple[str, str, str] | None:
    """``channel-<cid>-<uid>-<nonce>`` → ``(cid, uid, nonce)`` as strings, else ``None``."""
    m = CHANNEL_USER_PATH_RE.match(path or "")
    return (m.group(1), m.group(2), m.group(3)) if m else None


def path_for_channel_user(channel_id: str, user_id: str, nonce: str) -> str:
    return f"{CHANNEL_PATH_PREFIX}{channel_id}-{user_id}-{nonce}"
