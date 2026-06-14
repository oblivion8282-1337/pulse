"""In-process watch-party watcher registry (ConnectionManager mixin).

Tracks which users currently have a watch-party tile mounted, per *party*
(keyed by ``(channel_id, party_id)`` so several concurrent parties in one voice
channel stay independent). Single writer (the gateway itself) → no Redis, no
TTL: this state is only consulted at the moment a host departs, always on the
pod the departing socket lives on. Mirrors the per-socket ``hosted_parties``
pattern.

User-granularity with a socket ref-set so multi-tab is correct: a user stays
a watcher until their *last* socket leaves, and ``joined_at`` is the earliest
join (never reset on a later tab) so promotion order is stable.

Cross-pod is intentionally unsupported — the whole watch-party transport is
single-pod today.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any

from dcc_chat_gateway import watchkeys


def _now_ms() -> int:
    return int(time.time() * 1000)


@dataclass
class _WatcherEntry:
    joined_at: int
    sockets: set[Any] = field(default_factory=set)


class _WatchRegistryMixin:
    """Adds the watcher registry to ConnectionManager. Requires ``self._lock``
    (asyncio.Lock) on the host class. Call ``_init_watch_registry()`` once in
    the host ``__init__``. Keyed by ``(channel_id, party_id)`` throughout."""

    _watchers: dict[tuple[str, str], dict[str, _WatcherEntry]]
    _watch_end_timers: dict[tuple[str, str], tuple[str, "asyncio.Task[Any]"]]

    def _init_watch_registry(self) -> None:
        self._watchers = {}
        self._watch_end_timers = {}

    async def watch_join(
        self,
        channel_id: str,
        party_id: str,
        user_id: str,
        websocket: Any,
        *,
        now_ms: int | None = None,
    ) -> None:
        ts = now_ms if now_ms is not None else _now_ms()
        key = (channel_id, party_id)
        async with self._lock:
            chan = self._watchers.setdefault(key, {})
            entry = chan.get(user_id)
            if entry is None:
                entry = _WatcherEntry(joined_at=ts)
                chan[user_id] = entry
            entry.sockets.add(websocket)
        # Host returned within the grace window → cancel the pending party-end.
        self.cancel_host_end(channel_id, party_id, host_uid=user_id)

    async def watch_leave(
        self, channel_id: str, party_id: str, user_id: str, websocket: Any
    ) -> bool:
        """Remove one socket. Returns True iff the user fully left the party
        (no sockets remain)."""
        key = (channel_id, party_id)
        async with self._lock:
            chan = self._watchers.get(key)
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
                del self._watchers[key]
            return True

    async def next_host(self, channel_id: str, party_id: str, exclude_uid: str) -> str | None:
        """Oldest watcher (smallest joined_at) other than ``exclude_uid``."""
        async with self._lock:
            chan = self._watchers.get((channel_id, party_id))
            if not chan:
                return None
            best: tuple[int, str] | None = None
            for uid, entry in chan.items():
                if uid == exclude_uid:
                    continue
                if best is None or entry.joined_at < best[0]:
                    best = (entry.joined_at, uid)
            return best[1] if best else None

    def schedule_host_end(
        self, redis, channel_id: str, party_id: str, host_uid: str, *, delay: float | None = None
    ) -> None:
        """Host fully left via a connection drop. Schedule the party to end
        after a grace window unless the host reconnects (rejoins as a watcher)
        in time. Idempotent per party — replaces any pending timer."""
        if delay is None:
            delay = watchkeys.WATCH_HOST_GRACE_S
        self.cancel_host_end(channel_id, party_id)
        task = asyncio.create_task(
            self._host_end_after_grace(redis, channel_id, party_id, str(host_uid), delay)
        )
        self._watch_end_timers[(channel_id, party_id)] = (str(host_uid), task)

    def cancel_host_end(
        self, channel_id: str, party_id: str, *, host_uid: str | None = None
    ) -> None:
        """Cancel a pending grace timer. With ``host_uid`` only cancel when the
        timer is for that host (used on the host's own reconnect)."""
        key = (channel_id, party_id)
        entry = self._watch_end_timers.get(key)
        if entry is None:
            return
        if host_uid is not None and entry[0] != str(host_uid):
            return
        entry[1].cancel()
        self._watch_end_timers.pop(key, None)

    async def _host_end_after_grace(
        self, redis, channel_id: str, party_id: str, host_uid: str, delay: float
    ) -> None:
        key = (channel_id, party_id)
        try:
            await asyncio.sleep(delay)
            async with self._lock:
                chan = self._watchers.get(key)
                if chan and host_uid in chan:
                    return  # host reconnected within the grace window
            state = await watchkeys.read_party(redis, channel_id, party_id)
            if state is None or str(state.get("host_user_id")) != host_uid:
                return  # already ended or host changed (explicit handoff)
            await watchkeys.delete_party(redis, channel_id, party_id)
        finally:
            entry = self._watch_end_timers.get(key)
            if entry is not None and entry[1] is asyncio.current_task():
                self._watch_end_timers.pop(key, None)

    async def watchers(self, channel_id: str, party_id: str) -> list[str]:
        """All user ids currently watching this party (unordered snapshot)."""
        async with self._lock:
            chan = self._watchers.get((channel_id, party_id))
            return list(chan.keys()) if chan else []

    async def broadcast_watchers(self, channel_id: str, party_id: str) -> None:
        """Push the current watcher user-id list to everyone who can VIEW the
        channel. Direct in-process fan-out (no Redis) — consistent with the
        in-process registry. Safe to call after every join/leave."""
        user_ids = await self.watchers(channel_id, party_id)
        async with self._lock:
            raw_targets = list(self._connections)
        targets = await self._filter_by_view_channel(raw_targets, channel_id)
        envelope = {
            "op": "watch_watchers",
            "channel_id": channel_id,
            "party_id": party_id,
            "user_ids": user_ids,
        }
        await self._fan_out(targets, envelope)
