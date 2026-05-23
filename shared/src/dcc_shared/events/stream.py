"""HQ-stream + watch-party presence events.

Both flow as *bare snapshots* without an ``op`` field — the chat-gateway
listener tags them on the way out (``stream_state`` / ``watch_state``).
"""

from __future__ import annotations

from typing import Any

from dcc_shared.events._base import _EventBase


class StreamStateSnapshot(_EventBase):
    """Published by media-svc's reconciliation poller on every
    state change for a channel. The listener wraps as
    ``{"op": "stream_state", "channel_id": ..., "user_ids": [...]}``."""

    channel_id: str
    user_ids: list[str]


class WatchStateSnapshot(_EventBase):
    """Published by chat-gateway's own watch-party helpers
    (``watchkeys.write_state`` / ``delete_state``). ``state=None`` ==
    "party stopped". State shape is left as a free-form dict — the
    contents (source descriptor, host_user_id, position…) belong to
    the watch-party feature, not to the schema registry."""

    channel_id: str
    state: dict[str, Any] | None
