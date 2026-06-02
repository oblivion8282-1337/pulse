"""In-process watch-party watcher registry (ConnectionManager mixin).

Tracks which users currently have a watch-party tile mounted, per voice
channel. Single writer (the gateway itself) → no Redis, no TTL: this state
is only consulted at the moment a host departs, always on the pod the
departing socket lives on. Mirrors the per-socket ``hosted_parties`` pattern.

User-granularity with a socket ref-set so multi-tab is correct: a user stays
a watcher until their *last* socket leaves, and ``joined_at`` is the earliest
join (never reset on a later tab) so promotion order is stable.

Cross-pod is intentionally unsupported — the whole watch-party transport is
single-pod today.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any


def _now_ms() -> int:
    return int(time.time() * 1000)


@dataclass
class _WatcherEntry:
    joined_at: int
    sockets: set[Any] = field(default_factory=set)


class _WatchRegistryMixin:
    """Adds the watcher registry to ConnectionManager. Requires ``self._lock``
    (asyncio.Lock) on the host class. Call ``_init_watch_registry()`` once in
    the host ``__init__``."""

    _watchers: dict[str, dict[str, _WatcherEntry]]

    def _init_watch_registry(self) -> None:
        self._watchers = {}

    async def watch_join(
        self, channel_id: str, user_id: str, websocket: Any, *, now_ms: int | None = None
    ) -> None:
        ts = now_ms if now_ms is not None else _now_ms()
        async with self._lock:
            chan = self._watchers.setdefault(channel_id, {})
            entry = chan.get(user_id)
            if entry is None:
                entry = _WatcherEntry(joined_at=ts)
                chan[user_id] = entry
            entry.sockets.add(websocket)

    async def watch_leave(self, channel_id: str, user_id: str, websocket: Any) -> bool:
        """Remove one socket. Returns True iff the user fully left the channel
        (no sockets remain)."""
        async with self._lock:
            chan = self._watchers.get(channel_id)
            if chan is None:
                return False
            entry = chan.get(user_id)
            if entry is None:
                return False
            entry.sockets.discard(websocket)
            if entry.sockets:
                return False
            del chan[user_id]
            if not chan:
                del self._watchers[channel_id]
            return True

    async def next_host(self, channel_id: str, exclude_uid: str) -> str | None:
        """Oldest watcher (smallest joined_at) other than ``exclude_uid``."""
        async with self._lock:
            chan = self._watchers.get(channel_id)
            if not chan:
                return None
            best: tuple[int, str] | None = None
            for uid, entry in chan.items():
                if uid == exclude_uid:
                    continue
                if best is None or entry.joined_at < best[0]:
                    best = (entry.joined_at, uid)
            return best[1] if best else None

    async def watchers(self, channel_id: str) -> list[str]:
        """All user ids currently watching this channel (unordered snapshot)."""
        async with self._lock:
            chan = self._watchers.get(channel_id)
            return list(chan.keys()) if chan else []

    async def broadcast_watchers(self, channel_id: str) -> None:
        """Push the current watcher user-id list to everyone who can VIEW the
        channel. Direct in-process fan-out (no Redis) — consistent with the
        in-process registry. Safe to call after every join/leave."""
        user_ids = await self.watchers(channel_id)
        async with self._lock:
            raw_targets = list(self._connections)
        targets = await self._filter_by_view_channel(raw_targets, channel_id)
        envelope = {
            "op": "watch_watchers",
            "channel_id": channel_id,
            "user_ids": user_ids,
        }
        await self._fan_out(targets, envelope)
