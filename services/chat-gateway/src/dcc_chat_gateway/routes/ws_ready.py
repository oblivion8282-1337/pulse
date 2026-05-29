"""WebSocket Ready-Frame builder.

Extracted from :mod:`routes.ws` so the endpoint's auth+lifecycle layer
isn't drowned by the 300+ lines of DB hydration that build the initial
state snapshot sent on every WS connect.

The Ready payload bundles: the user's guilds + roles + their resolved
guild-permissions, DM channels, current voice presence + stream + watch
state, sound-override URLs, friend list + pending requests + blocks +
privacy settings + own/peer presence status. Loading is batched (one
query per topic over the user's guild set) so the round-trip cost stays
bounded as the user count grows.

Side effects beyond ``websocket.send_json``: hydrates the
ConnectionManager's per-socket caches (guild membership for precise
permission-cache invalidation; friend/block sets for the presence
visibility filter), and publishes a ``presence_update`` event when this
is the user's first open socket. All of those need the same data the
Ready frame already loaded — keeping them here avoids a second DB pass.
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import WebSocket
from sqlalchemy import or_, select

from dcc_chat_gateway import s3
from dcc_chat_gateway.db import SessionLocal
from dcc_chat_gateway.friend_events import (
    load_blocks_in,
    load_blocks_out,
)
from dcc_chat_gateway.friend_privacy import (
    DEFAULT_DM_POLICY,
    DEFAULT_FRIEND_REQ_POLICY,
    DEFAULT_SHOW_IN_SEARCH,
)
from dcc_chat_gateway.friend_schemas import FriendRequestOut
from dcc_chat_gateway.models import (
    CHANNEL_TYPE_VOICE,
    Channel,
    DirectMessageChannel,
    FriendRequest,
    Guild,
    GuildMember,
    GuildSoundOverride,
    MemberRole,
    Role,
    UserPrivacy,
)
from dcc_chat_gateway.permissions import (
    resolve_guild_permissions_from_snapshot,
)
from dcc_chat_gateway.presence_status import (
    STATUS_ONLINE,
    get_presence_status_raw,
    get_presence_statuses_bulk,
    load_durable_status,
    set_presence_status,
)
from dcc_chat_gateway.security import AuthenticatedUser

log = logging.getLogger(__name__)


async def build_and_send_ready_frame(
    websocket: WebSocket,
    user: AuthenticatedUser,
    manager,
    redis,
) -> None:
    """Build the initial WS Ready snapshot, hydrate per-socket caches,
    send it to the client, and broadcast ``presence_update(online=True)``
    iff this is the user's first open socket.

    ``manager`` is the :class:`ConnectionManager` from
    ``app.state.connection_manager`` — typed as plain ``Any`` to avoid a
    circular import with :mod:`pubsub`. ``redis`` is the same
    ``app.state.redis`` instance the endpoint already holds.
    """

    # Send "ready" with the user's guild list + DM channel list + the current
    # voice-channel presence state + the current HQ-stream state for those
    # guilds. Each guild carries its role list + this user's resolved
    # guild-wide permissions, so the frontend can gate UI affordances
    # without round-tripping the API for every guild. Channel overwrites
    # and per-channel resolved permissions are *not* eager-loaded — the
    # frontend fetches those when the user opens the relevant channel.
    async with SessionLocal() as session:
        guild_stmt = (
            select(Guild)
            .join(GuildMember, GuildMember.guild_id == Guild.id)
            .where(GuildMember.user_id == user.id)
            .order_by(Guild.id)
        )
        guild_rows = list((await session.execute(guild_stmt)).scalars())
        guild_ids = [g.id for g in guild_rows]
        # Batched fetch of all roles across the user's guilds — one query
        # rather than N. Same for the user's role assignments.
        roles_by_guild: dict[int, list[Role]] = {gid: [] for gid in guild_ids}
        my_role_ids: dict[int, list[int]] = {gid: [] for gid in guild_ids}
        if guild_ids:
            role_rows = list(
                (
                    await session.execute(
                        select(Role)
                        .where(Role.guild_id.in_(guild_ids))
                        .order_by(Role.guild_id, Role.position.desc(), Role.id)
                    )
                ).scalars()
            )
            for role in role_rows:
                roles_by_guild.setdefault(role.guild_id, []).append(role)
            my_mr_rows = list(
                (
                    await session.execute(
                        select(MemberRole).where(
                            MemberRole.guild_id.in_(guild_ids),
                            MemberRole.user_id == user.id,
                        )
                    )
                ).scalars()
            )
            for mr in my_mr_rows:
                my_role_ids.setdefault(mr.guild_id, []).append(mr.role_id)
        # Sound overrides: batched across the user's guilds → presigned-GET
        # URLs per (guild, sound_id). Ready ships the URL set in one shot
        # so the engine can pre-resolve guild→sound_id→url maps without
        # an extra fetch on connection. URLs expire (default 30 min) — the
        # ``guild_sound_updated`` WS event triggers a re-fetch on change.
        sound_overrides_by_guild: dict[int, list[dict[str, str]]] = {
            gid: [] for gid in guild_ids
        }
        if guild_ids:
            sound_rows = list(
                (
                    await session.execute(
                        select(GuildSoundOverride).where(
                            GuildSoundOverride.guild_id.in_(guild_ids)
                        )
                    )
                ).scalars()
            )
            # Sign all overrides in parallel — serial awaits here used to add
            # 5–30 ms per row to Ready (one aiobotocore client-create each,
            # back when s3.py wasn't using a singleton). Even with the
            # singleton the SigV4 work is still parallelizable for free.
            urls = await asyncio.gather(
                *(s3.presigned_get_url(srow.storage_key) for srow in sound_rows)
            )
            for srow, url in zip(sound_rows, urls):
                sound_overrides_by_guild.setdefault(srow.guild_id, []).append(
                    {"sound_id": srow.sound_id, "url": url}
                )
        guilds = []
        for g in guild_rows:
            # Reuse the batched data instead of letting ``resolve_permissions``
            # re-query the DB (3 SELECTs/guild on top of an already-known
            # member set). Build the per-guild member-role set from
            # ``my_role_ids`` (explicit assignments) + the implicit
            # @everyone role found in ``roles_by_guild``.
            guild_roles = roles_by_guild.get(g.id, [])
            my_role_id_set = set(my_role_ids.get(g.id, []))
            member_roles_snapshot: list[Role] = [
                r
                for r in guild_roles
                if r.id in my_role_id_set or r.is_everyone
            ]
            my_perms = resolve_guild_permissions_from_snapshot(
                user, g.owner_id, member_roles_snapshot
            )
            guilds.append(
                {
                    "id": str(g.id),
                    "name": g.name,
                    # Ship icon_url + created_at so the frontend doesn't need
                    # the extra `GET /guilds` round-trip just to render the
                    # GuildRail. With these fields present in Ready, the
                    # parallel REST hydrate is fully redundant.
                    "icon_url": g.icon_url,
                    "created_at": g.created_at.isoformat(),
                    "owner_id": str(g.owner_id),
                    "my_permissions": str(my_perms),
                    "my_role_ids": [str(rid) for rid in my_role_ids.get(g.id, [])],
                    "sound_overrides": sound_overrides_by_guild.get(g.id, []),
                    "roles": [
                        {
                            "id": str(r.id),
                            "name": r.name,
                            "permissions": str(r.permissions),
                            "color": r.color,
                            "position": r.position,
                            "hoist": r.hoist,
                            "mentionable": r.mentionable,
                            "is_everyone": r.is_everyone,
                        }
                        for r in roles_by_guild.get(g.id, [])
                    ],
                }
            )
        voice_channel_ids: list[str] = []
        if guild_ids:
            vc_stmt = select(Channel.id).where(
                Channel.guild_id.in_(guild_ids), Channel.type == CHANNEL_TYPE_VOICE
            )
            voice_channel_ids = [str(cid) for cid in (await session.execute(vc_stmt)).scalars()]

        dm_stmt = (
            select(DirectMessageChannel)
            .where(
                or_(
                    DirectMessageChannel.user_a_id == user.id,
                    DirectMessageChannel.user_b_id == user.id,
                )
            )
            .order_by(
                DirectMessageChannel.last_message_id.desc().nullslast(),
                DirectMessageChannel.id.desc(),
            )
        )
        dm_rows = list((await session.execute(dm_stmt)).scalars())

        # ---- Etappe-2 friend-system payload (friends / pending requests /
        # blocks / privacy). Loaded as a single small batch so the Ready
        # round-trip stays one DB chunk. ``friend_set`` + ``blocks_*`` feed
        # both the Ready frame AND the ConnectionManager's per-socket caches
        # (hydrated below). ``friend_since`` is the per-friend "since"
        # timestamp that the FE shows on the friends panel — built in the
        # same SELECT to avoid an N+1.
        from dcc_chat_gateway.models import Friendship as _Friendship

        friendship_rows = list(
            (
                await session.execute(
                    select(_Friendship).where(
                        or_(
                            _Friendship.user_a_id == user.id,
                            _Friendship.user_b_id == user.id,
                        )
                    )
                )
            ).scalars()
        )
        friend_since: dict[int, str] = {}
        friend_set: set[int] = set()
        for fr in friendship_rows:
            other = fr.user_b_id if fr.user_a_id == user.id else fr.user_a_id
            friend_set.add(other)
            friend_since[other] = fr.created_at.isoformat()
        blocks_out_set = await load_blocks_out(session, user.id)
        blocks_in_set = await load_blocks_in(session, user.id)
        req_in_rows = list(
            (
                await session.execute(
                    select(FriendRequest)
                    .where(FriendRequest.receiver_id == user.id)
                    .order_by(FriendRequest.created_at.desc())
                )
            ).scalars()
        )
        req_out_rows = list(
            (
                await session.execute(
                    select(FriendRequest)
                    .where(FriendRequest.sender_id == user.id)
                    .order_by(FriendRequest.created_at.desc())
                )
            ).scalars()
        )
        privacy_row = await session.get(UserPrivacy, user.id)
        # ``can_send`` per DM = friendship + no block. We already have both
        # sets; intersect in-memory.
        dm_channels = []
        for d in dm_rows:
            other = d.user_b_id if d.user_a_id == user.id else d.user_a_id
            can_send = (
                other in friend_set
                and other not in blocks_out_set
                and other not in blocks_in_set
            )
            dm_channels.append(
                {
                    "id": str(d.id),
                    "other_user_id": str(other),
                    "last_message_id": (
                        str(d.last_message_id) if d.last_message_id is not None else None
                    ),
                    "created_at": d.created_at.isoformat(),
                    "can_send": can_send,
                }
            )

    # Hand the manager this socket's guild membership so precise cache
    # invalidation (on role mutations, guild_updated, etc.) only busts the
    # caches of sockets actually in the affected guild. Same list the
    # ``ready`` frame is built from — no extra query. Updates after this
    # point are live-applied in the manager's listener from
    # ``guild_member_added`` / ``guild_deleted`` events.
    await manager.set_guild_membership(websocket, guild_ids)

    # HQ streaming + watch parties only happen in voice channels, so the
    # relevant channel set is the same one. Force-mute / force-deafen
    # overrides round out the snapshot so a freshly-reconnected client sees
    # who's currently muted by a mod without waiting for the next toggle.
    # All four are independent Redis reads — gather them so a slow Redis
    # roundtrip doesn't get multiplied by four.
    voice_states, stream_states, watch_states, voice_overrides = await asyncio.gather(
        manager.voice_states_for(voice_channel_ids),
        manager.stream_states_for(voice_channel_ids),
        manager.watch_states_for(voice_channel_ids),
        manager.voice_overrides_for(voice_channel_ids),
    )

    # Etappe-3 presence status: own status (real) + visible users' statuses
    # (masked). We batch-read for friends + guild members to build the map.
    # Visible peers: union of confirmed friends and all guild members.
    all_peer_ids: set[int] = set(friend_set)
    if guild_ids:
        async with SessionLocal() as session:
            from sqlalchemy import select as _select

            from dcc_chat_gateway.models import GuildMember as _GM

            peer_rows = list(
                (
                    await session.execute(
                        _select(_GM.user_id).where(
                            _GM.guild_id.in_(guild_ids),
                            _GM.user_id != user.id,
                        )
                    )
                ).scalars()
            )
            all_peer_ids.update(peer_rows)

    own_presence_status = await get_presence_status_raw(redis, user.id)
    if own_presence_status is None:
        # Redis key expired (>24 h offline) or this is a fresh connect — restore
        # the durably-mirrored manual choice so invisible/dnd survive the TTL.
        # Reseed Redis so the live status is consistent for the rest of the
        # session (the idle sweeper + activity op read it from there).
        async with SessionLocal() as session:
            durable = await load_durable_status(session, user.id)
        if durable is not None:
            own_presence_status = durable
            await set_presence_status(redis, user.id, durable)
        else:
            own_presence_status = STATUS_ONLINE
    peer_statuses_raw = await get_presence_statuses_bulk(redis, list(all_peer_ids))
    # Mask invisible → offline for all peers (own status is delivered real).
    from dcc_chat_gateway.presence_status import _mask as _psmask

    user_presence_statuses: dict[str, str] = {
        str(uid): _psmask(st) for uid, st in peer_statuses_raw.items()
    }

    # Hydrate the per-socket friend/block caches in the same loop so the
    # very first mention fan-out / presence broadcast against this socket
    # sees a warm state (no DB round-trip).
    await manager.hydrate_friend_caches(
        websocket,
        friends=friend_set,
        blocks_out=blocks_out_set,
        blocks_in=blocks_in_set,
    )

    # Privacy row: defaults when no row exists yet (fresh account).
    if privacy_row is None:
        privacy_dict = {
            "dm_policy": DEFAULT_DM_POLICY,
            "friend_request_policy": DEFAULT_FRIEND_REQ_POLICY,
            "show_in_search": DEFAULT_SHOW_IN_SEARCH,
        }
    else:
        privacy_dict = {
            "dm_policy": privacy_row.dm_policy,
            "friend_request_policy": privacy_row.friend_request_policy,
            "show_in_search": privacy_row.show_in_search,
        }

    await websocket.send_json(
        {
            "op": "ready",
            "user_id": str(user.id),
            # Admin status for THIS server (cloud: from auth.users; self-host:
            # the instance owner, set at cert-login). Lets the client gate the
            # admin panel per active server without an auth-svc /me round-trip.
            "is_admin": user.is_admin,
            "guilds": guilds,
            "dm_channels": dm_channels,
            "voice_states": voice_states,
            "stream_states": stream_states,
            "watch_states": watch_states,
            "voice_overrides": voice_overrides,
            "online_user_ids": manager.online_user_ids(),
            # Etappe 2 friend-system Ready payload — clients seed their
            # stores from this and live-sync via the lifecycle WS events.
            "friends": [
                {"user_id": str(uid), "since": friend_since[uid]}
                for uid in sorted(friend_set)
            ],
            "friend_requests_in": [
                FriendRequestOut.model_validate(r).model_dump(mode="json")
                for r in req_in_rows
            ],
            "friend_requests_out": [
                FriendRequestOut.model_validate(r).model_dump(mode="json")
                for r in req_out_rows
            ],
            "blocked_user_ids": [str(u) for u in sorted(blocks_out_set)],
            "privacy": privacy_dict,
            # Etappe-3 presence status payload.
            # ``presence_status``: the caller's own real status (never masked).
            # ``user_presence_statuses``: map of visible peers → masked status.
            "presence_status": own_presence_status,
            "user_presence_statuses": user_presence_statuses,
        }
    )

    # Presence broadcast goes out AFTER `ready` so the listener loop cannot
    # race a ``presence_update`` ahead of this socket's own ``ready`` frame
    # (Redis publish + fan-out runs concurrently with this coroutine, and
    # the listener would otherwise deliver our own first-connect event to
    # us before we've sent ready).
    if manager.user_socket_count(user.id) == 1:
        try:
            await manager.broadcast_presence_update(str(user.id), online=True)
        except Exception:  # noqa: BLE001
            log.exception(
                "broadcast_presence_update(online=True) failed for user=%s", user.id
            )
