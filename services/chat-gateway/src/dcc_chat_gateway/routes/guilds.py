"""Guild CRUD + member endpoints."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from dcc_chat_gateway import ratelimit
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import Guild, GuildMember
from dcc_chat_gateway.routes._deps import require_member
from dcc_chat_gateway.schemas import GuildIn, GuildOut, MemberIn, MemberOut
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id

router = APIRouter()


# ---- Guilds ----------------------------------------------------------------


@router.post("/guilds", response_model=GuildOut, status_code=status.HTTP_201_CREATED)
async def create_guild(payload: GuildIn, session: SessionDep, current: CurrentUser):
    if not ratelimit.check("create_guild", current.id):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limit exceeded"
        )
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
    await require_member(session, guild_id, current.id)
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
    request: Request,
):
    guild = await session.get(Guild, guild_id)
    if guild is None:
        raise HTTPException(404, detail="guild not found")
    # Only the guild owner may add members (later: a MANAGE_MEMBERS permission).
    # Self-add is intentionally NOT allowed: guild IDs are enumerable, so a
    # self-add path would let any authenticated user join any guild (IDOR over
    # all channels/messages/voice tokens).
    if guild.owner_id != current.id:
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
    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is not None:
        await mgr.publish_guild_event(
            {
                "op": "guild_member_added",
                "guild_id": str(guild_id),
                "user_id": str(payload.user_id),
            }
        )
    return member


@router.get("/guilds/{guild_id}/members", response_model=list[MemberOut])
async def list_members(
    guild_id: int,
    session: SessionDep,
    current: CurrentUser,
    limit: int = Query(100, ge=1, le=500),
):
    await require_member(session, guild_id, current.id)
    stmt = (
        select(GuildMember)
        .where(GuildMember.guild_id == guild_id)
        .order_by(GuildMember.user_id)
        .limit(limit)
    )
    rows = (await session.execute(stmt)).scalars().all()
    return list(rows)
