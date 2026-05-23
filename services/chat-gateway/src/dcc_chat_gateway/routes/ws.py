"""WebSocket endpoint: subscribe / unsubscribe / send fan-out.

Server→client ops, in addition to the chat ops in PLAN.md §5.2:
  - ``{"op": "voice_state", "channel_id": "<id>", "user_ids": ["<id>", ...]}``
    — pushed whenever a voice channel's membership changes (relayed from the
    voice-signaling service over Redis ``voice:events``). Clients filter by
    their own guild membership. The ``ready`` payload additionally carries
    ``voice_states: [{"channel_id": ..., "user_ids": [...]}, ...]`` with the
    current state of every voice channel in the user's guilds.
  - ``{"op": "stream_state", "channel_id": "<id>", "user_id": "<id>"|null,
    "active": true|false}`` — pushed whenever a channel's HQ stream starts or
    stops (relayed from media-svc over Redis ``stream:events``; T5b). Mirrors
    the voice_state mechanism. The ``ready`` payload additionally carries
    ``stream_states: [{"channel_id": ..., "user_id": ...}, ...]`` listing every
    channel in the user's guilds that currently has an active HQ stream.

Client→server ops, in addition to ``subscribe``/``unsubscribe``/``send``:
  - ``{"op": "voice_self_state", "channel_id": "<id>"|null,
       "mic_muted": bool, "deafened": bool}`` — the user reports their own
    mute/deafen state to the gateway. ``channel_id`` is the voice channel they
    are currently in (or ``null`` to clear state on disconnect). The gateway
    persists the state in Redis and republishes the channel's voice snapshot
    so other clients re-render their member list. Both flags off + a channel
    id deletes the Redis key (absence == default-off).
  - ``{"op": "watch_start", "channel_id": "<id>", "source_url": "<url>"}`` —
    start a synchronised watch party in a voice channel. URL is validated via
    ``watch_source.parse_source``; caller becomes host. Rejected if a party is
    already active.
  - ``{"op": "watch_stop", "channel_id": "<id>"}`` — host-only; deletes state.
  - ``{"op": "watch_control", "channel_id": "<id>", "action":
       "play"|"pause"|"seek", "position": <seconds>}`` — host-only; updates
    state + broadcasts ``watch_state``.
  - ``{"op": "watch_heartbeat", "channel_id": "<id>", "position": <seconds>}``
    — host-only; updates ``position`` + ``updated_at`` so viewers can correct
    drift. Debounced server-side to ≤1 write / 2s.

The ``ready`` payload additionally carries
``watch_states: [{"channel_id": ..., "state": {...}}, ...]`` for every voice
channel in the user's guilds that has an active watch party. Server pushes
``{"op": "watch_state", "channel_id": ..., "state": {...}|null}`` whenever
state changes (null = party ended).
"""

from __future__ import annotations

import asyncio
import json
import logging
import time

from dcc_shared.permission_resolver import has_permission
from dcc_shared.permissions import Permissions
from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect
from sqlalchemy import or_, select, update

from dcc_chat_gateway import ratelimit, s3
from dcc_chat_gateway.db import SessionLocal
from dcc_chat_gateway.friend_events import (
    load_blocks_in,
    load_blocks_out,
)
from dcc_chat_gateway.friend_helpers import (
    block_exists_either_way,
    friendship_exists,
)
from dcc_chat_gateway.friend_privacy import (
    DEFAULT_DM_POLICY,
    DEFAULT_FRIEND_REQ_POLICY,
    DEFAULT_SHOW_IN_SEARCH,
)
from dcc_chat_gateway.friend_schemas import FriendRequestOut
from dcc_chat_gateway.mentions import (
    MENTION_EVERYONE_RE,
    fan_out_mention_events,
    filter_to_valid,
    parse_markers,
    persist_for_message,
)
from dcc_chat_gateway.models import (
    CHANNEL_TYPE_TEXT,
    CHANNEL_TYPE_VOICE,
    Channel,
    DirectMessageChannel,
    FriendRequest,
    Guild,
    GuildMember,
    GuildSoundOverride,
    MemberRole,
    Message,
    Role,
    UserPrivacy,
)
from dcc_chat_gateway.permissions import (
    resolve_guild_permissions_from_snapshot,
    resolve_permissions,
)
from dcc_chat_gateway.push import fan_out_mention_push
from dcc_chat_gateway.routes import ws_watch
from dcc_chat_gateway.routes._deps import channel_membership, resolve_channel_for_user
from dcc_chat_gateway.routes.messages import serialize_message
from dcc_chat_gateway.presence_status import (
    STATUS_DND,
    STATUS_INVISIBLE,
    STATUS_ONLINE,
    broadcast_presence_status_changed,
    get_presence_status,
    get_presence_statuses_bulk,
    set_presence_status,
    update_activity,
)
from dcc_chat_gateway.security import AuthenticatedUser, decode_token
from dcc_chat_gateway.snowflake import next_id

log = logging.getLogger(__name__)

router = APIRouter()

# Largest text frame we are willing to buffer from a client. uvicorn should
# additionally be deployed with `--ws-max-size` for defense in depth — this
# check is the application-level backstop against a memory-DoS via huge frames.
_MAX_WS_FRAME_BYTES = 16 * 1024

# A single oversized frame is more likely a client bug (a long paste, a runaway
# loop) than an attack — answer with an error frame and keep the session. Only
# repeated abuse closes it.
_MAX_OVERSIZE_FRAMES = 5

# nonce column is VARCHAR(64); trim defensively so a long client nonce can't
# trigger a Postgres StringDataRightTruncation.
_MAX_NONCE_LEN = 64


async def _close_when_token_expires(websocket: WebSocket, exp: float) -> None:
    """Close the socket with 4001 once the access token's `exp` passes, so a
    WS connection never outlives the credential that authorised it. Cancelled
    by the endpoint on disconnect."""
    delay = exp - time.time()
    if delay > 0:
        await asyncio.sleep(delay)
    try:
        await websocket.close(code=4001, reason="token expired")
    except Exception:  # noqa: BLE001 — already closed
        pass


def _channel_id(value: object) -> int | None:
    """Parse a client-supplied channel id to int, or None if malformed."""
    s = str(value or "").strip()
    if not s:
        return None
    try:
        return int(s)
    except ValueError:
        return None


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, token: str = Query(...)):
    # Authenticate before accepting subprotocols.
    try:
        payload = await decode_token(token)
        user_id = int(payload["sub"])
        user = AuthenticatedUser(
            id=user_id,
            username=payload.get("username", ""),
            is_admin=bool(payload.get("admin", False)),
            payload=payload,
        )
    except (HTTPException, KeyError, ValueError):
        await websocket.close(code=4001, reason="unauthorized")
        return

    # Email-verification gate: a token carrying ``email_blocked`` belongs to
    # an unverified account on an SMTP-configured deployment. Distinct close
    # code (4003) so the client can route to the "verify your email" screen
    # instead of treating it as a generic auth failure.
    if payload.get("email_blocked"):
        await websocket.close(code=4003, reason="email not verified")
        return

    # Reject already-expired tokens before accepting — avoids sending `ready`
    # followed immediately by a 4001 close (inconsistent client state).
    exp = payload.get("exp")
    if isinstance(exp, (int, float)) and float(exp) < time.time():
        await websocket.close(code=4001, reason="token expired")
        return

    await websocket.accept()
    app = websocket.app
    manager = app.state.connection_manager
    if not await manager.register(websocket, user):
        # Connection cap reached — close before the client has done any work.
        await websocket.close(code=4009, reason="too many connections")
        return
    # cid → guild_id (for guild channels) or None (for DM channels).
    # Cached on successful subscribe so the `send` fast path can stamp the
    # channel_bump envelope without another DB round-trip per message.
    # The `in subscribed` check stays the authoritative "is this cid
    # already trusted by this socket?" question — DMs use None as value.
    subscribed: dict[str, int | None] = {}
    # Channel ids of watch parties this socket has started. Used at disconnect
    # time to end parties when the host's last socket goes away.
    hosted_parties: set[str] = set()
    oversize_frames = 0
    # Track the voice channel this socket's user is currently in, as reported
    # by voice_self_state ops. Used to republish a clean snapshot on disconnect.
    current_voice_channel: str | None = None

    # Tie the connection's lifetime to the token's `exp`: when it passes, the
    # background task closes the socket with 4001 (the client then refreshes +
    # reconnects).
    expiry_task: asyncio.Task | None = None
    if isinstance(exp, (int, float)):
        expiry_task = asyncio.create_task(
            _close_when_token_expires(websocket, float(exp)), name="dcc-ws-token-expiry"
        )

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
    redis = websocket.app.state.redis
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

    own_presence_status = await get_presence_status(redis, user.id)
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
            log.exception("broadcast_presence_update(online=True) failed for user=%s", user.id)

    try:
        while True:
            try:
                raw = await websocket.receive_text()
            except WebSocketDisconnect:
                break
            if len(raw) > _MAX_WS_FRAME_BYTES:
                oversize_frames += 1
                await websocket.send_json(
                    {"op": "error", "code": 4009, "msg": "frame too large"}
                )
                if oversize_frames >= _MAX_OVERSIZE_FRAMES:
                    break
                continue
            oversize_frames = max(0, oversize_frames - 1)
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json({"op": "error", "code": 4002, "msg": "invalid JSON"})
                continue
            if not isinstance(msg, dict):
                await websocket.send_json({"op": "error", "code": 4002, "msg": "invalid JSON"})
                continue
            op = msg.get("op")
            if op == "subscribe":
                cid_int = _channel_id(msg.get("channel_id"))
                if cid_int is None:
                    await websocket.send_json(
                        {"op": "error", "code": 4003, "msg": "channel_id required"}
                    )
                    continue
                cid = str(cid_int)
                # DM channels go through the same /ws subscribe path as guild
                # channels — resolve_channel_for_user enforces the right
                # access check (guild membership vs DM membership). For guild
                # channels we additionally require VIEW_CHANNEL — otherwise
                # subscribe would succeed but the broadcast filter would drop
                # every message later, producing a confusing silent-channel UX.
                async with SessionLocal() as session:
                    resolved = await resolve_channel_for_user(session, cid_int, user.id)
                    if resolved is None:
                        await websocket.send_json(
                            {"op": "error", "code": 4004, "msg": "channel not accessible"}
                        )
                        continue
                    kind, ch = resolved
                    # Text-channel subscribes get the VIEW_CHANNEL gate so
                    # silent-channel UX doesn't bite the user. Voice channels
                    # subscribe via this same path (for stream_chat_message
                    # fan-out) and must NOT be gated — denying VIEW on a
                    # voice channel still lets you join the voice room (the
                    # CONNECT bit is the real voice-join gate). Live filter
                    # at fan-out time catches any remaining mismatch.
                    if kind == "guild" and ch.type == CHANNEL_TYPE_TEXT:
                        perms = await resolve_permissions(
                            session, user, ch.guild_id, cid_int
                        )
                        if not has_permission(perms, Permissions.VIEW_CHANNEL):
                            await websocket.send_json(
                                {
                                    "op": "error",
                                    "code": 4012,
                                    "msg": "channel not accessible",
                                }
                            )
                            continue
                await manager.subscribe(websocket, cid)
                # Voice channels are subscribed (for stream_chat_message fanout)
                # but never enter the local `subscribed` map, so the send
                # fast-path can't post regular messages to them — the slow path
                # rejects them via the same CHANNEL_TYPE_TEXT check below.
                if kind == "guild" and ch.type != CHANNEL_TYPE_TEXT:
                    continue
                subscribed[cid] = ch.guild_id if kind == "guild" else None
            elif op == "unsubscribe":
                cid_int = _channel_id(msg.get("channel_id"))
                if cid_int is not None:
                    cid = str(cid_int)
                    await manager.unsubscribe(websocket, cid)
                    subscribed.pop(cid, None)
            elif op == "send":
                cid_int = _channel_id(msg.get("channel_id"))
                content = msg.get("content")
                nonce = msg.get("nonce")
                reply_to_raw = msg.get("reply_to_id")
                if cid_int is None or not isinstance(content, str) or not content.strip():
                    # Match the REST endpoint: whitespace-only is rejected as
                    # empty (messages.py:165 uses the same .strip() guard).
                    await websocket.send_json(
                        {"op": "error", "code": 4005, "msg": "invalid send payload"}
                    )
                    continue
                # Reject over-long content explicitly instead of silently
                # truncating to 4000 — the REST endpoint also rejects with 422,
                # so the WS path matches that semantics.
                if len(content) > 4000:
                    await websocket.send_json(
                        {"op": "error", "code": 4005, "msg": "content too long (max 4000)"}
                    )
                    continue
                cid = str(cid_int)
                if not ratelimit.check("message", user.id):
                    await websocket.send_json(
                        {"op": "error", "code": 4290, "msg": "rate limit exceeded"}
                    )
                    continue
                # Reply target is optional; accept int or numeric string from JS clients.
                reply_to_int: int | None = None
                if reply_to_raw is not None:
                    try:
                        reply_to_int = int(reply_to_raw)
                    except (TypeError, ValueError):
                        await websocket.send_json(
                            {"op": "error", "code": 4005, "msg": "invalid reply_to_id"}
                        )
                        continue
                async with SessionLocal() as session:
                    # Fast path: if this socket already subscribed, the channel
                    # kind + access were validated then — skip the membership
                    # lookup. ``subscribed[cid]`` is the guild_id for guild
                    # channels, None for DMs. Trade-off: if a guild user is
                    # kicked while still subscribed, they can keep sending
                    # until they reconnect. Accepted MVP behaviour.
                    kind: str | None = None
                    guild_id_for_bump: int | None = None
                    # (user_a_id, user_b_id) for the dm_bump envelope. Filled
                    # by a small SELECT when kind == "dm".
                    dm_pair: tuple[int, int] | None = None
                    if cid in subscribed:
                        gid = subscribed[cid]
                        kind = "dm" if gid is None else "guild"
                        guild_id_for_bump = gid
                        if kind == "dm":
                            dm_obj = await session.get(DirectMessageChannel, cid_int)
                            if dm_obj is not None:
                                dm_pair = (dm_obj.user_a_id, dm_obj.user_b_id)
                        ok = True
                    else:
                        resolved = await resolve_channel_for_user(
                            session, cid_int, user.id
                        )
                        if resolved is None:
                            ok = False
                        else:
                            kind, ch = resolved
                            if kind == "guild" and ch.type != CHANNEL_TYPE_TEXT:
                                ok = False
                            else:
                                ok = True
                                if kind == "guild":
                                    guild_id_for_bump = ch.guild_id
                                else:
                                    dm_pair = (ch.user_a_id, ch.user_b_id)
                    if not ok:
                        await websocket.send_json(
                            {"op": "error", "code": 4006, "msg": "channel not accessible"}
                        )
                        continue
                    # Etappe 2 friend-gate for DMs (mirrors routes/messages.py
                    # POST /channels/{id}/messages). A historical DM (pre-
                    # friend-cut) cannot send any more. Errors share the same
                    # 4014 code so the FE can branch on the detail string.
                    if kind == "dm" and dm_pair is not None:
                        other = (
                            dm_pair[1] if dm_pair[0] == user.id else dm_pair[0]
                        )
                        if await block_exists_either_way(session, user.id, other):
                            await websocket.send_json(
                                {"op": "error", "code": 4014, "msg": "blocked"}
                            )
                            continue
                        if not await friendship_exists(session, user.id, other):
                            await websocket.send_json(
                                {"op": "error", "code": 4014, "msg": "not_friends"}
                            )
                            continue
                    # SEND_MESSAGES gate for guild channels. Mirrors the REST
                    # `POST /channels/{id}/messages` check; DMs bypass (no
                    # channel overwrites apply). VIEW_CHANNEL alone is not
                    # enough — a member may be allowed to read but not post.
                    # Resolved author permissions — drives the SEND_MESSAGES
                    # gate, the MENTION_EVERYONE gate, and the @-mention
                    # validation below. Stays 0 for DMs (no permission overlay
                    # there — ``filter_to_valid`` treats 0 as "no override").
                    author_perms = 0
                    if kind == "guild" and guild_id_for_bump is not None:
                        author_perms = await resolve_permissions(
                            session, user, guild_id_for_bump, cid_int
                        )
                        if not has_permission(author_perms, Permissions.SEND_MESSAGES):
                            await websocket.send_json(
                                {
                                    "op": "error",
                                    "code": 4013,
                                    "msg": "cannot send in this channel",
                                }
                            )
                            continue
                        # Mirror the REST endpoint: an @everyone/@here marker
                        # from someone without MENTION_EVERYONE is rejected
                        # rather than silently delivered.
                        if MENTION_EVERYONE_RE.search(content) and not has_permission(
                            author_perms, Permissions.MENTION_EVERYONE
                        ):
                            await websocket.send_json(
                                {
                                    "op": "error",
                                    "code": 4013,
                                    "msg": "missing permission: MENTION_EVERYONE",
                                }
                            )
                            continue
                    if reply_to_int is not None:
                        parent = await session.get(Message, reply_to_int)
                        if (
                            parent is None
                            or parent.channel_id != cid_int
                            or parent.deleted_at is not None
                        ):
                            await websocket.send_json(
                                {
                                    "op": "error",
                                    "code": 4008,
                                    "msg": "reply target not found in this channel",
                                }
                            )
                            continue
                    persisted = Message(
                        id=next_id(),
                        channel_id=cid_int,
                        author_id=user.id,
                        content=content,
                        nonce=nonce[:_MAX_NONCE_LEN] if isinstance(nonce, str) else None,
                        reply_to_id=reply_to_int,
                    )
                    session.add(persisted)
                    # Parse + persist @-mentions so WS-sent messages get the
                    # same pill rendering / counters as the REST POST path.
                    # ``guild_id_for_bump`` is the guild id for guild channels
                    # and None for DMs — exactly the scope filter_to_valid
                    # expects.
                    valid_mentions = await filter_to_valid(
                        session,
                        guild_id=guild_id_for_bump,
                        author_permissions=author_perms,
                        candidates=parse_markers(content),
                    )
                    await persist_for_message(
                        session,
                        message_id=persisted.id,
                        mentions=valid_mentions,
                        replace=False,
                    )
                    if kind == "dm":
                        # Bump last_message_id so the DM list can sort by
                        # recency. UPDATE-only to avoid loading the row.
                        await session.execute(
                            update(DirectMessageChannel)
                            .where(DirectMessageChannel.id == cid_int)
                            .values(last_message_id=persisted.id)
                        )
                    await session.commit()
                    await session.refresh(persisted)
                await websocket.send_json(
                    {"op": "message_ack", "nonce": nonce, "id": str(persisted.id)}
                )
                mentions_serial = [
                    {"type": t, "id": str(tid)} for (t, tid) in sorted(valid_mentions)
                ]
                # Publish is best-effort: message is already persisted, so a Redis
                # failure must not kill the WS connection.
                try:
                    await manager.publish(
                        cid, serialize_message(persisted, mentions=mentions_serial)
                    )
                except Exception:
                    log.exception("ws publish failed for channel %s (message persisted)", cid)
                # Cross-channel mention fan-out (in-app counter bump) + web-push,
                # mirroring routes/messages.py. Best-effort — a fan-out hiccup
                # must not break the WS session (message is already persisted).
                notified: set[int] = set()
                try:
                    # Fresh short-lived session — the send-path session above
                    # is already closed; the fan-out only does read-only
                    # role/member/overwrite lookups.
                    async with SessionLocal() as fanout_session:
                        notified = await fan_out_mention_events(
                            websocket,
                            session=fanout_session,
                            mentions=valid_mentions,
                            message_id=persisted.id,
                            channel_id=cid_int,
                            guild_id=guild_id_for_bump,
                            author_id=user.id,
                        )
                except Exception:
                    log.exception("ws mention fan-out failed for channel %s", cid)
                if notified:
                    # Same audience as the in-window ``mention_added`` envelope —
                    # role + everyone pings already expanded + VIEW-filtered +
                    # author-excluded. ``fan_out_mention_push`` never raises.
                    await fan_out_mention_push(
                        user_ids=notified,
                        author_name=user.username,
                        content=content,
                        channel_id=cid_int,
                        message_id=persisted.id,
                        guild_id=guild_id_for_bump,
                    )
                # Mirror routes/messages.py: lightweight global bump so clients
                # NOT subscribed to this channel can flag it as unread. Guild
                # channels emit channel_bump; DMs emit dm_bump with the
                # (a, b) pair so receiving clients can decide locally whether
                # they're a member (no per-user routing in Phase 1).
                if guild_id_for_bump is not None:
                    try:
                        await manager.publish_guild_event(
                            {
                                "op": "channel_bump",
                                "guild_id": str(guild_id_for_bump),
                                "channel_id": cid,
                                "message_id": str(persisted.id),
                                "author_id": str(user.id),
                            }
                        )
                    except Exception:
                        log.exception("ws guild_event publish failed for channel %s", cid)
                elif kind == "dm" and dm_pair is not None:
                    try:
                        await manager.publish_guild_event(
                            {
                                "op": "dm_bump",
                                "channel_id": cid,
                                "user_a_id": str(dm_pair[0]),
                                "user_b_id": str(dm_pair[1]),
                                "message_id": str(persisted.id),
                                "author_id": str(user.id),
                            }
                        )
                    except Exception:
                        log.exception("ws dm_bump publish failed for channel %s", cid)
            elif op == "voice_self_state":
                cid_raw = msg.get("channel_id")
                cid_int: int | None = None
                if cid_raw is not None:
                    cid_int = _channel_id(cid_raw)
                    if cid_int is None:
                        await websocket.send_json(
                            {"op": "error", "code": 4011, "msg": "invalid channel_id"}
                        )
                        continue
                mic_muted = bool(msg.get("mic_muted"))
                deafened = bool(msg.get("deafened"))
                cid_str: str | None = None
                if cid_int is not None:
                    # Validate membership only when a channel id is given. We
                    # require the channel to be a voice channel — text channels
                    # have no voice state.
                    async with SessionLocal() as session:
                        channel = await channel_membership(session, cid_int, user.id)
                    if channel is None or channel.type != CHANNEL_TYPE_VOICE:
                        await websocket.send_json(
                            {"op": "error", "code": 4004, "msg": "channel not accessible"}
                        )
                        continue
                    cid_str = str(cid_int)
                current_voice_channel = cid_str
                try:
                    await manager.set_user_voice_state(
                        str(user.id), mic_muted, deafened, cid_str
                    )
                except Exception:
                    log.exception("voice_self_state write failed for user=%s", user.id)
            elif op == "watch_start":
                await ws_watch.handle_start(
                    websocket,
                    user,
                    msg,
                    session_factory=SessionLocal,
                    hosted_parties=hosted_parties,
                )
            elif op == "watch_stop":
                await ws_watch.handle_stop(
                    websocket, user, msg, hosted_parties=hosted_parties
                )
            elif op == "watch_control":
                await ws_watch.handle_control(websocket, user, msg)
            elif op == "watch_heartbeat":
                await ws_watch.handle_heartbeat(websocket, user, msg)
            elif op == "activity":
                # Etappe-3: client heartbeat / mouse-move / key-press.
                # Update the presence:activity ZSET and, if the user's current
                # status is ``idle``, flip it back to ``online`` and broadcast.
                # DND / invisible are manual overrides — not overwritten.
                try:
                    await update_activity(redis, user.id)
                    current_status = await get_presence_status(redis, user.id)
                    if current_status == STATUS_ONLINE:
                        pass  # already online, nothing to broadcast
                    elif current_status not in (STATUS_DND, STATUS_INVISIBLE):
                        # Was idle → return to online
                        await set_presence_status(redis, user.id, STATUS_ONLINE)
                        await broadcast_presence_status_changed(
                            manager, redis, user.id, STATUS_ONLINE
                        )
                except Exception:  # noqa: BLE001
                    log.exception("activity op failed for user=%s", user.id)
                # No reply — lightweight, fire-and-forget
            else:
                await websocket.send_json({"op": "error", "code": 4007, "msg": f"unknown op: {op}"})
    finally:
        if expiry_task is not None:
            expiry_task.cancel()
            try:
                await expiry_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        # Watch parties are NOT auto-cleaned on socket close: a brief network
        # blip / page refresh would otherwise kill the host's party while
        # they're trying to reconnect. Explicit user actions (PhoneOff,
        # channel switch, X-on-tile) end the party via the watch_stop op;
        # everything else falls through to the 6h Redis TTL.
        await manager.remove_socket(websocket)
        if manager.user_socket_count(user.id) == 0:
            try:
                await manager.broadcast_presence_update(str(user.id), online=False)
            except Exception:  # noqa: BLE001
                log.exception("broadcast_presence_update(online=False) failed for user=%s", user.id)
        # If this was the user's last open socket, drop their self-mute state.
        # Without this, voice:user_state:<id> lingers for the full 6h TTL and
        # the user keeps appearing as muted to everyone after they disconnect.
        # Multi-tab users keep their state until the last tab closes.
        if manager.user_socket_count(user.id) == 0:
            try:
                await manager.clear_user_voice_state(
                    str(user.id), channel_id=current_voice_channel
                )
            except Exception:  # noqa: BLE001
                log.exception("clear_user_voice_state failed for user=%s", user.id)
        # Try to close cleanly. Already-closed sockets raise.
        try:
            await websocket.close()
        except Exception:  # noqa: BLE001
            pass
