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

# Guild-lifecycle events (channel created/updated/deleted, member added).
# Published by the REST routes; each payload is a complete envelope with its
# own `op` field which we forward verbatim to *every* connected WebSocket
# (clients filter by their guild membership). These must NOT travel on
# `chat:channel:<id>` — that channel carries only chat `message` payloads,
# which `_listen` wraps as `{"op": "message", ...}`.
GUILD_EVENTS_CHANNEL = "guild:events"

# Per-channel HQ-stream state changes published by media-svc (T5a/T5b).
# Payload: {"channel_id": "<id>", "active": true|false, "user_id": "<id>"|null}
# — one event per state change. We rebroadcast as {"op": "stream_state", ...}
# to every connected WebSocket; clients filter by their guilds. The mirror of
# the voice-presence mechanism, just for the MediaMTX/GSR HQ stream.
STREAM_EVENTS_CHANNEL = "stream:events"

# Public per-channel stream state, written by the media-svc poller. We read
# these keys directly from Redis when building the `ready` payload / the
# `GET /guilds/{id}/stream-state` re-sync response — the same way voice
# presence is read straight off `voice:room:*`. (media-svc has no guild→channel
# map; chat-gateway does, so it does the per-channel lookup.)
STREAM_CHANNEL_STATE_KEY = "stream:channel:{channel_id}"


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
        # Plus the single voice-presence event channel, the guild-lifecycle
        # event channel, and the HQ-stream-state event channel.
        await self._pubsub.subscribe(
            VOICE_EVENTS_CHANNEL, GUILD_EVENTS_CHANNEL, STREAM_EVENTS_CHANNEL
        )
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

    async def publish_guild_event(self, envelope: dict[str, Any]) -> None:
        """Publish a guild-lifecycle envelope (with its own `op`) for fan-out
        to every connected WebSocket. See ``GUILD_EVENTS_CHANNEL``."""
        await self._redis.publish(
            GUILD_EVENTS_CHANNEL,
            json.dumps(envelope, separators=(",", ":")),
        )

    def listener_alive(self) -> bool:
        """True iff the background listener task is running. The lifespan
        supervisor polls this to restart a crashed manager."""
        return (
            self._started
            and self._listener_task is not None
            and not self._listener_task.done()
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
        if not channel_ids:
            return []
        states = await asyncio.gather(*(self.voice_state_for(cid) for cid in channel_ids))
        out: list[dict[str, Any]] = []
        for cid, state in zip(channel_ids, states):
            if state["user_ids"] or state["streaming_user_ids"]:
                out.append({"channel_id": cid, **state})
        return out

    async def stream_state_for(self, channel_id: str) -> dict[str, Any] | None:
        """Current HQ streamers for a channel, read straight off Redis.

        Returns ``{"channel_id": ..., "user_ids": [...]}`` if anyone is
        streaming, else ``None``. The poller in media-svc owns
        ``stream:channel:<id>`` (→ ``{user_ids: [...], since}``); we only read
        it (mirroring how voice presence reads ``voice:room:*``)."""
        raw = await self._redis.get(STREAM_CHANNEL_STATE_KEY.format(channel_id=channel_id))
        if raw is None:
            return None
        try:
            data = json.loads(raw.decode() if isinstance(raw, bytes) else raw)
        except (ValueError, TypeError, AttributeError):
            return None
        if not isinstance(data, dict):
            return None
        uids = [str(u) for u in (data.get("user_ids") or []) if u]
        if not uids:
            return None
        return {"channel_id": channel_id, "user_ids": uids}

    async def stream_states_for(self, channel_ids: list[str]) -> list[dict[str, Any]]:
        if not channel_ids:
            return []
        states = await asyncio.gather(*(self.stream_state_for(cid) for cid in channel_ids))
        return [s for s in states if s is not None]

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
                        log.warning(
                            "voice:events malformed or missing channel_id: %r", payload
                        )
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
                    log.info(
                        "voice:events broadcast channel=%s user_ids=%s streaming=%s targets=%d",
                        envelope["channel_id"],
                        envelope["user_ids"],
                        envelope["streaming_user_ids"],
                        len(targets),
                    )
                    await self._fan_out(targets, envelope)
                    continue

                if channel == STREAM_EVENTS_CHANNEL:
                    payload = self._decode_payload(msg["data"], STREAM_EVENTS_CHANNEL)
                    if not isinstance(payload, dict) or "channel_id" not in payload:
                        log.warning(
                            "stream:events malformed or missing channel_id: %r", payload
                        )
                        continue
                    envelope = {
                        "op": "stream_state",
                        "channel_id": str(payload.get("channel_id")),
                        "user_ids": [str(u) for u in payload.get("user_ids", [])],
                    }
                    async with self._lock:
                        targets = list(self._connections)
                    log.info(
                        "stream:events broadcast channel=%s user_ids=%s targets=%d",
                        envelope["channel_id"],
                        envelope["user_ids"],
                        len(targets),
                    )
                    await self._fan_out(targets, envelope)
                    continue

                if channel == GUILD_EVENTS_CHANNEL:
                    payload = self._decode_payload(msg["data"], GUILD_EVENTS_CHANNEL)
                    if not isinstance(payload, dict) or "op" not in payload:
                        log.warning("guild:events malformed or missing op: %r", payload)
                        continue
                    async with self._lock:
                        targets = list(self._connections)
                    log.info(
                        "guild:events broadcast op=%s targets=%d", payload.get("op"), len(targets)
                    )
                    await self._fan_out(targets, payload)
                    continue

                channel_id = channel.split(":")[-1]
                payload = self._decode_payload(msg["data"], channel_id)
                if payload is None:
                    continue
                # Publishers may submit either a bare message dict (legacy,
                # auto-wrapped as `op: "message"`) or a full envelope already
                # carrying its own `op` (used for message_update /
                # message_delete / reaction_add / reaction_remove).
                if isinstance(payload, dict) and "op" in payload:
                    envelope = payload
                else:
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
