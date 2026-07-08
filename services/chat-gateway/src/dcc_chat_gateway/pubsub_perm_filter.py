"""Per-socket permission cache + visibility filter.

Extracted from :mod:`pubsub` as a mixin. Owns the lazy-filled
``_ws_perms`` channel-permission cache, the invalidation hooks that fire
on relevant guild:events, and the broadcast-filter helpers
(``_filter_by_view_channel``, ``_filter_targets_by_guild``,
``_apply_guild_membership_update``) used by the listener.

State (``_session_factory``, ``_ws_perms``, ``_ws_guilds``, ``_ws_user``)
is initialised in ``ConnectionManager.__init__``; the mixin reaches it
via ``self.`` through cooperative inheritance.
"""

from __future__ import annotations

import asyncio
import logging

from dcc_shared.permission_resolver import has_permission
from dcc_shared.permissions import GRANT_ALL_SAFE, Permissions
from fastapi import WebSocket

log = logging.getLogger(__name__)

# Signed 64-bit bounds — channel ids live in a Postgres BIGINT column.
_INT64_MIN = -(2**63)
_INT64_MAX = 2**63 - 1
_VIEW_CHANNEL_BIT = int(Permissions.VIEW_CHANNEL)


class _PermFilterMixin:
    """Adds the permission cache + broadcast-filter helpers to
    :class:`ConnectionManager`. Not usable standalone."""

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
        if user.is_admin:
            # Global admins always have GRANT_ALL_SAFE — warm the cache so
            # repeated calls (e.g. in the gather below) hit the hot path.
            if ws in self._ws_user:
                self._ws_perms.setdefault(ws, {})[channel_id] = GRANT_ALL_SAFE
            return GRANT_ALL_SAFE
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

    def _drop_view_members_for_guild(self, guild_id: int) -> None:
        """Drop every cached VIEW-member set keyed on ``guild_id`` (Hebel B).
        Used when a role mutation recomputes who can view every channel in
        the guild. Builds the key list first to avoid mutating the dict
        during iteration."""
        for key in [k for k in self._view_members_cache if k[0] == guild_id]:
            del self._view_members_cache[key]

    def _drop_view_members_for_channel(self, channel_id: int) -> None:
        """Drop the cached VIEW-member set for ``channel_id`` (Hebel B).
        Symmetric counterpart to ``_drop_view_members_for_guild`` — used
        when a channel's permission overlay changes."""
        for key in [k for k in self._view_members_cache if k[1] == channel_id]:
            del self._view_members_cache[key]

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
        self._drop_view_members_for_guild(guild_id)

    def _invalidate_for_channel(self, channel_id: int) -> None:
        for cache in self._ws_perms.values():
            cache.pop(channel_id, None)
        # Hebel A+B: a perm change or delete invalidates the channel's identity
        # and its resolved VIEW-member set.
        self._channel_kind_cache.pop(channel_id, None)
        self._drop_view_members_for_channel(channel_id)

    def _invalidate_for_member(self, user_id: int) -> None:
        for ws, user in list(self._ws_user.items()):
            if user.id == user_id:
                cache = self._ws_perms.get(ws)
                if cache is not None:
                    cache.clear()
        # Hebel B: this user's VIEW status may have changed in any channel, so
        # the cached sets no longer reflect their membership — drop them all.
        # Member-role changes are infrequent admin actions; the sets re-warm
        # lazily on the next cold-socket broadcast.
        self._view_members_cache.clear()

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
            # Hebel B: membership churn makes the guild's resolved VIEW-member
            # sets stale — a newly-joined member must start receiving, a removed
            # one must stop. Drop the guild's sets; they re-warm lazily.
            self._drop_view_members_for_guild(gid)
        elif op == "guild_deleted":
            try:
                gid = int(payload.get("guild_id", "0"))
            except (TypeError, ValueError):
                return
            if not gid:
                return
            for guilds in self._ws_guilds.values():
                guilds.discard(gid)
            self._drop_view_members_for_guild(gid)

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
        elif op in ("channel_permissions_updated", "channel_deleted"):
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

    # ops on guild:events whose visibility should be scoped to guild
    # members. Other ops on the same channel (role_*, guild_updated,
    # etc.) keep the broadcast-everyone semantics they were built on
    # — the frontend filters by guild membership in its handlers.
    # ``channel_bump`` is scoped here so the (cold-cache) VIEW_CHANNEL
    # resolve below only runs for the guild's own members, not for every
    # globally-connected socket.
    _GUILD_MEMBER_SCOPED_OPS = frozenset(
        {
            "guild_member_added",
            "guild_member_removed",
            "guild_member_updated",
            "guild_ban_added",
            "guild_ban_removed",
            "channel_bump",
            # Plugin-Toggle-Push (per-guild): nur Member sollen ihren
            # ``guild-activation``-Cache invalidieren; Outsider haben
            # gar keinen Slot für die Guild.
            "guild_plugins_changed",
            # Dropbox / Ablage events carry entry metadata + presigned
            # GET URLs (for files). The bandwidth cost is negligible
            # but the privacy cost matters — a member with
            # ``@everyone`` ``VIEW_CHANNEL`` denied on the dropbox
            # channel must not receive presigned URLs for files they
            # can't see in the sidebar. Same channel-scope as
            # ``channel_bump`` (see the gate below in
            # pubsub_channel_guild.handle_guild_events).
            "dropbox_entry_created",
            "dropbox_entry_updated",
            "dropbox_entry_deleted",
            "dropbox_entry_restored",
            "dropbox_entry_purged",
            "dropbox_quota_updated",
        }
    )

    def _filter_targets_by_guild(
        self, payload: dict, targets: list[WebSocket]
    ) -> list[WebSocket]:
        """Filter ``targets`` to sockets whose user is in the event's
        ``guild_id``. Used for member/ban events so non-members don't
        receive (and can't sniff in DevTools) per-guild membership
        churn for guilds they aren't in.

        For the kicked/banned user themselves: this filter runs *before*
        ``_apply_guild_membership_update`` on ``guild_member_removed`` (see
        the call order in ``pubsub_channel_guild.handle_guild_events``), so
        the kicked user's guild is still in their ``_ws_guilds`` set when we
        check — they DO receive the event and the client can run its
        drop-guild cleanup. ``guild_ban_added`` is published as a *separate*
        guild:events envelope; by the time it is handled the preceding
        ``guild_member_removed`` has already pruned the guild, so the banned
        user won't see the ban event; acceptable since their UI is already
        gone."""
        op = payload.get("op")
        if op not in self._GUILD_MEMBER_SCOPED_OPS:
            return targets
        try:
            gid = int(payload.get("guild_id", "0"))
        except (TypeError, ValueError):
            return targets
        if not gid:
            return targets
        out: list[WebSocket] = []
        for ws in targets:
            guilds = self._ws_guilds.get(ws)
            if guilds is not None and gid in guilds:
                out.append(ws)
        return out

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
        if not targets:
            # Nothing to filter — skip the DB round-trip entirely.  This also
            # avoids opening a session on the shared StaticPool connection used
            # in tests, which could otherwise hold a DEFERRED transaction open
            # long enough for a concurrent HTTP request to see stale data.
            return targets
        if self._session_factory is None:
            return targets
        try:
            cid_int = int(channel_id)
        except (TypeError, ValueError):
            # Non-parseable channel_id means the channel is unknown — drop the
            # broadcast entirely rather than leaking it to all members.
            return []
        # Channel ids are stored in a signed-64-bit BIGINT column. An id outside
        # that range can't match any real channel and would make asyncpg raise
        # (``value out of int64 range``) — which, before the listener was
        # hardened, killed the whole pubsub task. Treat as unknown → drop, and
        # log so we can trace the client/source that emitted the bad id (a real
        # frontend bug — valid Pulse snowflakes never exceed this range).
        if not (_INT64_MIN <= cid_int <= _INT64_MAX):
            log.warning("broadcast filter: channel_id %s out of int64 range — dropping", cid_int)
            return []
        # Hebel A — resolve the channel's broadcast identity from cache so the
        # hot fan-out path skips the DB entirely. guild_id (>0) marks a guild
        # channel, -1 a DM (no permission overlay → passes unfiltered), 0 a
        # deleted/unknown id. Cached in ``_channel_kind_cache``; invalidated on
        # channel delete / perm change alongside ``_ws_perms``.
        kind = self._channel_kind_cache.get(cid_int)
        if kind is None:
            kind = await self._resolve_channel_kind(cid_int)
            self._channel_kind_cache[cid_int] = kind
        if kind == 0:
            return []
        if kind == -1:
            return targets
        guild_id = kind

        # Collect cold-cache, non-admin sockets (unchanged): a socket whose
        # VIEW bit is already warm skips the batch resolution below. Global
        # admins bypass VIEW_CHANNEL entirely — their flag lives in auth-svc /
        # the JWT (invisible to members_who_can_view), so they are excluded
        # here and resolved lazily by _resolve_channel_perms in the gather.
        cache_miss_sockets: list = []
        cache_miss_uids: list[int] = []
        for ws in targets:
            user = self._ws_user.get(ws)
            if user is None:
                continue
            if user.is_admin:
                continue
            cache = self._ws_perms.get(ws)
            if cache is not None and cid_int in cache:
                continue  # already warm — skip
            cache_miss_sockets.append(ws)
            cache_miss_uids.append(user.id)

        # Hebel B — resolve the VIEW-member set for (guild, channel) from cache
        # so a burst of cold sockets (e.g. reconnect after a deploy) pays the
        # full guild-member scan once, not once per broadcast. Cached in
        # ``_view_members_cache``; invalidated on role / overwrite / membership
        # changes alongside ``_ws_perms``.
        if cache_miss_uids:
            view_key = (guild_id, cid_int)
            can_view_ids = self._view_members_cache.get(view_key)
            if can_view_ids is None:
                from dcc_chat_gateway.permissions import members_who_can_view

                async with self._session_factory() as session:
                    can_view_ids = await members_who_can_view(
                        session, guild_id, cid_int
                    )
                self._view_members_cache[view_key] = can_view_ids
            # Populate the per-socket cache for each cold non-admin socket so
            # the gather below hits only the hot path.  Store VIEW_CHANNEL bit
            # when allowed, 0 when denied — sufficient for can_view_channel().
            for ws, uid in zip(cache_miss_sockets, cache_miss_uids):
                if ws in self._ws_user:
                    allowed = uid in can_view_ids
                    self._ws_perms.setdefault(ws, {})[cid_int] = (
                        _VIEW_CHANNEL_BIT if allowed else 0
                    )

        # All non-admin sockets are warm; admin sockets resolve lazily below.
        results = await asyncio.gather(
            *(self.can_view_channel(ws, cid_int) for ws in targets)
        )
        return [ws for ws, ok in zip(targets, results) if ok]

    async def _resolve_channel_kind(self, cid_int: int) -> int:
        """Resolve a channel id to its broadcast-filter identity: the owning
        guild_id (>0), -1 for a DM (no permission overlay), or 0 for a
        deleted/unknown id. Result is cached in ``_channel_kind_cache`` so the
        hot fan-out path skips this DB round-trip entirely."""
        from dcc_chat_gateway.models import Channel, DirectMessageChannel

        async with self._session_factory() as session:
            ch = await session.get(Channel, cid_int)
            if ch is not None:
                return ch.guild_id
            dm = await session.get(DirectMessageChannel, cid_int)
            return -1 if dm is not None else 0
