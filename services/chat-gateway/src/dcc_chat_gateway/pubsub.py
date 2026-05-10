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
        if self._started:
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
                payload = json.loads(data) if isinstance(data, (str, bytes)) else data
                envelope = {"op": "message", "data": payload}
                async with self._lock:
                    targets = list(self._subs.get(channel_id, ()))
                dead: list[WebSocket] = []
                for ws in targets:
                    try:
                        await ws.send_json(envelope)
                    except Exception:  # noqa: BLE001
                        dead.append(ws)
                for ws in dead:
                    await self.remove_socket(ws)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.exception("pubsub listener crashed")
            raise
