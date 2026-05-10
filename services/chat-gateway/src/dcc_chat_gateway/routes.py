"""REST + WebSocket routes for the chat-gateway."""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import UTC, datetime
from typing import Annotated

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    Request,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from dcc_chat_gateway.db import SessionDep, SessionLocal
from dcc_chat_gateway.models import (
    CHANNEL_TYPE_TEXT,
    Channel,
    Guild,
    GuildMember,
    Message,
)
from dcc_chat_gateway.schemas import (
    ChannelIn,
    ChannelOut,
    GuildIn,
    GuildOut,
    MemberIn,
    MemberOut,
    MessageIn,
    MessageOut,
)
from dcc_chat_gateway.security import (
    AuthenticatedUser,
    CurrentUser,
    decode_token,
)
from dcc_chat_gateway.snowflake import next_id

log = logging.getLogger(__name__)

router = APIRouter()


async def _require_member(session, guild_id: int, user_id: int) -> None:
    member = await session.get(GuildMember, (guild_id, user_id))
    if member is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="not a member of this guild")


# ---- Guilds ----------------------------------------------------------------


@router.post("/guilds", response_model=GuildOut, status_code=status.HTTP_201_CREATED)
async def create_guild(payload: GuildIn, session: SessionDep, current: CurrentUser):
    guild = Guild(
        id=next_id(),
        name=payload.name,
        icon_url=payload.icon_url,
        owner_id=current.id,
    )
    session.add(guild)
    await session.flush()
    session.add(GuildMember(guild_id=guild.id, user_id=current.id))
    await session.commit()
    await session.refresh(guild)
    return guild


@router.get("/guilds", response_model=list[GuildOut])
async def list_guilds(session: SessionDep, current: CurrentUser):
    stmt = (
        select(Guild)
        .join(GuildMember, GuildMember.guild_id == Guild.id)
        .where(GuildMember.user_id == current.id)
        .order_by(Guild.id)
    )
    rows = (await session.execute(stmt)).scalars().all()
    return list(rows)


@router.get("/guilds/{guild_id}", response_model=GuildOut)
async def get_guild(guild_id: int, session: SessionDep, current: CurrentUser):
    await _require_member(session, guild_id, current.id)
    guild = await session.get(Guild, guild_id)
    if guild is None:
        raise HTTPException(404, detail="guild not found")
    return guild


# ---- Members (lightweight invite-by-id) ------------------------------------


@router.post("/guilds/{guild_id}/members", response_model=MemberOut, status_code=201)
async def add_member(
    guild_id: int,
    payload: MemberIn,
    session: SessionDep,
    current: CurrentUser,
):
    guild = await session.get(Guild, guild_id)
    if guild is None:
        raise HTTPException(404, detail="guild not found")
    if guild.owner_id != current.id and current.id != payload.user_id:
        # Only the owner can add others; users can add themselves (test seed).
        raise HTTPException(403, detail="not allowed to add members")
    member = GuildMember(guild_id=guild_id, user_id=payload.user_id)
    session.add(member)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        # idempotent: already a member
        member = await session.get(GuildMember, (guild_id, payload.user_id))
        return member  # type: ignore[return-value]
    await session.refresh(member)
    return member


@router.get("/guilds/{guild_id}/members", response_model=list[MemberOut])
async def list_members(guild_id: int, session: SessionDep, current: CurrentUser):
    await _require_member(session, guild_id, current.id)
    stmt = select(GuildMember).where(GuildMember.guild_id == guild_id).order_by(GuildMember.user_id)
    rows = (await session.execute(stmt)).scalars().all()
    return list(rows)


# ---- Channels --------------------------------------------------------------


@router.post(
    "/guilds/{guild_id}/channels",
    response_model=ChannelOut,
    status_code=201,
)
async def create_channel(
    guild_id: int,
    payload: ChannelIn,
    session: SessionDep,
    current: CurrentUser,
):
    guild = await session.get(Guild, guild_id)
    if guild is None:
        raise HTTPException(404, detail="guild not found")
    if guild.owner_id != current.id:
        raise HTTPException(403, detail="only the owner can create channels")
    channel = Channel(
        id=next_id(),
        guild_id=guild_id,
        name=payload.name,
        type=payload.type,
        position=payload.position,
        topic=payload.topic,
    )
    session.add(channel)
    await session.commit()
    await session.refresh(channel)
    return channel


@router.get("/guilds/{guild_id}/channels", response_model=list[ChannelOut])
async def list_channels(guild_id: int, session: SessionDep, current: CurrentUser):
    await _require_member(session, guild_id, current.id)
    stmt = (
        select(Channel)
        .where(Channel.guild_id == guild_id)
        .order_by(Channel.position, Channel.id)
    )
    rows = (await session.execute(stmt)).scalars().all()
    return list(rows)


@router.get("/channels/{channel_id}", response_model=ChannelOut)
async def get_channel(channel_id: int, session: SessionDep, current: CurrentUser):
    channel = await session.get(Channel, channel_id)
    if channel is None:
        raise HTTPException(404, detail="channel not found")
    await _require_member(session, channel.guild_id, current.id)
    return channel


# ---- Messages --------------------------------------------------------------


@router.get(
    "/channels/{channel_id}/messages",
    response_model=list[MessageOut],
)
async def list_messages(
    channel_id: int,
    session: SessionDep,
    current: CurrentUser,
    before: Annotated[int | None, Query(ge=0)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
):
    channel = await session.get(Channel, channel_id)
    if channel is None:
        raise HTTPException(404, detail="channel not found")
    await _require_member(session, channel.guild_id, current.id)

    stmt = select(Message).where(
        Message.channel_id == channel_id,
        Message.deleted_at.is_(None),
    )
    if before is not None:
        stmt = stmt.where(Message.id < before)
    stmt = stmt.order_by(Message.id.desc()).limit(limit)
    rows = (await session.execute(stmt)).scalars().all()
    return list(rows)


@router.post(
    "/channels/{channel_id}/messages",
    response_model=MessageOut,
    status_code=201,
)
async def post_message(
    channel_id: int,
    payload: MessageIn,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    channel = await session.get(Channel, channel_id)
    if channel is None or channel.type != CHANNEL_TYPE_TEXT:
        raise HTTPException(404, detail="text channel not found")
    await _require_member(session, channel.guild_id, current.id)
    msg = Message(
        id=next_id(),
        channel_id=channel_id,
        author_id=current.id,
        content=payload.content,
        nonce=payload.nonce,
    )
    session.add(msg)
    await session.commit()
    await session.refresh(msg)
    # Fan out via the connection manager (if present in app state).
    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is not None:
        await mgr.publish(str(channel_id), _serialize_message(msg))
    return msg


def _serialize_message(msg: Message) -> dict:
    return {
        "id": str(msg.id),
        "channel_id": str(msg.channel_id),
        "author_id": str(msg.author_id),
        "content": msg.content,
        "nonce": msg.nonce,
        "created_at": (msg.created_at or datetime.now(tz=UTC)).isoformat(),
    }


# ---- WebSocket -------------------------------------------------------------


async def _channel_membership(session, channel_id: int, user_id: int) -> Channel | None:
    channel = await session.get(Channel, channel_id)
    if channel is None:
        return None
    member = await session.get(GuildMember, (channel.guild_id, user_id))
    if member is None:
        return None
    return channel


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
                    channel = await _channel_membership(session, int(cid), user.id)
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
                    channel = await _channel_membership(session, int(cid), user.id)
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
                await manager.publish(cid, _serialize_message(persisted))
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
