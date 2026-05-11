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

# Voice-presence events published by the voice-signaling service. Payload:
# {"channel_id": "<id>", "user_ids": ["<id>", ...]} — the *full* current
# member set of that voice channel. We rebroadcast it to every connected
# WebSocket as {"op": "voice_state", ...}; clients filter by their guilds.
VOICE_EVENTS_CHANNEL = "voice:events"


class ConnectionManager:
    def __init__(self, redis: Redis) -> None:
        self._redis = redis
        self._pubsub = redis.pubsub(ignore_subscribe_messages=True)
        self._listener_task: asyncio.Task | None = None
        self._subs: dict[str, set[WebSocket]] = defaultdict(set)
        # Every connected WebSocket, regardless of channel subscriptions —
        # used to fan out global events like voice-presence updates.
        self._connections: set[WebSocket] = set()
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
        # Plus the single voice-presence event channel.
        await self._pubsub.subscribe(VOICE_EVENTS_CHANNEL)
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

    async def register(self, ws: WebSocket) -> None:
        async with self._lock:
            self._connections.add(ws)

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
            self._connections.discard(ws)
            for cid in list(self._subs):
                self._subs[cid].discard(ws)
                if not self._subs[cid]:
                    del self._subs[cid]

    async def publish(self, channel_id: str, payload: dict[str, Any]) -> None:
        await self._redis.publish(
            CHANNEL_KEY.format(channel_id=channel_id),
            json.dumps(payload, separators=(",", ":")),
        )

    async def voice_state_for(self, channel_id: str) -> dict[str, list[str]]:
        """Current presence + streaming sets for a voice channel, read from Redis."""
        key = f"voice:room:channel-{channel_id}"
        sk = f"voice:room:channel-{channel_id}:streaming"
        members = await self._redis.smembers(key)
        streamers = await self._redis.smembers(sk)
        return {
            "user_ids": sorted(m.decode() if isinstance(m, bytes) else m for m in members),
            "streaming_user_ids": sorted(
                m.decode() if isinstance(m, bytes) else m for m in streamers
            ),
        }

    async def voice_states_for(self, channel_ids: list[str]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for cid in channel_ids:
            state = await self.voice_state_for(cid)
            if state["user_ids"] or state["streaming_user_ids"]:
                out.append({"channel_id": cid, **state})
        return out

    # Per-socket send timeout during fan-out: a slow/stuck client must not hold
    # up delivery to everyone else on the channel (head-of-line blocking).
    _SEND_TIMEOUT_SECONDS = 5.0

    async def _fan_out(self, targets: list[WebSocket], envelope: dict) -> None:
        if not targets:
            return

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

    @staticmethod
    def _decode_payload(data: object, where: str) -> Any | None:
        if isinstance(data, (str, bytes)):
            try:
                return json.loads(data)
            except (ValueError, TypeError):
                # A malformed message must not kill the listener (it serves
                # *all* channels). Skip it.
                log.warning("skipping malformed pubsub message on %s", where)
                return None
        return data

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

                if channel == VOICE_EVENTS_CHANNEL:
                    payload = self._decode_payload(msg["data"], VOICE_EVENTS_CHANNEL)
                    if not isinstance(payload, dict) or "channel_id" not in payload:
                        continue
                    envelope = {
                        "op": "voice_state",
                        "channel_id": str(payload.get("channel_id")),
                        "user_ids": [str(u) for u in payload.get("user_ids", [])],
                        "streaming_user_ids": [
                            str(u) for u in payload.get("streaming_user_ids", [])
                        ],
                    }
                    async with self._lock:
                        targets = list(self._connections)
                    await self._fan_out(targets, envelope)
                    continue

                channel_id = channel.split(":")[-1]
                payload = self._decode_payload(msg["data"], channel_id)
                if payload is None:
                    continue
                envelope = {"op": "message", "data": payload}
                async with self._lock:
                    targets = list(self._subs.get(channel_id, ()))
                await self._fan_out(targets, envelope)
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
