"""Redis key layout + channel↔MediaMTX-path mapping for the HQ-streaming flow.

This is the canonical spelling of the keys shared between ``media-svc`` (writer
of ``stream:channel:*`` + ``stream:token:*``, publisher of ``stream:events``)
and ``mediamtx-auth-hook`` (reader of ``stream:token:*``, writer of
``stream:active:*``). The two services share no code or DB — only these names.
Keep this in sync with ``dcc_mediamtx_auth_hook.shared``.
"""

from __future__ import annotations

import re

CHANNEL_PATH_PREFIX = "channel-"
CHANNEL_PATH_RE = re.compile(r"^channel-(\d+)$")

# stream:token:<token>          → JSON {channel_id, user_id, scope:"publish", protocol, created_at}
#                                 issued by media-svc with TTL = TOKEN_TTL_S, consumed by the hook.
# stream:active:channel-<id>    → JSON {user_id, started_at}
#                                 written by the hook on a successful publish-auth, TTL self-heal,
#                                 read/refreshed/cleared by the media-svc poller.
# stream:channel:<id>           → JSON {active: bool, user_id?: str, since?: iso8601}
#                                 the public per-channel stream state, owned by the poller.
TOKEN_KEY = "stream:token:{token}"
ACTIVE_KEY = "stream:active:channel-{channel_id}"
CHANNEL_STATE_KEY = "stream:channel:{channel_id}"

# Pub/Sub channel — media-svc publishes per-channel stream-state changes here;
# chat-gateway (T5b) subscribes and re-broadcasts. Event payload:
#   {"channel_id": "<id>", "active": true|false, "user_id": "<id>"|null}
STREAM_EVENTS_CHANNEL = "stream:events"


def channel_id_from_path(path: str) -> str | None:
    m = CHANNEL_PATH_RE.match(path or "")
    return m.group(1) if m else None


def path_for_channel(channel_id: str) -> str:
    return f"{CHANNEL_PATH_PREFIX}{channel_id}"
