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

from dcc_shared.events import _EventBase
from dcc_shared.permission_resolver import has_permission
from dcc_shared.permissions import Permissions
from fastapi import WebSocket
from redis.asyncio import Redis

from dcc_chat_gateway.pubsub_channels import (
    CHANNEL_KEY,
    CHANNEL_PATTERN,
    GUILD_EVENTS_CHANNEL,
    STREAM_CHANNEL_STATE_KEY,
    STREAM_EVENTS_CHANNEL,
    USER_EVENTS_CHANNEL,
    VOICE_EVENTS_CHANNEL,
    VOICE_USER_STATE_KEY,
    VOICE_USER_STATE_TTL_SECONDS,
)
from dcc_chat_gateway.pubsub_friend_cache import _FriendCacheMixin
from dcc_chat_gateway.pubsub_listener import _ListenerMixin
from dcc_chat_gateway.pubsub_perm_filter import _PermFilterMixin
from dcc_chat_gateway.security import AuthenticatedUser
from dcc_chat_gateway.watch_registry import _WatchRegistryMixin
from dcc_chat_gateway.watchkeys import WATCH_EVENTS_CHANNEL, read_states_for

log = logging.getLogger(__name__)


def _decode_sorted(members: Iterable[Any]) -> list[str]:
    """Decode a Redis SMEMBERS result (bytes or str entries) to a sorted
    list of str."""
    return sorted(m.decode() if isinstance(m, bytes) else m for m in members)


def _loads_redis_dict(raw: bytes | str | None) -> dict[str, Any] | None:
    """Decode a raw Redis value (bytes/str/None) into a JSON object, or
    ``None`` when the key is absent / malformed / not a JSON object."""
    if raw is None:
        return None
    try:
        data = json.loads(raw.decode() if isinstance(raw, bytes) else raw)
    except (ValueError, TypeError, AttributeError):
        return None
    return data if isinstance(data, dict) else None

# Channel-name + key-template constants live in ``pubsub_channels``; re-exported
# above so existing ``from dcc_chat_gateway.pubsub import GUILD_EVENTS_CHANNEL``
# imports keep working.
__all__ = [
    "CHANNEL_KEY",
    "CHANNEL_PATTERN",
    "ConnectionManager",
    "GUILD_EVENTS_CHANNEL",
    "STREAM_CHANNEL_STATE_KEY",
    "STREAM_EVENTS_CHANNEL",
    "USER_EVENTS_CHANNEL",
    "VOICE_EVENTS_CHANNEL",
    "VOICE_USER_STATE_KEY",
    "VOICE_USER_STATE_TTL_SECONDS",
]


class ConnectionManager(
    _ListenerMixin, _PermFilterMixin, _FriendCacheMixin, _WatchRegistryMixin
):
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
        # Reverse index: socket → set of channel-ids it is subscribed to.
        # Maintained in parallel with ``_subs`` so ``remove_socket`` can
        # iterate only the channels that socket joined instead of scanning
        # the full ``_subs`` dict (O(subscribed) vs O(all channels)).
        self._ws_channels: dict[WebSocket, set[str]] = {}
        # Per-socket set of guild ids the user is a member of. Populated by
        # ``register`` (called from the WS endpoint with the same guild list
        # the ``ready`` frame is built from) and live-updated from
        # ``guild_member_added`` / ``guild_deleted`` events in ``_listen``.
        # Used by ``_invalidate_for_guild`` to pinpoint affected sockets so a
        # role mutation on Server X doesn't cold-bust caches for users only in
        # Servers A, B, C. Same resurrection-via-defaultdict rule as
        # ``_ws_perms`` — plain dict, writers guard with ``ws in self._ws_user``.
        self._ws_guilds: dict[WebSocket, set[int]] = {}
        # Per-socket friend-system caches (Etappe 2 of the Voll-Discord
        # friend system). Filled lazily on first read by the helpers in
        # ``friend_events.py`` and live-updated from the friend/block
        # lifecycle events the routes publish. Same resurrection-via-
        # defaultdict caveat as the perms/guilds caches above — plain
        # dicts, writers guard with ``ws in self._ws_user``.
        # ``_ws_blocks_out``: user-ids THIS socket's user has blocked.
        # ``_ws_blocks_in``: user-ids that have blocked THIS socket's user
        #   — drives the "drop incoming mention_added when receiver blocks
        #   sender" filter without an extra DB hop per fan-out.
        # ``_ws_friends``: confirmed-friend user-ids — read by the
        #   presence visibility filter so a stranger's status leak is
        #   gated on either friendship or a shared guild.
        self._ws_blocks_out: dict[WebSocket, set[int]] = {}
        self._ws_blocks_in: dict[WebSocket, set[int]] = {}
        self._ws_friends: dict[WebSocket, set[int]] = {}
        # Extra plugin-declared pub/sub channels (populated by
        # subscribe_plugin_channels at lifespan time). Re-subscribed on every
        # start() call so that a crashed + restarted listener does not silently
        # lose plugin-channel messages.
        self._plugin_channels: list[str] = []
        self._lock = asyncio.Lock()
        self._init_watch_registry()
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
            USER_EVENTS_CHANNEL,
        )
        # Re-subscribe any plugin channels that were registered at startup.
        # This is idempotent (Redis ignores duplicate subscribes) and ensures
        # plugin messages are not lost after a listener crash + restart.
        if self._plugin_channels:
            await self._pubsub.subscribe(*self._plugin_channels)
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
            # Keep the reverse index in sync.
            if ws not in self._ws_channels:
                self._ws_channels[ws] = set()
            self._ws_channels[ws].add(channel_id)

    async def unsubscribe(self, ws: WebSocket, channel_id: str) -> None:
        async with self._lock:
            local = self._subs.get(channel_id)
            if local is None:
                return
            local.discard(ws)
            if not local:
                del self._subs[channel_id]
            # Mirror in the reverse index.
            ws_chans = self._ws_channels.get(ws)
            if ws_chans is not None:
                ws_chans.discard(channel_id)

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
            self._ws_blocks_out.pop(ws, None)
            self._ws_blocks_in.pop(ws, None)
            self._ws_friends.pop(ws, None)
            # Use the reverse index to clean up only the channels this socket
            # was actually subscribed to — O(subscribed) instead of O(all
            # channels).  Fall back to the full scan when the reverse index
            # has no entry (e.g. socket that never subscribed to any channel).
            subscribed = self._ws_channels.pop(ws, None)
            if subscribed is not None:
                for cid in subscribed:
                    bucket = self._subs.get(cid)
                    if bucket is not None:
                        bucket.discard(ws)
                        if not bucket:
                            del self._subs[cid]
            else:
                for cid in list(self._subs):
                    self._subs[cid].discard(ws)
                    if not self._subs[cid]:
                        del self._subs[cid]

    @staticmethod
    def _to_wire(payload: dict[str, Any] | _EventBase) -> dict[str, Any]:
        """Accept either a raw dict (legacy callers) or one of the
        ``dcc_shared.events`` Pydantic models — return the JSON-mode dict
        that gets serialised to Redis. ``model_dump(mode="json")`` honours
        ``serialize_by_alias=True`` so wire-format aliases survive
        (e.g. ``_sender_user_id`` on ``presence_status_changed``).

        ``exclude_none=True`` is intentionally NOT set: an explicit
        ``None`` (e.g. ``watch_state`` snapshot with ``state=None`` ==
        "party stopped") is meaningful on the wire and must round-trip.
        Models that want a field omitted-when-default should use
        ``Field(default=..., exclude=True)`` instead.
        """
        if isinstance(payload, _EventBase):
            return payload.model_dump(mode="json")
        return payload

    async def publish(
        self, channel_id: str, payload: dict[str, Any] | _EventBase
    ) -> None:
        await self._redis.publish(
            CHANNEL_KEY.format(channel_id=channel_id),
            json.dumps(self._to_wire(payload), separators=(",", ":")),
        )

    async def publish_guild_event(
        self, envelope: dict[str, Any] | _EventBase
    ) -> None:
        """Publish a guild-lifecycle envelope (with its own `op`) for fan-out
        to every connected WebSocket. See ``GUILD_EVENTS_CHANNEL``.

        Accepts either a raw dict (legacy callers, gradually migrated) or
        one of the ``dcc_shared.events`` Pydantic models — the latter is
        the preferred path going forward."""
        await self._redis.publish(
            GUILD_EVENTS_CHANNEL,
            json.dumps(self._to_wire(envelope), separators=(",", ":")),
        )

    async def publish_user_event(
        self,
        target_user_id: int | str,
        envelope: dict[str, Any] | _EventBase,
    ) -> None:
        """Publish a direct-delivery envelope routed to one specific user.

        ``envelope`` carries its own ``op`` and ``d``; we wrap it with a
        ``_target_user_id`` field that the listener strips before delivery.
        Used for cross-channel notifications (mention-counter increment etc.)
        where the recipient may not be subscribed to the originating channel.
        See ``USER_EVENTS_CHANNEL``.

        Accepts both raw dicts (legacy) and ``dcc_shared.events`` models.
        """
        wrapped = dict(self._to_wire(envelope))
        wrapped["_target_user_id"] = str(target_user_id)
        await self._redis.publish(
            USER_EVENTS_CHANNEL,
            json.dumps(wrapped, separators=(",", ":")),
        )

    async def subscribe_plugin_channels(self, channels: list[str]) -> None:
        """Subscribe zusätzliche, vom Plugin-System deklarierte Channels.

        Der Manager kennt seine Built-in-Channels bei ``start()`` (voice/
        guild/stream/watch/user). Plugins (Plugin-System PR3+) deklarieren
        eigene Channels in ``[plugin.uses].channels`` ihres Manifests; die
        Lifespan ruft das hier nach ``load_all_with_allowlist`` mit der
        Liste auf, damit der ``_listen``-Loop sie auch wirklich empfängt.

        Idempotent — Redis akzeptiert Re-Subscribes ohne Fehler. Leere
        Liste = no-op.
        """
        if not channels:
            return
        # ``subscribe(*args)`` akzeptiert N positional channel-names.
        await self._pubsub.subscribe(*channels)
        # Track the channel names so start() can re-subscribe them after a
        # listener crash recovery (built-in channels are re-subscribed by
        # start(); plugin channels need the same treatment).
        existing = set(self._plugin_channels)
        for ch in channels:
            if ch not in existing:
                self._plugin_channels.append(ch)
                existing.add(ch)
        log.info(
            "pubsub: subscribed %d additional plugin channel(s): %s",
            len(channels),
            sorted(channels),
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
        ck = f"voice:room:channel-{channel_id}:camera"
        # Issue all SMEMBERS in parallel rather than sequentially.
        members, streamers, cameras = await asyncio.gather(
            self._redis.smembers(key),
            self._redis.smembers(sk),
            self._redis.smembers(ck),
        )
        user_ids = _decode_sorted(members)
        user_states = await self.user_voice_states_for(user_ids)
        return {
            "user_ids": user_ids,
            "streaming_user_ids": _decode_sorted(streamers),
            "camera_user_ids": _decode_sorted(cameras),
            "user_states": user_states,
        }

    async def voice_states_for(self, channel_ids: list[str]) -> list[dict[str, Any]]:
        if not channel_ids:
            return []
        states = await asyncio.gather(*(self.voice_state_for(cid) for cid in channel_ids))
        out: list[dict[str, Any]] = []
        for cid, state in zip(channel_ids, states):
            if state["user_ids"] or state["streaming_user_ids"] or state["camera_user_ids"]:
                out.append({"channel_id": cid, **state})
        return out

    async def _overrides_for_channel(self, cid: str) -> list[dict[str, Any]]:
        """Fetch force-mute / force-deafen overrides for a single voice channel."""
        pattern = f"voice:override:channel-{cid}:user-*"
        keys: list[str] = []
        async for k in self._redis.scan_iter(match=pattern, count=100):
            if isinstance(k, bytes):
                k = k.decode()
            keys.append(k)
        if not keys:
            return []
        raws = await self._redis.mget(*keys)
        result: list[dict[str, Any]] = []
        for k, raw in zip(keys, raws):
            data = _loads_redis_dict(raw)
            if data is None:
                continue
            # ``voice:override:channel-<cid>:user-<uid>`` — split out the user_id.
            uid = k.rsplit(":user-", 1)[-1]
            muted = bool(data.get("muted"))
            deafened = bool(data.get("deafened"))
            if not (muted or deafened):
                continue
            result.append(
                {
                    "channel_id": cid,
                    "user_id": uid,
                    "muted": muted,
                    "deafened": deafened,
                }
            )
        return result

    async def voice_overrides_for(
        self, channel_ids: list[str]
    ) -> list[dict[str, Any]]:
        """Active force-mute / force-deafen overrides for the given
        voice channels. Read straight off Redis (``voice:override:*``
        keys written by voice-signaling). Used in the ``ready`` frame
        so a freshly-connected client sees the current admin overrides
        without waiting for the next mod-toggle event.

        Each channel's SCAN + MGET is issued in parallel via
        ``asyncio.gather`` so latency scales with the slowest single
        channel rather than the sum of all channels."""
        if not channel_ids:
            return []
        per_channel = await asyncio.gather(
            *(self._overrides_for_channel(cid) for cid in channel_ids)
        )
        out: list[dict[str, Any]] = []
        for entries in per_channel:
            out.extend(entries)
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
            data = _loads_redis_dict(raw)
            if data is None:
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
        publishes; we own state-driven ones.

        Note: the snapshot includes the enriched ``user_states`` field, which
        ``VoiceStateSnapshot`` doesn't carry — that's intentional. The
        listener wraps the bare-snapshot side for voice-signaling, but our
        own re-publish path already has the per-user states resolved, so we
        emit them inline so the listener trusts them rather than re-fetching.
        We publish as a raw dict here (the field is outside the snapshot
        schema) — when the listener sees ``user_states`` it skips the
        ``user_voice_states_for`` re-hydration.
        """
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
        return self._parse_stream_state(channel_id, raw)

    @staticmethod
    def _parse_stream_state(
        channel_id: str, raw: bytes | str | None
    ) -> dict[str, Any] | None:
        """Parse a raw Redis value from ``stream:channel:<id>`` into the
        standard ``{"channel_id": ..., "user_ids": [...]}`` shape, or
        ``None`` when the key is absent / empty / malformed."""
        data = _loads_redis_dict(raw)
        if data is None:
            return None
        uids = [str(u) for u in (data.get("user_ids") or []) if u]
        if not uids:
            return None
        return {"channel_id": channel_id, "user_ids": uids}

    async def stream_states_for(self, channel_ids: list[str]) -> list[dict[str, Any]]:
        """Return active stream-state entries for the given channels.

        Issues a single MGET for all ``stream:channel:<id>`` keys instead of
        N individual GETs, reducing Redis round-trips from N to 1."""
        if not channel_ids:
            return []
        keys = [STREAM_CHANNEL_STATE_KEY.format(channel_id=cid) for cid in channel_ids]
        raws = await self._redis.mget(*keys)
        return [
            s
            for cid, raw in zip(channel_ids, raws)
            if (s := self._parse_stream_state(cid, raw)) is not None
        ]

    async def watch_states_for(self, channel_ids: list[str]) -> list[dict[str, Any]]:
        """Active watch parties for the given voice channels. Returns
        ``[{"channel_id": ..., "state": {...}}, ...]``; channels without an
        active party are omitted. See ``watchkeys.py`` for the state shape."""
        return await read_states_for(self._redis, channel_ids)

    def user_socket_count(self, user_id: int) -> int:
        """How many open sockets the given user currently has. Used by the WS
        endpoint to decide whether ending one socket should end that user's
        hosted watch parties (only true if this was their last socket)."""
        return len(self._user_conns.get(user_id, ()))

    def online_user_ids(self) -> list[str]:
        """Return user_ids of all currently-connected users (at least one open
        socket). Called once per ready frame — stale by a few ms at worst,
        which is acceptable for presence seeding."""
        return [str(uid) for uid, socks in self._user_conns.items() if socks]

    async def broadcast_presence_update(self, user_id: str, *, online: bool) -> None:
        """Publish a presence_update event on guild:events so every connected
        client can update its online/offline member grouping in real time."""
        from dcc_shared.events import PresenceUpdateEvent

        await self.publish_guild_event(PresenceUpdateEvent(user_id=user_id, online=online))
