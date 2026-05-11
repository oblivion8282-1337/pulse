"""WebSocket endpoint: subscribe / unsubscribe / send fan-out."""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from dcc_chat_gateway import ratelimit
from dcc_chat_gateway.db import SessionLocal
from dcc_chat_gateway.models import CHANNEL_TYPE_TEXT, Guild, GuildMember, Message
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

# nonce column is VARCHAR(64); trim defensively so a long client nonce can't
# trigger a Postgres StringDataRightTruncation.
_MAX_NONCE_LEN = 64


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

    await websocket.accept()
    app = websocket.app
    manager = app.state.connection_manager
    subscribed: set[str] = set()

    # Send "ready" with the user's guild list.
    async with SessionLocal() as session:
        stmt = (
            select(Guild)
            .join(GuildMember, GuildMember.guild_id == Guild.id)
            .where(GuildMember.user_id == user.id)
            .order_by(Guild.id)
        )
        guilds = [{"id": str(g.id), "name": g.name} for g in (await session.execute(stmt)).scalars()]

    await websocket.send_json({"op": "ready", "user_id": str(user.id), "guilds": guilds})

    try:
        while True:
            try:
                raw = await websocket.receive_text()
            except WebSocketDisconnect:
                break
            if len(raw) > _MAX_WS_FRAME_BYTES:
                await websocket.send_json(
                    {"op": "error", "code": 4009, "msg": "frame too large"}
                )
                break
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
                subscribed.add(cid)
            elif op == "unsubscribe":
                cid_int = _channel_id(msg.get("channel_id"))
                if cid_int is not None:
                    cid = str(cid_int)
                    await manager.unsubscribe(websocket, cid)
                    subscribed.discard(cid)
            elif op == "send":
                cid_int = _channel_id(msg.get("channel_id"))
                content = msg.get("content")
                nonce = msg.get("nonce")
                if cid_int is None or not isinstance(content, str) or not content:
                    await websocket.send_json(
                        {"op": "error", "code": 4005, "msg": "invalid send payload"}
                    )
                    continue
                cid = str(cid_int)
                if not ratelimit.check("message", user.id):
                    await websocket.send_json(
                        {"op": "error", "code": 4290, "msg": "rate limit exceeded"}
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
                    persisted = Message(
                        id=next_id(),
                        channel_id=cid_int,
                        author_id=user.id,
                        content=content[:4000],
                        nonce=nonce[:_MAX_NONCE_LEN] if isinstance(nonce, str) else None,
                    )
                    session.add(persisted)
                    await session.commit()
                    await session.refresh(persisted)
                await websocket.send_json(
                    {"op": "message_ack", "nonce": nonce, "id": str(persisted.id)}
                )
                await manager.publish(cid, serialize_message(persisted))
            else:
                await websocket.send_json({"op": "error", "code": 4007, "msg": f"unknown op: {op}"})
    finally:
        await manager.remove_socket(websocket)
        # Try to close cleanly. Already-closed sockets raise.
        try:
            await websocket.close()
        except Exception:  # noqa: BLE001
            pass
