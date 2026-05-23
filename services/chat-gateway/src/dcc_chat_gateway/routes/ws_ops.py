"""WebSocket op-loop + per-op handlers + session cleanup (Phase B extract).

Extracted from :mod:`routes.ws` so the endpoint stays small. Owns the
long-running `while True: receive → dispatch` loop, the per-op handlers,
and the disconnect-side cleanup.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time

from dcc_shared.permission_resolver import has_permission
from dcc_shared.permissions import Permissions
from fastapi import WebSocket, WebSocketDisconnect
from sqlalchemy import update

from dcc_chat_gateway import ratelimit
from dcc_chat_gateway.db import SessionLocal
from dcc_chat_gateway.friend_helpers import (
    block_exists_either_way,
    friendship_exists,
)
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
    DirectMessageChannel,
    Message,
)
from dcc_chat_gateway.permissions import resolve_permissions
from dcc_chat_gateway.presence_status import (
    STATUS_DND,
    STATUS_INVISIBLE,
    STATUS_ONLINE,
    broadcast_presence_status_changed,
    get_presence_status,
    set_presence_status,
    update_activity,
)
from dcc_chat_gateway.push import fan_out_mention_push
from dcc_chat_gateway.routes import ws_watch
from dcc_chat_gateway.routes._deps import channel_membership, resolve_channel_for_user
from dcc_chat_gateway.routes.messages import serialize_message
from dcc_chat_gateway.security import AuthenticatedUser
from dcc_chat_gateway.snowflake import next_id

log = logging.getLogger(__name__)

_MAX_WS_FRAME_BYTES = 16 * 1024
_MAX_OVERSIZE_FRAMES = 5
_MAX_NONCE_LEN = 64


async def _close_when_token_expires(websocket: WebSocket, exp: float) -> None:
    delay = exp - time.time()
    if delay > 0:
        await asyncio.sleep(delay)
    try:
        await websocket.close(code=4001, reason="token expired")
    except Exception:  # noqa: BLE001
        pass


def _channel_id(value: object) -> int | None:
    s = str(value or "").strip()
    if not s:
        return None
    try:
        return int(s)
    except ValueError:
        return None


async def run_session_op_loop(
    websocket: WebSocket,
    user: AuthenticatedUser,
    manager,
    redis,
    exp: float | int | None,
) -> None:
    """Drive the WebSocket op-loop and run cleanup on disconnect."""
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
