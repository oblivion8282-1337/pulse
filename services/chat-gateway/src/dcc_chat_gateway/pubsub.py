"""Redis pub/sub fan-out for WebSocket clients.

Each chat-gateway instance keeps a single Redis pub/sub subscription and
maintains a per-channel set of local WebSocket connections. When a message
arrives on `chat:channel:<id>`, it is forwarded to every locally-subscribed
WebSocket. Outgoing messages from a client are published once to Redis so
every gateway instance fans them out in lockstep.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections import defaultdict
from typing import Any

from fastapi import WebSocket
from redis.asyncio import Redis

log = logging.getLogger(__name__)

CHANNEL_KEY = "chat:channel:{channel_id}"
CHANNEL_PATTERN = "chat:channel:*"


class ConnectionManager:
    def __init__(self, redis: Redis) -> None:
        self._redis = redis
        self._pubsub = redis.pubsub(ignore_subscribe_messages=True)
        self._listener_task: asyncio.Task | None = None
        self._subs: dict[str, set[WebSocket]] = defaultdict(set)
        self._lock = asyncio.Lock()
        self._started = False

    async def start(self) -> None:
        # `_started` may be False either because we never started, or because a
        # previous listener task died and reset it (see `_listen`). In both
        # cases we (re)subscribe and spawn a fresh listener — this is what makes
        # the manager self-heal after a fatal listener error.
        if self._started and self._listener_task is not None and not self._listener_task.done():
            return
        # One pattern subscription covers all channels. Avoids subscribe()
        # races against the listener loop and removes the need for
        # per-channel Redis subscriptions.
        await self._pubsub.psubscribe(CHANNEL_PATTERN)
        self._listener_task = asyncio.create_task(self._listen(), name="dcc-chat-pubsub")
        self._started = True

    async def stop(self) -> None:
        if self._listener_task is not None:
            self._listener_task.cancel()
            try:
                await self._listener_task
            except (asyncio.CancelledError, Exception):
                pass
            self._listener_task = None
        try:
            await self._pubsub.aclose()
        except Exception:  # noqa: BLE001
            pass
        self._started = False

    async def subscribe(self, ws: WebSocket, channel_id: str) -> None:
        async with self._lock:
            self._subs[channel_id].add(ws)

    async def unsubscribe(self, ws: WebSocket, channel_id: str) -> None:
        async with self._lock:
            local = self._subs.get(channel_id)
            if local is None:
                return
            local.discard(ws)
            if not local:
                del self._subs[channel_id]

    async def remove_socket(self, ws: WebSocket) -> None:
        async with self._lock:
            for cid in list(self._subs):
                self._subs[cid].discard(ws)
                if not self._subs[cid]:
                    del self._subs[cid]

    async def publish(self, channel_id: str, payload: dict[str, Any]) -> None:
        await self._redis.publish(
            CHANNEL_KEY.format(channel_id=channel_id),
            json.dumps(payload, separators=(",", ":")),
        )

    # Per-socket send timeout during fan-out: a slow/stuck client must not hold
    # up delivery to everyone else on the channel (head-of-line blocking).
    _SEND_TIMEOUT_SECONDS = 5.0

    async def _listen(self) -> None:
        try:
            while True:
                msg = await self._pubsub.get_message(
                    ignore_subscribe_messages=True, timeout=1.0
                )
                if msg is None:
                    continue
                if msg.get("type") not in ("message", "pmessage"):
                    continue
                channel = msg.get("channel")
                if isinstance(channel, bytes):
                    channel = channel.decode()
                channel_id = channel.split(":")[-1]
                data = msg["data"]
                if isinstance(data, (str, bytes)):
                    try:
                        payload = json.loads(data)
                    except (ValueError, TypeError):
                        # A malformed message on the bus must not kill the
                        # listener (which serves *all* channels). Skip it.
                        log.warning("skipping malformed pubsub message on %s", channel_id)
                        continue
                else:
                    payload = data
                envelope = {"op": "message", "data": payload}
                async with self._lock:
                    targets = list(self._subs.get(channel_id, ()))
                if not targets:
                    continue

                async def _send(ws: WebSocket, env: dict = envelope) -> WebSocket | None:
                    try:
                        await asyncio.wait_for(
                            ws.send_json(env), timeout=self._SEND_TIMEOUT_SECONDS
                        )
                        return None
                    except Exception:  # noqa: BLE001 — timeout, closed socket, etc.
                        return ws

                results = await asyncio.gather(
                    *(_send(ws) for ws in targets), return_exceptions=True
                )
                for r in results:
                    if isinstance(r, WebSocket):
                        await self.remove_socket(r)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            # A fatal error here would otherwise leave `_started = True` with a
            # dead task — no further `start()` would do anything. Reset the flag
            # so the next `start()` (e.g. a health-check-triggered restart, or a
            # fresh request path that calls start()) can bring it back.
            log.exception("pubsub listener crashed; flagging for restart")
            self._started = False
            raise
