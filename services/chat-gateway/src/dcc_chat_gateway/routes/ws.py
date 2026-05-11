"""WebSocket endpoint: subscribe / unsubscribe / send fan-out."""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from dcc_chat_gateway.db import SessionLocal
from dcc_chat_gateway.models import CHANNEL_TYPE_TEXT, Guild, GuildMember, Message
from dcc_chat_gateway.routes._deps import channel_membership
from dcc_chat_gateway.routes.messages import serialize_message
from dcc_chat_gateway.security import AuthenticatedUser, decode_token
from dcc_chat_gateway.snowflake import next_id

log = logging.getLogger(__name__)

router = APIRouter()


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, token: str = Query(...)):
    # Authenticate before accepting subprotocols.
    try:
        payload = await decode_token(token)
        user_id = int(payload["sub"])
        user = AuthenticatedUser(id=user_id, username=payload.get("username", ""), payload=payload)
    except HTTPException:
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
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json({"op": "error", "code": 4002, "msg": "invalid JSON"})
                continue
            op = msg.get("op")
            if op == "subscribe":
                cid = str(msg.get("channel_id", "")).strip()
                if not cid:
                    await websocket.send_json({"op": "error", "code": 4003, "msg": "channel_id required"})
                    continue
                async with SessionLocal() as session:
                    channel = await channel_membership(session, int(cid), user.id)
                if channel is None:
                    await websocket.send_json({"op": "error", "code": 4004, "msg": "channel not accessible"})
                    continue
                await manager.subscribe(websocket, cid)
                subscribed.add(cid)
            elif op == "unsubscribe":
                cid = str(msg.get("channel_id", "")).strip()
                if cid:
                    await manager.unsubscribe(websocket, cid)
                    subscribed.discard(cid)
            elif op == "send":
                cid = str(msg.get("channel_id", "")).strip()
                content = msg.get("content")
                nonce = msg.get("nonce")
                if not cid or not isinstance(content, str) or not content:
                    await websocket.send_json({"op": "error", "code": 4005, "msg": "invalid send payload"})
                    continue
                async with SessionLocal() as session:
                    channel = await channel_membership(session, int(cid), user.id)
                    if channel is None or channel.type != CHANNEL_TYPE_TEXT:
                        await websocket.send_json(
                            {"op": "error", "code": 4006, "msg": "channel not accessible"}
                        )
                        continue
                    persisted = Message(
                        id=next_id(),
                        channel_id=int(cid),
                        author_id=user.id,
                        content=content[:4000],
                        nonce=nonce if isinstance(nonce, str) else None,
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
        _ = subscribed
        _ = asyncio  # silence unused
