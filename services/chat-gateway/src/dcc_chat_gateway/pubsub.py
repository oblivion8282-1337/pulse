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
from collections.abc import Iterable
from typing import Any

from fastapi import WebSocket
from redis.asyncio import Redis

from dcc_chat_gateway.security import AuthenticatedUser
from dcc_chat_gateway.watchkeys import WATCH_EVENTS_CHANNEL, read_states_for
from dcc_shared.permission_resolver import has_permission
from dcc_shared.permissions import Permissions

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

# Per-user self-reported voice state (mic_muted / deafened). Written by the
# WS `voice_self_state` op (chat-gateway owns this key — voice-signaling never
# touches it). Absent key == both flags false. TTL matches voice-presence's
# 6h self-heal window; cleared explicitly on disconnect.
VOICE_USER_STATE_KEY = "voice:user_state:{user_id}"
VOICE_USER_STATE_TTL_SECONDS = 6 * 3600


class ConnectionManager:
    # Max parallel WebSocket connections per user. Each connection multiplies
    # the fan-out cost of every pub/sub event; a single user with N sockets
    # turns one event into N `send_json` calls (with 5s timeouts each).
    MAX_CONNECTIONS_PER_USER = 10

    def __init__(self, redis: Redis) -> None:
        self._redis = redis
        self._pubsub = redis.pubsub(ignore_subscribe_messages=True)
        self._listener_task: asyncio.Task | None = None
        # Async sessionmaker injected by the lifespan/setup code so the
        # permission filter can resolve channel perms during broadcast.
        # When None the filter falls through to "broadcast to all" — same
        # behaviour as before Phase 3, but only safe in tests that
        # explicitly want it.
        self._session_factory = None
        self._subs: dict[str, set[WebSocket]] = defaultdict(set)
        # Every connected WebSocket, regardless of channel subscriptions —
        # used to fan out global events like voice-presence updates.
        self._connections: set[WebSocket] = set()
        # user_id → set of that user's open sockets. Used to cap one user's
        # concurrent connections (DoS mitigation).
        self._user_conns: dict[int, set[WebSocket]] = defaultdict(set)
        self._ws_user: dict[WebSocket, AuthenticatedUser] = {}
        # Per-socket, per-channel cached resolved-permission bitfield. Filled
        # lazily by ``_resolve_channel_perms``; invalidated on relevant
        # guild:events (role mutations, member-role assignments, channel
        # permission overwrites). Avoids three DB lookups per recipient per
        # broadcasted message.
        # IMPORTANT: plain dict (not defaultdict) — a defaultdict here would
        # silently resurrect entries for sockets already removed via
        # ``remove_socket`` (every read of ``_ws_perms[ws]`` inserts {}), which
        # is a slow memory leak. Writers must guard with ``ws in self._ws_user``
        # or use ``.get(ws)`` for reads.
        self._ws_perms: dict[WebSocket, dict[int, int]] = {}
        # Per-socket set of guild ids the user is a member of. Populated by
        # ``register`` (called from the WS endpoint with the same guild list
        # the ``ready`` frame is built from) and live-updated from
        # ``guild_member_added`` / ``guild_deleted`` events in ``_listen``.
        # Used by ``_invalidate_for_guild`` to pinpoint affected sockets so a
        # role mutation on Server X doesn't cold-bust caches for users only in
        # Servers A, B, C. Same resurrection-via-defaultdict rule as
        # ``_ws_perms`` — plain dict, writers guard with ``ws in self._ws_user``.
        self._ws_guilds: dict[WebSocket, set[int]] = {}
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
        # event channel, the HQ-stream-state event channel, and the watch-party
        # event channel.
        await self._pubsub.subscribe(
            VOICE_EVENTS_CHANNEL,
            GUILD_EVENTS_CHANNEL,
            STREAM_EVENTS_CHANNEL,
            WATCH_EVENTS_CHANNEL,
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

    async def register(
        self,
        ws: WebSocket,
        user: AuthenticatedUser,
        guild_ids: Iterable[int] = (),
    ) -> bool:
        """Add ``ws`` to the connection set. Returns False when the user
        already has ``MAX_CONNECTIONS_PER_USER`` open sockets — the caller
        must close the websocket in that case.

        Storing the full ``AuthenticatedUser`` (rather than just the id)
        keeps the ``is_admin`` flag available for permission resolution
        during broadcast filtering — re-decoding the JWT per event would
        be wasteful and re-fetching the user from auth-svc is impossible
        once the bearer is consumed.

        ``guild_ids`` is the set of guilds the user is a member of at the
        moment the WS endpoint accepts the connection (the same list the
        ``ready`` frame is built from). Used by ``_invalidate_for_guild`` to
        pinpoint which sockets to bust — a role mutation on Server X must not
        cold-clear caches for users only in Servers A, B, C."""
        async with self._lock:
            user_set = self._user_conns[user.id]
            if len(user_set) >= self.MAX_CONNECTIONS_PER_USER:
                return False
            user_set.add(ws)
            self._ws_user[ws] = user
            self._connections.add(ws)
            self._ws_guilds[ws] = {int(g) for g in guild_ids}
            return True

    async def set_guild_membership(
        self, ws: WebSocket, guild_ids: Iterable[int]
    ) -> None:
        """Populate / replace this socket's tracked guild-membership set.
        Used by the WS endpoint right after ``register`` so the ``ready``
        frame's already-fetched guild list feeds straight into the precise
        invalidation path. No-op for sockets that have been removed."""
        async with self._lock:
            if ws not in self._ws_user:
                return
            self._ws_guilds[ws] = {int(g) for g in guild_ids}

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
            user = self._ws_user.pop(ws, None)
            if user is not None:
                self._user_conns[user.id].discard(ws)
                if not self._user_conns[user.id]:
                    del self._user_conns[user.id]
            self._ws_perms.pop(ws, None)
            self._ws_guilds.pop(ws, None)
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

    async def voice_state_for(self, channel_id: str) -> dict[str, Any]:
        """Current presence + streaming sets + per-user states for a voice channel."""
        key = f"voice:room:channel-{channel_id}"
        sk = f"voice:room:channel-{channel_id}:streaming"
        members = await self._redis.smembers(key)
        streamers = await self._redis.smembers(sk)
        user_ids = sorted(m.decode() if isinstance(m, bytes) else m for m in members)
        user_states = await self.user_voice_states_for(user_ids)
        return {
            "user_ids": user_ids,
            "streaming_user_ids": sorted(
                m.decode() if isinstance(m, bytes) else m for m in streamers
            ),
            "user_states": user_states,
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

    async def user_voice_states_for(self, user_ids: list[str]) -> dict[str, dict[str, bool]]:
        """Read per-user mute/deafen state for the given user_ids. Missing keys
        are omitted — clients treat absence as ``{mic_muted: false, deafened: false}``."""
        if not user_ids:
            return {}
        keys = [VOICE_USER_STATE_KEY.format(user_id=u) for u in user_ids]
        raws = await self._redis.mget(*keys)
        out: dict[str, dict[str, bool]] = {}
        for uid, raw in zip(user_ids, raws):
            if raw is None:
                continue
            try:
                data = json.loads(raw.decode() if isinstance(raw, bytes) else raw)
            except (ValueError, TypeError):
                continue
            if not isinstance(data, dict):
                continue
            mic_muted = bool(data.get("mic_muted"))
            deafened = bool(data.get("deafened"))
            if mic_muted or deafened:
                out[uid] = {"mic_muted": mic_muted, "deafened": deafened}
        return out

    async def set_user_voice_state(
        self,
        user_id: str,
        mic_muted: bool,
        deafened: bool,
        channel_id: str | None,
    ) -> None:
        """Persist a user's mute/deafen state and republish the affected
        channel's snapshot so all clients re-render. When both flags are False
        we drop the key (absence == default-off, keeps Redis tidy)."""
        key = VOICE_USER_STATE_KEY.format(user_id=user_id)
        if mic_muted or deafened:
            await self._redis.set(
                key,
                json.dumps({"mic_muted": mic_muted, "deafened": deafened}),
                ex=VOICE_USER_STATE_TTL_SECONDS,
            )
        else:
            await self._redis.delete(key)
        if channel_id is not None:
            await self._republish_voice_channel(channel_id)

    async def clear_user_voice_state(self, user_id: str, channel_id: str | None = None) -> None:
        await self._redis.delete(VOICE_USER_STATE_KEY.format(user_id=user_id))
        if channel_id is not None:
            await self._republish_voice_channel(channel_id)

    async def _republish_voice_channel(self, channel_id: str) -> None:
        """Publish a fresh voice:events snapshot for the given channel. Used
        after writing per-user state — voice-signaling owns membership-driven
        publishes; we own state-driven ones."""
        state = await self.voice_state_for(channel_id)
        await self._redis.publish(
            VOICE_EVENTS_CHANNEL,
            json.dumps({"channel_id": channel_id, **state}, separators=(",", ":")),
        )

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

    async def watch_states_for(self, channel_ids: list[str]) -> list[dict[str, Any]]:
        """Active watch parties for the given voice channels. Returns
        ``[{"channel_id": ..., "state": {...}}, ...]``; channels without an
        active party are omitted. See ``watchkeys.py`` for the state shape."""
        return await read_states_for(self._redis, channel_ids)

    # ----- Permission cache + visibility filter -----------------------------

    def set_session_factory(self, factory) -> None:
        """Wire the SQLAlchemy sessionmaker the permission filter should
        use. The lifespan in ``app.py`` calls this with the production
        ``SessionLocal``; tests use whichever factory their fixture
        produced. When unset, the filter falls through (broadcast-to-all),
        which preserves pre-Phase-3 behaviour for any caller that hasn't
        wired it up."""
        self._session_factory = factory

    async def _resolve_channel_perms(self, ws: WebSocket, channel_id: int) -> int:
        """Return the cached or freshly-resolved channel permission bitfield
        for ``ws``'s user. Returns ``-1`` when no session factory is
        available (caller falls through to allow). Returns 0 on a real
        zero-perm result."""
        if self._session_factory is None:
            return -1
        # Don't write into _ws_perms for sockets we don't know about — that
        # would leak entries past remove_socket().
        user = self._ws_user.get(ws)
        if user is None:
            return 0
        cache = self._ws_perms.get(ws)
        if cache is not None:
            cached = cache.get(channel_id)
            if cached is not None:
                return cached
        from dcc_chat_gateway.models import Channel
        from dcc_chat_gateway.permissions import resolve_permissions

        async with self._session_factory() as session:
            channel = await session.get(Channel, channel_id)
            if channel is None:
                # Re-check the socket is still registered before caching — it
                # could have been removed while we were awaiting the DB call.
                if ws in self._ws_user:
                    self._ws_perms.setdefault(ws, {})[channel_id] = 0
                return 0
            value = await resolve_permissions(
                session, user, channel.guild_id, channel_id=channel_id
            )
        if ws in self._ws_user:
            self._ws_perms.setdefault(ws, {})[channel_id] = value
        return value

    async def can_view_channel(self, ws: WebSocket, channel_id: int) -> bool:
        """Predicate over the resolved cache. Used by the broadcast filter
        to drop targets without ``VIEW_CHANNEL`` for ``channel_id``.
        Returns True when no session factory is wired up (filter off)."""
        value = await self._resolve_channel_perms(ws, channel_id)
        if value < 0:
            return True
        return has_permission(value, Permissions.VIEW_CHANNEL)

    def _invalidate_for_guild(self, guild_id: int) -> None:
        """Drop cache entries that may have changed because of a guild-wide
        role mutation. Precise: only sockets whose user is a member of
        ``guild_id`` are affected (tracked in ``_ws_guilds``, populated at
        ``register`` time + live-updated on ``guild_member_added`` /
        ``guild_deleted`` in ``_listen``). The cache warms back up on the
        next message-send."""
        for ws, guilds in list(self._ws_guilds.items()):
            if guild_id in guilds:
                cache = self._ws_perms.get(ws)
                if cache is not None:
                    cache.clear()

    def _invalidate_for_channel(self, channel_id: int) -> None:
        for cache in self._ws_perms.values():
            cache.pop(channel_id, None)

    def _invalidate_for_member(self, user_id: int) -> None:
        for ws, user in list(self._ws_user.items()):
            if user.id == user_id:
                cache = self._ws_perms.get(ws)
                if cache is not None:
                    cache.clear()

    def _apply_guild_membership_update(self, payload: dict) -> None:
        """Live-update ``_ws_guilds`` from guild-lifecycle events so the
        precise invalidation in ``_invalidate_for_guild`` stays correct as
        users join / get kicked / guilds disappear.

        Handled:
          * ``guild_member_added`` where ``user_id == ws.user.id`` → add
            ``guild_id`` to that socket's set.
          * ``guild_member_removed`` where ``user_id == ws.user.id`` → drop
            ``guild_id`` from that socket's set.
          * ``guild_deleted`` → drop ``guild_id`` from every socket's set."""
        op = payload.get("op")
        if op in ("guild_member_added", "guild_member_removed"):
            try:
                gid = int(payload.get("guild_id", "0"))
                uid = int(payload.get("user_id", "0"))
            except (TypeError, ValueError):
                return
            if not gid or not uid:
                return
            adding = op == "guild_member_added"
            for ws, user in list(self._ws_user.items()):
                if user.id == uid:
                    guilds = self._ws_guilds.get(ws)
                    if guilds is not None:
                        if adding:
                            guilds.add(gid)
                        else:
                            guilds.discard(gid)
                        # Stale cache entries for the (now-removed) guild
                        # could otherwise survive the kick on this socket.
                        cache = self._ws_perms.get(ws)
                        if cache is not None:
                            cache.clear()
        elif op == "guild_deleted":
            try:
                gid = int(payload.get("guild_id", "0"))
            except (TypeError, ValueError):
                return
            if not gid:
                return
            for guilds in self._ws_guilds.values():
                guilds.discard(gid)

    def _maybe_invalidate(self, payload: dict) -> None:
        """Trigger cache invalidation when a guild:events envelope indicates
        a permission-affecting change. Conservative: when we can't pinpoint
        the affected channel we drop the whole socket's cache rather than
        risk a stale read."""
        op = payload.get("op")
        if op in ("role_created", "role_updated", "role_deleted"):
            # Any role change affects resolved perms for every member of the
            # guild that owns the role — scope by guild via _ws_guilds rather
            # than clearing every socket's cache. ``role_deleted`` carries
            # ``guild_id`` at the top level; ``role_created`` / ``role_updated``
            # nest it under ``role.guild_id`` (see routes/roles.py::_role_dict).
            raw_gid = payload.get("guild_id")
            if raw_gid is None:
                role = payload.get("role")
                if isinstance(role, dict):
                    raw_gid = role.get("guild_id")
            try:
                gid = int(raw_gid or "0")
            except (TypeError, ValueError):
                return
            if gid:
                self._invalidate_for_guild(gid)
        elif op == "member_roles_updated":
            try:
                uid = int(payload.get("user_id", "0"))
            except (TypeError, ValueError):
                return
            if uid:
                self._invalidate_for_member(uid)
        elif op == "channel_permissions_updated":
            try:
                cid = int(payload.get("channel_id", "0"))
            except (TypeError, ValueError):
                return
            if cid:
                self._invalidate_for_channel(cid)
        elif op == "channel_deleted":
            try:
                cid = int(payload.get("channel_id", "0"))
            except (TypeError, ValueError):
                return
            if cid:
                self._invalidate_for_channel(cid)
        elif op == "guild_updated":
            # owner_id may have changed → owner-bypass changes for the
            # ex-owner. Scope to members of the affected guild. Payload shape:
            # ``{"op": "guild_updated", "guild": {"id": "<id>", ...}}``
            # (see routes/guilds.py::_guild_dict).
            guild = payload.get("guild")
            if not isinstance(guild, dict):
                return
            try:
                gid = int(guild.get("id", "0"))
            except (TypeError, ValueError):
                return
            if gid:
                self._invalidate_for_guild(gid)

    async def _filter_by_view_channel(
        self, targets: list[WebSocket], channel_id: str
    ) -> list[WebSocket]:
        """Drop targets without ``VIEW_CHANNEL`` for the given channel.

        DM channels live in a separate table and have no overwrites — the
        resolver returns 0 for them, so the filter would incorrectly drop
        every DM target. We detect DM channels by checking the
        ``direct_message_channels`` table and skip the filter when the id
        belongs there. When the id matches neither table, the channel is
        deleted (or never existed) — drop the broadcast entirely so race-
        window messages on a still-subscribed ``_subs[cid]`` set don't fan
        out to unrelated clients."""
        if self._session_factory is None:
            return targets
        try:
            cid_int = int(channel_id)
        except (TypeError, ValueError):
            return targets
        from dcc_chat_gateway.models import Channel, DirectMessageChannel

        async with self._session_factory() as session:
            ch = await session.get(Channel, cid_int)
            if ch is None:
                # Could be a DM, or a deleted/unknown id. DMs have no
                # permission overlay so they pass through unfiltered;
                # deleted/unknown channels broadcast to nobody.
                dm = await session.get(DirectMessageChannel, cid_int)
                if dm is None:
                    return []
                return targets
        # Resolve permissions concurrently. The session factory is reentrant
        # so each can_view_channel() opens its own short-lived session.
        # Sequential awaits here scale linearly with target count (100 voice-
        # presence subscribers → 100 round-trips on a cold cache).
        results = await asyncio.gather(
            *(self.can_view_channel(ws, cid_int) for ws in targets)
        )
        return [ws for ws, ok in zip(targets, results) if ok]

    def user_socket_count(self, user_id: int) -> int:
        """How many open sockets the given user currently has. Used by the WS
        endpoint to decide whether ending one socket should end that user's
        hosted watch parties (only true if this was their last socket)."""
        return len(self._user_conns.get(user_id, ()))

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
                    voice_cid = str(payload.get("channel_id"))
                    user_ids = [str(u) for u in payload.get("user_ids", [])]
                    raw_states = payload.get("user_states")
                    # voice-signaling publishes without user_states (it owns
                    # membership, not mute/deafen) — enrich here so clients always
                    # get a complete snapshot. Our own _republish path includes
                    # the field already; trust it then to avoid a second mget.
                    if isinstance(raw_states, dict):
                        user_states = {
                            str(uid): {
                                "mic_muted": bool(s.get("mic_muted")),
                                "deafened": bool(s.get("deafened")),
                            }
                            for uid, s in raw_states.items()
                            if isinstance(s, dict)
                            and (s.get("mic_muted") or s.get("deafened"))
                        }
                    else:
                        user_states = await self.user_voice_states_for(user_ids)
                    envelope = {
                        "op": "voice_state",
                        "channel_id": voice_cid,
                        "user_ids": user_ids,
                        "streaming_user_ids": [
                            str(u) for u in payload.get("streaming_user_ids", [])
                        ],
                        "user_states": user_states,
                    }
                    async with self._lock:
                        raw_targets = list(self._connections)
                    targets = await self._filter_by_view_channel(raw_targets, voice_cid)
                    log.info(
                        "voice:events broadcast channel=%s user_ids=%s streaming=%s states=%d targets=%d/%d",
                        envelope["channel_id"],
                        envelope["user_ids"],
                        envelope["streaming_user_ids"],
                        len(envelope["user_states"]),
                        len(targets),
                        len(raw_targets),
                    )
                    await self._fan_out(targets, envelope)
                    continue

                if channel == WATCH_EVENTS_CHANNEL:
                    payload = self._decode_payload(msg["data"], WATCH_EVENTS_CHANNEL)
                    if not isinstance(payload, dict) or "channel_id" not in payload:
                        log.warning(
                            "watch:events malformed or missing channel_id: %r", payload
                        )
                        continue
                    watch_cid = str(payload.get("channel_id"))
                    envelope = {
                        "op": "watch_state",
                        "channel_id": watch_cid,
                        "state": payload.get("state"),
                    }
                    async with self._lock:
                        raw_targets = list(self._connections)
                    targets = await self._filter_by_view_channel(raw_targets, watch_cid)
                    log.info(
                        "watch:events broadcast channel=%s active=%s targets=%d/%d",
                        envelope["channel_id"],
                        envelope["state"] is not None,
                        len(targets),
                        len(raw_targets),
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
                    stream_cid = str(payload.get("channel_id"))
                    envelope = {
                        "op": "stream_state",
                        "channel_id": stream_cid,
                        "user_ids": [str(u) for u in payload.get("user_ids", [])],
                    }
                    async with self._lock:
                        raw_targets = list(self._connections)
                    targets = await self._filter_by_view_channel(raw_targets, stream_cid)
                    log.info(
                        "stream:events broadcast channel=%s user_ids=%s targets=%d/%d",
                        envelope["channel_id"],
                        envelope["user_ids"],
                        len(targets),
                        len(raw_targets),
                    )
                    await self._fan_out(targets, envelope)
                    continue

                if channel == GUILD_EVENTS_CHANNEL:
                    payload = self._decode_payload(msg["data"], GUILD_EVENTS_CHANNEL)
                    if not isinstance(payload, dict) or "op" not in payload:
                        log.warning("guild:events malformed or missing op: %r", payload)
                        continue
                    self._apply_guild_membership_update(payload)
                    self._maybe_invalidate(payload)
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
                    raw_targets = list(self._subs.get(channel_id, ()))
                targets = await self._filter_by_view_channel(raw_targets, channel_id)
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
