"""WS ``send`` op handler (Plugin-System Schritt 2).

Extracted from the old in-line elif branch in ``routes/ws_ops.py``. Owns the
full message-send path: payload validation, channel/permission resolution
(fast path from the ``subscribed`` cache, slow path via DB lookup),
DM friend-gate, SEND_MESSAGES + MENTION_EVERYONE gates, reply target
validation, persistence + bump, mention persistence + fan-out + web-push,
and the channel_bump/dm_bump envelope.

Behaviour-neutral relative to the pre-split branch: same error codes (4005,
4006, 4008, 4013, 4014, 4290), same envelope shapes, same best-effort
guards around Redis publishes and mention fan-out.
"""

from __future__ import annotations

import logging
from typing import Any

from dcc_shared.events import ChannelBumpEvent, DmBumpEvent
from dcc_shared.permission_resolver import has_permission
from dcc_shared.permissions import Permissions
from sqlalchemy import update

from dcc_chat_gateway import ratelimit
from dcc_chat_gateway.db import SessionLocal
from dcc_chat_gateway.friend_helpers import (
    block_exists_either_way,
    friendship_exists,
)
from dcc_chat_gateway.mentions import (
    INT64_MAX,
    INT64_MIN,
    MENTION_EVERYONE_RE,
    fan_out_mention_events,
    filter_to_valid,
    parse_markers,
    persist_for_message,
    serialize_mention_targets,
)
from dcc_chat_gateway.models import (
    CHANNEL_TYPE_TEXT,
    DirectMessageChannel,
    Message,
)
from dcc_chat_gateway.permissions import resolve_permissions
from dcc_chat_gateway.push import fan_out_dm_push, fan_out_mention_push
from dcc_chat_gateway.routes._deps import resolve_channel_for_user
from dcc_chat_gateway.routes.messages import serialize_message
from dcc_chat_gateway.routes.ws_ops_registry import WSOpContext
from dcc_chat_gateway.snowflake import next_id

log = logging.getLogger(__name__)

_MAX_NONCE_LEN = 64


def _channel_id(value: object) -> int | None:
    s = str(value or "").strip()
    if not s:
        return None
    try:
        return int(s)
    except ValueError:
        return None


async def handle_send(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    websocket = ctx.websocket
    user = ctx.user
    manager = ctx.manager
    subscribed = ctx.subscribed

    cid_int = _channel_id(msg.get("channel_id"))
    content = msg.get("content")
    nonce = msg.get("nonce")
    reply_to_raw = msg.get("reply_to_id")
    if cid_int is None or not isinstance(content, str) or not content.strip():
        # Match the REST endpoint: whitespace-only is rejected as empty
        # (messages.py:165 uses the same .strip() guard).
        await websocket.send_json(
            {"op": "error", "code": 4005, "msg": "invalid send payload"}
        )
        return
    # Store the trimmed content, matching REST's ``payload.content.strip()``
    # (messages.py post_message) — otherwise WS-sent messages keep stray
    # leading/trailing whitespace that the REST path would have dropped.
    content = content.strip()
    # Reject over-long content explicitly instead of silently truncating to
    # 4000 — the REST endpoint also rejects with 422, so the WS path
    # matches that semantics.
    if len(content) > 4000:
        await websocket.send_json(
            {"op": "error", "code": 4005, "msg": "content too long (max 4000)"}
        )
        return
    cid = str(cid_int)
    if not ratelimit.check("message", user.id):
        await websocket.send_json(
            {"op": "error", "code": 4290, "msg": "rate limit exceeded"}
        )
        return
    # Reply target is optional; accept int or numeric string from JS clients.
    reply_to_int: int | None = None
    if reply_to_raw is not None:
        try:
            reply_to_int = int(reply_to_raw)
        except (TypeError, ValueError):
            await websocket.send_json(
                {"op": "error", "code": 4005, "msg": "invalid reply_to_id"}
            )
            return
        # ``messages.id`` ist signed-64-bit BIGINT. Ein Wert ausserhalb des
        # Bereichs kann nie eine echte Nachricht treffen und wuerde das
        # spaetere ``session.get(Message, reply_to_int)`` mit einem
        # ungefangenen Treiberfehler abstuerzen lassen (gleiche Ursache wie
        # der Ueberlauf bei @-Erwaehnungen, siehe ``mentions.py``).
        if not (INT64_MIN <= reply_to_int <= INT64_MAX):
            await websocket.send_json(
                {"op": "error", "code": 4005, "msg": "invalid reply_to_id"}
            )
            return
    async with SessionLocal() as session:
        # Fast path: if this socket already subscribed, the channel kind +
        # access were validated then — skip the membership lookup.
        # ``subscribed[cid]`` is the guild_id for guild channels, None for
        # DMs. Trade-off: if a guild user is kicked while still subscribed,
        # they can keep sending until they reconnect. Accepted MVP
        # behaviour.
        kind: str | None = None
        guild_id_for_bump: int | None = None
        # (user_a_id, user_b_id) for the dm_bump envelope. Filled by a
        # small SELECT when kind == "dm".
        dm_pair: tuple[int, int] | None = None
        if cid in subscribed:
            gid = subscribed[cid]
            kind = "dm" if gid is None else "guild"
            guild_id_for_bump = gid
            if kind == "dm":
                dm_obj = await session.get(DirectMessageChannel, cid_int)
                if dm_obj is None:
                    # DM channel deleted under us (e.g. concurrent account
                    # purge). Treat as inaccessible — falling through to ok=True
                    # would skip the friend/block gate (dm_pair stays None) and
                    # persist an orphaned message row.
                    ok = False
                else:
                    dm_pair = (dm_obj.user_a_id, dm_obj.user_b_id)
                    ok = True
            else:
                ok = True
        else:
            resolved = await resolve_channel_for_user(session, cid_int, user.id)
            if resolved is None:
                ok = False
            else:
                kind, ch = resolved
                if kind == "guild" and ch.type != CHANNEL_TYPE_TEXT:
                    ok = False
                elif kind == "guild" and getattr(ch, "ablage", False):
                    # Mischzustand-Regel (Konzept §2a): Klartext-WS-Send in
                    # einen Ablage-Kanal wird nicht angenommen.
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
            return
        # Etappe 2 friend-gate for DMs (mirrors routes/messages.py
        # POST /channels/{id}/messages). A historical DM (pre-friend-cut)
        # cannot send any more. Errors share the same 4014 code so the FE
        # can branch on the detail string.
        if kind == "dm" and dm_pair is not None:
            other = dm_pair[1] if dm_pair[0] == user.id else dm_pair[0]
            if await block_exists_either_way(session, user.id, other):
                await websocket.send_json(
                    {"op": "error", "code": 4014, "msg": "blocked"}
                )
                return
            if not await friendship_exists(session, user.id, other):
                await websocket.send_json(
                    {"op": "error", "code": 4014, "msg": "not_friends"}
                )
                return
        # SEND_MESSAGES gate for guild channels. Mirrors the REST
        # ``POST /channels/{id}/messages`` check; DMs bypass (no channel
        # overwrites apply). VIEW_CHANNEL alone is not enough — a member
        # may be allowed to read but not post.
        # Resolved author permissions — drives the SEND_MESSAGES gate,
        # the MENTION_EVERYONE gate, and the @-mention validation below.
        # Stays 0 for DMs (no permission overlay there — ``filter_to_valid``
        # treats 0 as "no override").
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
                return
            # Mirror the REST endpoint: an @everyone/@here marker from
            # someone without MENTION_EVERYONE is rejected rather than
            # silently delivered.
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
                return
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
                return
        persisted = Message(
            id=next_id(),
            channel_id=cid_int,
            author_id=user.id,
            content=content,
            nonce=nonce[:_MAX_NONCE_LEN] if isinstance(nonce, str) else None,
            reply_to_id=reply_to_int,
        )
        session.add(persisted)
        # Parse + persist @-mentions so WS-sent messages get the same pill
        # rendering / counters as the REST POST path. ``guild_id_for_bump``
        # is the guild id for guild channels and None for DMs — exactly
        # the scope filter_to_valid expects.
        valid_mentions = await filter_to_valid(
            session,
            guild_id=guild_id_for_bump,
            author_permissions=author_perms,
            candidates=parse_markers(content),
            dm_participant_ids=set(dm_pair) if dm_pair is not None else None,
        )
        await persist_for_message(
            session,
            message_id=persisted.id,
            mentions=valid_mentions,
            replace=False,
        )
        if kind == "dm":
            # Bump last_message_id so the DM list can sort by recency.
            # UPDATE-only to avoid loading the row.
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
    mentions_serial = serialize_mention_targets(valid_mentions)
    # Publish is best-effort: message is already persisted, so a Redis
    # failure must not kill the WS connection.
    try:
        await manager.publish(
            cid, serialize_message(persisted, mentions=mentions_serial)
        )
    except Exception:
        log.exception("ws publish failed for channel %s (message persisted)", cid)
    # Cross-channel mention fan-out (in-app counter bump) + web-push,
    # mirroring routes/messages.py. Best-effort — a fan-out hiccup must
    # not break the WS session (message is already persisted).
    notified: set[int] = set()
    try:
        # Fresh short-lived session — the send-path session above is
        # already closed; the fan-out only does read-only role/member/
        # overwrite lookups.
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
    # Mirror routes/messages.py: lightweight global bump so clients NOT
    # subscribed to this channel can flag it as unread. Guild channels
    # emit channel_bump; DMs emit dm_bump with the (a, b) pair so
    # receiving clients can decide locally whether they're a member (no
    # per-user routing in Phase 1).
    if guild_id_for_bump is not None:
        try:
            await manager.publish_guild_event(
                ChannelBumpEvent(
                    guild_id=str(guild_id_for_bump),
                    channel_id=cid,
                    message_id=str(persisted.id),
                    author_id=str(user.id),
                )
            )
        except Exception:
            log.exception("ws guild_event publish failed for channel %s", cid)
    elif kind == "dm" and dm_pair is not None:
        try:
            await manager.publish_guild_event(
                DmBumpEvent(
                    channel_id=cid,
                    user_a_id=str(dm_pair[0]),
                    user_b_id=str(dm_pair[1]),
                    message_id=str(persisted.id),
                    author_id=str(user.id),
                )
            )
        except Exception:
            log.exception("ws dm_bump publish failed for channel %s", cid)
        # Closed-browser web-push for the DM recipient (the other member).
        # The dm_bump above only reaches tabs that are open. Mirrors
        # routes/messages.py::post_message (same ordering — after the
        # in-app bump). Best-effort — fan_out_dm_push never raises.
        recipient_id = dm_pair[1] if dm_pair[0] == user.id else dm_pair[0]
        if recipient_id != user.id:
            await fan_out_dm_push(
                recipient_id=recipient_id,
                author_name=user.username,
                content=content,
                channel_id=cid_int,
                message_id=persisted.id,
            )
