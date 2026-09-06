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

from dcc_chat_gateway.device_registry import _DeviceRegistryMixin
from dcc_chat_gateway.pubsub_channels import (
    ADMIN_EVENTS_CHANNEL,
    CHANNEL_HIST_KEY,
    CHANNEL_KEY,
    CHANNEL_PATTERN,
    CHANNEL_SEQ_KEY,
    GUILD_EVENTS_CHANNEL,
    HIST_MAXLEN,
    HIST_REPLAY_CAP,
    HIST_TTL_SECONDS,
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
from dcc_chat_gateway.remote_reconnect_registry import _RemoteReconnectMixin
from dcc_chat_gateway.remote_registry import _RemoteRegistryMixin
from dcc_chat_gateway.security import AuthenticatedUser
from dcc_chat_gateway.watch_registry import _WatchRegistryMixin
from dcc_chat_gateway.watchkeys import WATCH_EVENTS_CHANNEL, read_states_for

log = logging.getLogger(__name__)

#: Kanal-Ops, die den WS-Replay-Cursor (``seq``/``hist``) tragen und im
#: Redis-Stream fürs ``hist_replay``-Nachholen landen. Bewusst OHNE alles
#: Flüchtige: ``typing`` veraltet in Sekunden (und würde das 1000er-Fenster
#: mit Müll fluten), Stream-/Watch-Chat und Plugin-Ops hatten noch nie einen
#: Lückenfill und bekommen auch keinen — dafür läuft der REST-Fallback.
#: Alte Bare-Dict-Publisher ohne ``op`` senden per Definition ``message``.
_HIST_OPS = frozenset(
    {
        "message",
        "message_update",
        "message_delete",
        "reaction_add",
        "reaction_remove",
        "pin_update",
    }
)

#: Stempel-Script: INCR (Sequenz) + XADD (Stream-Eintrag MIT seq) + EXPIRE
#: + PUBLISH (Umschlag MIT seq+hist) — alles in EINER atomaren Ausführung.
#: Lua statt MULTI-Pipeline, weil die Entry-ID erst beim XADD existiert,
#: aber sowohl der gespeicherte Eintrag als auch der Live-Umschlag die
#: Stempel tragen müssen. Nebeneffekt: Live-Zustellung folgt exakt der
#: Stream-/Sequenz-Reihenfolge (PUBLISH läuft im Script), also kann der
#: Client keine Ereignisse in vertauschter Reihenfolge sehen.
#:
#: Der JSON-Body wird BEWUSST nicht via cjson dekodiert/rekodiert — cjson
#: kann leere Arrays von leeren Objekten nicht unterscheiden (``mentions:
#: []`` käme als ``{}`` wieder heraus, getestet gegen test_mentions) und
#: würde Schlüssel-Reihenfolge misleading verwerfen. Stattdessen hängt das
#: Script die zwei Stempel-Felder als reinen Text VOR die schließende
#: Klammer: ``{…}`` → ``{…,"seq":N,"hist":"id"}``. Invariante: ARGV[1] ist
#: immer ``json.dumps`` eines DICTS (endet mit ``}``, keine Top-Level-
#: Arrays) — das stellt publish() sicher. Entry-IDs bestehen nur aus
#: Ziffern+Bindestrich, brauchen also kein JSON-Escaping.
_HIST_STEMPEL_LUA = """
local seq = redis.call('INCR', KEYS[1])
local body = ARGV[1]
local stored = string.sub(body, 1, #body - 1) .. ',"seq":' .. seq .. '}'
local id = redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[3], '*', 'e', stored)
redis.call('EXPIRE', KEYS[2], ARGV[2])
local live = string.sub(stored, 1, #stored - 1) .. ',"hist":"' .. id .. '"}'
redis.call('PUBLISH', KEYS[3], live)
return {seq, id}
"""


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
    _ListenerMixin,
    _PermFilterMixin,
    _FriendCacheMixin,
    _WatchRegistryMixin,
    _RemoteRegistryMixin,
    _RemoteReconnectMixin,
    _DeviceRegistryMixin,
):
    # Max parallel WebSocket connections per user. Each connection multiplies
    # the fan-out cost of every pub/sub event; a single user with N sockets
    # turns one event into N `send_json` calls (with 5s timeouts each).
    MAX_CONNECTIONS_PER_USER = 10

    # Max parallel WebSocket connections per source IP. Caps account-farming
    # DoS (an attacker creating many accounts, each opening up to
    # MAX_CONNECTIONS_PER_USER sockets). Keyed by the X-Forwarded-For client
    # IP the WS endpoint resolves via ``client_ip.ws_client_ip`` — in prod the
    # direct peer is Caddy for every connection, so the raw socket address
    # would collapse all clients into one bucket. Tuned generously so a
    # shared-NAT household/office of legitimate users is not collateral.
    MAX_CONNECTIONS_PER_IP = 100

    def __init__(self, redis: Redis) -> None:
        self._redis = redis
        self._hist_script = redis.register_script(_HIST_STEMPEL_LUA)
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
        # source IP → set of open sockets. Caps connections per real client IP
        # (account-farming DoS across many accounts). Keyed by the XFF client IP
        # the WS endpoint resolves via ``client_ip.ws_client_ip``. defaultdict is
        # safe here — entries exist only via register()/remove_socket() under
        # ``_lock``, so no resurrection-via-defaultdict risk like ``_ws_perms``.
        self._ip_conns: dict[str, set[WebSocket]] = defaultdict(set)
        # Reverse index for remove_socket: socket → the IP key it lives under.
        self._ws_ip: dict[WebSocket, str] = {}
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
        # Hebel A — broadcast-filter channel identity cache: cid → owning
        # guild_id (>0), -1 for a DM (no overlay → passes unfiltered), -2 for a
        # private group (membership filter, Etappe G), 0 for a deleted/unknown
        # id. Die Werte stehen als ``_KIND_*`` in ``pubsub_perm_filter.py``.
        # Avoids a DB ``session.get(Channel)`` + fallbacks on every single
        # fan-out. Invalidated alongside ``_ws_perms`` (channel delete / perm
        # change). Plain dict — bounded by the channel count.
        self._channel_kind_cache: dict[int, int] = {}
        # Hebel B — resolved VIEW_CHANNEL member set per (guild, channel):
        # lets a burst of cold sockets (e.g. reconnect after a deploy) pay the
        # full guild-member scan once, not once per broadcast. Invalidated
        # alongside ``_ws_perms`` (role / overwrite / membership changes).
        self._view_members_cache: dict[tuple[int, int], set[int]] = {}
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
        # Buffer for friend/block lifecycle deltas that land on a socket
        # before its caches above are hydrated (register()→hydrate_friend_
        # caches() gap) — see pubsub_friend_cache.py's module docstring.
        # list of (cache_attr, other_user_id, add) tuples, replayed and
        # cleared by hydrate_friend_caches.
        self._ws_pending_deltas: dict[WebSocket, list[tuple[str, int, bool]]] = {}
        # Extra plugin-declared pub/sub channels (populated by
        # subscribe_plugin_channels at lifespan time). Re-subscribed on every
        # start() call so that a crashed + restarted listener does not silently
        # lose plugin-channel messages.
        self._plugin_channels: set[str] = set()
        self._lock = asyncio.Lock()
        self._init_watch_registry()
        self._init_remote_registry()
        self._init_remote_reconnect()
        self._init_device_registry()
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
            ADMIN_EVENTS_CHANNEL,
        )
        # Re-subscribe any plugin channels that were registered at startup.
        # This is idempotent (Redis ignores duplicate subscribes) and ensures
        # plugin messages are not lost after a listener crash + restart.
        if self._plugin_channels:
            await self._pubsub.subscribe(*self._plugin_channels)
        # Wait until Redis has acknowledged every subscription before we start
        # serving. Pub/sub is fire-and-forget: a message published in the
        # window between our SUBSCRIBE being sent and Redis registering it is
        # silently dropped. The per-channel acks arrive in order and *before*
        # any real message, so draining them guarantees the subscription is
        # live — closing the rare subscribe-race where a just-connected client
        # misses the first event it triggers (the root of the intermittent
        # WS-test timeouts). Bounded + best-effort: a hiccup logs and proceeds
        # rather than wedging startup. No real traffic can be in the buffer
        # yet (nothing has published at lifespan-start), so we never drop a
        # message here.
        acks_expected = 1 + 6 + len(self._plugin_channels)  # psubscribe + fixed + plugins
        acks_seen = 0
        empty_polls = 0
        while acks_seen < acks_expected and empty_polls < 3:
            confirm = await self._pubsub.get_message(
                ignore_subscribe_messages=False, timeout=0.5
            )
            if confirm is None:
                empty_polls += 1
                continue
            if confirm.get("type") in ("subscribe", "psubscribe"):
                acks_seen += 1
            else:
                # A real message can be buffered here during a self-heal
                # re-subscribe (the connection stayed subscribed while the
                # listener was down). Deliver it instead of dropping it — on a
                # cold start no real traffic exists yet, so this is a no-op then.
                await self._dispatch_message(confirm)
        if acks_seen < acks_expected:
            log.warning(
                "pubsub: drained %d/%d subscribe acks before listen (continuing)",
                acks_seen,
                acks_expected,
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
        client_ip: str = "unknown",
    ) -> tuple[bool, bool]:
        """Add ``ws`` to the connection set. Returns ``(accepted, is_first)``.

        ``accepted`` is False when either the user already has
        ``MAX_CONNECTIONS_PER_USER`` open sockets OR the source ``client_ip``
        already has ``MAX_CONNECTIONS_PER_IP`` open sockets — the caller must
        close the websocket in either case. ``is_first`` is True when this
        socket is the user's only live connection right after registration
        (i.e. the user just transitioned from offline to online).

        ``is_first`` is decided atomically under ``_lock`` together with the
        registration itself. Reading ``user_socket_count`` separately later
        races: two concurrent first connects would both observe count == 2 and
        neither would broadcast the online transition.

        Storing the full ``AuthenticatedUser`` (rather than just the id)
        keeps the ``is_admin`` flag available for permission resolution
        during broadcast filtering — re-decoding the JWT per event would
        be wasteful and re-fetching the user from auth-svc is impossible
        once the bearer is consumed.

        ``guild_ids`` is the set of guilds the user is a member of at the
        moment the WS endpoint accepts the connection (the same list the
        ``ready`` frame is built from). Used by ``_invalidate_for_guild`` to
        pinpoint which sockets to bust — a role mutation on Server X must not
        cold-clear caches for users only in Servers A, B, C.

        ``client_ip`` is the resolved real client IP (XFF behind Caddy) used
        for the per-IP connection cap; defaults to ``"unknown"`` for direct
        callers / tests that don't pass it."""
        async with self._lock:
            user_set = self._user_conns[user.id]
            if len(user_set) >= self.MAX_CONNECTIONS_PER_USER:
                return False, False
            ip_set = self._ip_conns[client_ip]
            if len(ip_set) >= self.MAX_CONNECTIONS_PER_IP:
                return False, False
            is_first = len(user_set) == 0
            user_set.add(ws)
            ip_set.add(ws)
            self._ws_ip[ws] = client_ip
            self._ws_user[ws] = user
            self._connections.add(ws)
            self._ws_guilds[ws] = {int(g) for g in guild_ids}
            return True, is_first

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
            self._ws_channels.setdefault(ws, set()).add(channel_id)

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
            ip = self._ws_ip.pop(ws, None)
            if ip is not None:
                ip_bucket = self._ip_conns.get(ip)
                if ip_bucket is not None:
                    ip_bucket.discard(ws)
                    if not ip_bucket:
                        del self._ip_conns[ip]
            self._ws_perms.pop(ws, None)
            self._ws_guilds.pop(ws, None)
            self._ws_blocks_out.pop(ws, None)
            self._ws_blocks_in.pop(ws, None)
            self._ws_friends.pop(ws, None)
            self._ws_pending_deltas.pop(ws, None)
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
        wire = self._to_wire(payload)
        if wire.get("op") is None:
            # Legacy: nacktes Nachrichtendict. HIER wickeln — nicht erst im
            # Listener — damit der Replay-Stempel oben auf dem Umschlag
            # liegt und nicht in ``data`` verrutscht. Der Listener erkennt
            # das ``op`` und leitet den Umschlag unverändert durch; am
            # Client kommt exakt dasselbe Frame an wie vorher.
            wire = {"op": "message", "data": wire}
        if wire["op"] in _HIST_OPS:
            await self._hist_stempeln(channel_id, wire)
            return
        await self._redis.publish(
            CHANNEL_KEY.format(channel_id=channel_id),
            json.dumps(wire, separators=(",", ":")),
        )

    async def _hist_stempeln(self, channel_id: str, wire: dict[str, Any]) -> None:
        """WS-Replay-Cursor auf ein dauerhaftes Kanal-Ereignis stempeln und
        es zustellen (Script übernimmt auch das PUBLISH — s.
        ``_HIST_STEMPEL_LUA`` für die Begründung).

        ``ponytail:`` Der Stream ist ein gleitendes Fenster (HIST_MAXLEN,
        Redis-trimmt von links; EXPIRE schließt es bei Funkstille ganz).
        Ein Client, der LÄNGER offline war, bekommt ``complete:false`` und
        fällt auf den REST-Lückenfill zurück — die „mehr als 100
        Nachrichten"–Schwelle des REST-Pfads bleibt dafür bestehen.
        Verliert Redis Zähler UND Stream gemeinsam (AOF-Rollback), kann das
        Replay ``complete`` über nie zugestellte Ereignisse behaupten; das
        Fenster ist ~1s und der nächste REST-Initialload heilt es.
        Upgrade-Pfad, falls das je weh tut: Ereignis-Log in Postgres.
        """
        await self._hist_script(
            keys=[
                CHANNEL_SEQ_KEY.format(channel_id=channel_id),
                CHANNEL_HIST_KEY.format(channel_id=channel_id),
                CHANNEL_KEY.format(channel_id=channel_id),
            ],
            args=[
                json.dumps(wire, separators=(",", ":")),
                HIST_TTL_SECONDS,
                HIST_MAXLEN,
            ],
        )

    async def read_channel_history(
        self, channel_id: str, last_id: str, last_seq: int
    ) -> tuple[list[dict[str, Any]], bool]:
        """Kanal-Ereignisse nach dem Cursor ``(last_id, last_seq)`` lesen.

        ``last_id`` ist die letzte vom Client gesehene Stream-Eintrag-ID,
        ``last_seq`` die letzte gesehene Sequenznummer. Zurück kommt
        ``(events, complete)``: ``complete`` genau dann, wenn der erste
        gelieferte Eintrag lückenlos an den Client-Cursor anschließt —
        jede Lücke (getrimmte Ereignisse, Sequenz-Reset nach einem
        Redis-Verlust, Müll im Cursor) macht das Ergebnis „unvollständig"
        und der Client muss über seinen REST-Lückenfill weitermachen.

        Fehler (fremder Cursor, Redis-Weg) werden als ``([], False)`
        gemeldet, nie geworfen — das Nachholen darf den Op-Loop nicht
        reißen.
        """
        try:
            raw = await self._redis.xrange(
                CHANNEL_HIST_KEY.format(channel_id=channel_id),
                min=f"({last_id}",
                max="+",
                count=HIST_REPLAY_CAP + 1,
            )
        except Exception:  # noqa: BLE001 — fremder Cursor → ResponseError
            return [], False
        overflow = len(raw) > HIST_REPLAY_CAP
        raw = raw[:HIST_REPLAY_CAP]
        events: list[dict[str, Any]] = []
        first_seq: int | None = None
        for entry_id, fields in raw:
            # redis-py liefert Feldnamen je nach decode_responses als bytes
            # oder str — beides fressen.
            raw_env = fields.get("e", fields.get(b"e"))
            try:
                env = json.loads(raw_env or "{}")
            except (ValueError, TypeError):
                return events, False
            if not isinstance(env, dict):
                return events, False
            env["hist"] = (
                entry_id.decode() if isinstance(entry_id, bytes) else str(entry_id)
            )
            if first_seq is None:
                first_seq = env.get("seq")
            events.append(env)
        if overflow:
            return events, False
        if not events:
            try:
                current = int(
                    await self._redis.get(CHANNEL_SEQ_KEY.format(channel_id=channel_id))
                    or 0
                )
            except Exception:  # noqa: BLE001 — Redis-Weg → incomplete
                return [], False
            # Nichts nachzuholen, aber nur vollständig, wenn sich der
            # Zähler seit dem Client-Cursor nicht bewegt hat. Stream weg
            # (Verlust/Trimming) + Zähler weiter gelaufen ⇒ Lücke.
            return [], current == last_seq
        return events, first_seq == last_seq + 1

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
        self._plugin_channels.update(channels)
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
        gk = f"voice:room:channel-{channel_id}:gast-stumm"
        # Issue all SMEMBERS in parallel rather than sequentially.
        members, streamers, cameras, gast_stumm = await asyncio.gather(
            self._redis.smembers(key),
            self._redis.smembers(sk),
            self._redis.smembers(ck),
            self._redis.smembers(gk),
        )
        user_ids = _decode_sorted(members)
        user_states = await self.user_voice_states_for(user_ids)
        # Gäste haben keine Sitzung, deren Zustand man lesen könnte — ihr
        # Stumm-Zustand hält voice-signaling im ``:gast-stumm``-Set bereit
        # (LiveKit track_muted/unmuted-Webhooks) und kommt hier in dieselbe
        # ``user_states``-Map wie bei Mitgliedern.
        for gid in _decode_sorted(gast_stumm):
            if gid in user_ids:
                user_states[gid] = {"mic_muted": True, "deafened": False}
        return {
            "user_ids": user_ids,
            "streaming_user_ids": _decode_sorted(streamers),
            "camera_user_ids": _decode_sorted(cameras),
            "user_states": user_states,
            # Gastnamen für den ready-Rahmen: wer nach einem Neuladen in einen
            # Kanal blickt, in dem ein Gast sitzt, bekommt sonst nur dessen
            # Kennung zu sehen — das Ereignis mit der Namenskarte kam vor
            # seiner Verbindung.
            "gast_namen": await self._gast_namen_fuer(user_ids),
        }

    async def _gast_namen_fuer(self, user_ids: list[str]) -> dict[str, str]:
        """Die Namen der Gäste unter ``user_ids`` (leer, wenn keine dabei)."""
        from dcc_shared import gaeste as _gaeste  # noqa: PLC0415

        kennungen = [u for u in user_ids if _gaeste.ist_gast(u)]
        if not kennungen:
            return {}
        namen = await asyncio.gather(
            *(_gaeste.gast_name(self._redis, k) for k in kennungen)
        )
        return {k: n for k, n in zip(kennungen, namen) if n}

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
        return [e for entries in per_channel for e in entries]

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
        standard ``{"channel_id": ..., "user_ids": [...], "streams"?: [...]}``
        shape, or ``None`` when the key is absent / empty / malformed. The
        additive ``streams`` list is echoed only when present (a user runs
        slot ≥ 1), so single-stream re-syncs keep the legacy shape."""
        data = _loads_redis_dict(raw)
        if data is None:
            return None
        uids = [str(u) for u in (data.get("user_ids") or []) if u]
        if not uids:
            return None
        out: dict[str, Any] = {"channel_id": channel_id, "user_ids": uids}
        streams = data.get("streams")
        if streams:
            out["streams"] = streams
        return out

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
