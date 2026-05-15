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

from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from dcc_chat_gateway import ratelimit
from dcc_chat_gateway.db import SessionLocal
from dcc_chat_gateway.models import (
    CHANNEL_TYPE_TEXT,
    CHANNEL_TYPE_VOICE,
    Channel,
    Guild,
    GuildMember,
    Message,
)
from dcc_chat_gateway.routes import ws_watch
from dcc_chat_gateway.routes._deps import channel_membership
from dcc_chat_gateway.routes.messages import serialize_message
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
        user = AuthenticatedUser(id=user_id, username=payload.get("username", ""), payload=payload)
    except (HTTPException, KeyError, ValueError):
        await websocket.close(code=4001, reason="unauthorized")
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
    if not await manager.register(websocket, user.id):
        # Connection cap reached — close before the client has done any work.
        await websocket.close(code=4009, reason="too many connections")
        return
    # cid → guild_id. We cache the guild_id when a subscribe succeeds so the
    # `send` fast path can stamp the channel_bump envelope without another DB
    # round-trip per message.
    subscribed: dict[str, int] = {}
    # Channel ids of watch parties this socket has started. Used at disconnect
    # time to end parties when the host's last socket goes away.
    hosted_parties: set[str] = set()
    oversize_frames = 0

    # Tie the connection's lifetime to the token's `exp`: when it passes, the
    # background task closes the socket with 4001 (the client then refreshes +
    # reconnects).
    expiry_task: asyncio.Task | None = None
    if isinstance(exp, (int, float)):
        expiry_task = asyncio.create_task(
            _close_when_token_expires(websocket, float(exp)), name="dcc-ws-token-expiry"
        )

    # Send "ready" with the user's guild list + the current voice-channel
    # presence state + the current HQ-stream state for those guilds.
    async with SessionLocal() as session:
        guild_stmt = (
            select(Guild)
            .join(GuildMember, GuildMember.guild_id == Guild.id)
            .where(GuildMember.user_id == user.id)
            .order_by(Guild.id)
        )
        guild_rows = list((await session.execute(guild_stmt)).scalars())
        guilds = [{"id": str(g.id), "name": g.name} for g in guild_rows]
        guild_ids = [g.id for g in guild_rows]
        voice_channel_ids: list[str] = []
        if guild_ids:
            vc_stmt = select(Channel.id).where(
                Channel.guild_id.in_(guild_ids), Channel.type == CHANNEL_TYPE_VOICE
            )
            voice_channel_ids = [str(cid) for cid in (await session.execute(vc_stmt)).scalars()]

    voice_states = await manager.voice_states_for(voice_channel_ids)
    # HQ streaming + watch parties only happen in voice channels, so the
    # relevant channel set is the same one.
    stream_states = await manager.stream_states_for(voice_channel_ids)
    watch_states = await manager.watch_states_for(voice_channel_ids)

    await websocket.send_json(
        {
            "op": "ready",
            "user_id": str(user.id),
            "guilds": guilds,
            "voice_states": voice_states,
            "stream_states": stream_states,
            "watch_states": watch_states,
        }
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
                async with SessionLocal() as session:
                    channel = await channel_membership(session, cid_int, user.id)
                if channel is None:
                    await websocket.send_json(
                        {"op": "error", "code": 4004, "msg": "channel not accessible"}
                    )
                    continue
                await manager.subscribe(websocket, cid)
                subscribed[cid] = channel.guild_id
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
                if cid_int is None or not isinstance(content, str) or not content:
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
                    # Fast path: if this socket already subscribed, membership +
                    # text-channel-ness were validated then — skip the DB lookup.
                    # Trade-off: if the user is removed from the guild while still
                    # subscribed, they can keep sending until they reconnect. That
                    # is an accepted MVP behaviour; a periodic re-validation would
                    # be the clean fix.
                    if cid in subscribed:
                        ok = True
                    else:
                        channel = await channel_membership(session, cid_int, user.id)
                        ok = channel is not None and channel.type == CHANNEL_TYPE_TEXT
                    if not ok:
                        await websocket.send_json(
                            {"op": "error", "code": 4006, "msg": "channel not accessible"}
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
                    await session.commit()
                    await session.refresh(persisted)
                await websocket.send_json(
                    {"op": "message_ack", "nonce": nonce, "id": str(persisted.id)}
                )
                # Publish is best-effort: message is already persisted, so a Redis
                # failure must not kill the WS connection.
                try:
                    await manager.publish(cid, serialize_message(persisted))
                except Exception:
                    log.exception("ws publish failed for channel %s (message persisted)", cid)
                # Mirror routes/messages.py: lightweight global bump so clients
                # NOT subscribed to this channel can flag it as unread. The
                # guild_id is either cached (subscribed fast path) or fresh
                # from the membership lookup above.
                guild_id = subscribed.get(cid) or (channel.guild_id if channel is not None else None)
                if guild_id is not None:
                    try:
                        await manager.publish_guild_event(
                            {
                                "op": "channel_bump",
                                "guild_id": str(guild_id),
                                "channel_id": cid,
                                "message_id": str(persisted.id),
                                "author_id": str(user.id),
                            }
                        )
                    except Exception:
                        log.exception("ws guild_event publish failed for channel %s", cid)
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
        # Try to close cleanly. Already-closed sockets raise.
        try:
            await websocket.close()
        except Exception:  # noqa: BLE001
            pass
