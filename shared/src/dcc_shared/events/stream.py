"""HQ-stream + watch-party presence events.

Both flow as *bare snapshots* without an ``op`` field — the chat-gateway
listener tags them on the way out (``stream_state`` / ``watch_state``).
"""

from __future__ import annotations

from typing import Any

from dcc_shared.events._base import _EventBase


class StreamDescriptor(_EventBase):
    """One live HQ stream: a ``(user_id, slot)`` pair. ``slot`` is the stable
    per-user stream index (0, 1, …) so one user can run several streams at once
    (e.g. two monitors as separate viewer tiles). Slot 0 == the single-stream
    default.

    ``label`` is an optional human-readable hint (e.g. ``"Monitor 1"``,
    ``"Chrome"``) the streamer sends at start so a viewer facing several of his
    streams can tell them apart in the picker. Omitted on legacy/single-stream
    records and when the streamer's platform can't name the source (Linux
    portal) — clients fall back to a generic ``"Stream N"``."""

    user_id: str
    slot: int = 0
    label: str | None = None


class StreamStateSnapshot(_EventBase):
    """Published by media-svc's reconciliation poller on every
    state change for a channel. The listener wraps as
    ``{"op": "stream_state", "channel_id": ..., "user_ids": [...], "streams": [...]}``.

    ``user_ids`` stays the deduplicated set of streaming users (one entry per
    user) for backward compatibility — old clients render one tile per user.
    ``streams`` is *additive* and only carried when at least one user runs a
    slot ≥ 1 (i.e. has more than one stream); single-stream channels omit it
    entirely, keeping the wire shape byte-identical to the pre-slot format."""

    channel_id: str
    user_ids: list[str]
    streams: list[StreamDescriptor] = []


class WatchStateSnapshot(_EventBase):
    """Published by chat-gateway's own watch-party helpers
    (``watchkeys.write_party`` / ``delete_party``). ``state=None`` ==
    "party stopped". ``party_id`` identifies which of a channel's possibly
    several concurrent parties this snapshot is about. State shape is left as
    a free-form dict — the contents (source descriptor, host_user_id,
    position…) belong to the watch-party feature, not to the schema registry."""

    channel_id: str
    party_id: str
    state: dict[str, Any] | None
