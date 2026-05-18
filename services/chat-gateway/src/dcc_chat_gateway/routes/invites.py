"""Discord-style guild invite endpoints."""

from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import (
    CHANNEL_TYPE_TEXT,
    Channel,
    ChatSettings,
    Guild,
    GuildInvite,
    GuildMember,
)
from dcc_chat_gateway.permissions import Permissions, check_permission
from dcc_chat_gateway.routes._deps import require_member
from dcc_chat_gateway.schemas import (
    CreateInviteIn,
    InviteAcceptOut,
    InviteGuildOut,
    InviteOut,
    InvitePreviewOut,
)
from dcc_chat_gateway.security import CurrentUser

router = APIRouter()

_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
_CODE_LEN = 8
_INVITE_INVALID = "invite invalid or expired"


def _new_code() -> str:
    return "".join(secrets.choice(_CODE_ALPHABET) for _ in range(_CODE_LEN))


def _as_aware(dt: datetime | None) -> datetime | None:
    # Postgres TIMESTAMPTZ comes back tz-aware; the SQLite test backend returns
    # naive datetimes. Normalise so comparisons with an aware `now` never raise.
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt


def _is_active(inv: GuildInvite, now: datetime) -> bool:
    if inv.revoked_at is not None:
        return False
    expires_at = _as_aware(inv.expires_at)
    if expires_at is not None and expires_at <= now:
        return False
    if inv.max_uses is not None and inv.uses >= inv.max_uses:
        return False
    return True


async def _first_text_channel_id(session, guild_id: int) -> int | None:
    stmt = (
        select(Channel.id)
        .where(Channel.guild_id == guild_id, Channel.type == CHANNEL_TYPE_TEXT)
        .order_by(Channel.position, Channel.id)
        .limit(1)
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def _member_count(session, guild_id: int) -> int:
    stmt = select(func.count()).select_from(GuildMember).where(GuildMember.guild_id == guild_id)
    return int((await session.execute(stmt)).scalar_one())


async def _publish_member_added(request: Request, guild_id: int, user_id: int) -> None:
    """Tell every connected client that a user joined a guild. A client whose
    own id matches re-hydrates so its WS session starts tracking the new guild
    (voice presence, channel-lifecycle events)."""
    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is not None:
        await mgr.publish_guild_event(
            {"op": "guild_member_added", "guild_id": str(guild_id), "user_id": str(user_id)}
        )


# ---- Create / list ---------------------------------------------------------


@router.post(
    "/guilds/{guild_id}/invites",
    response_model=InviteOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_invite(
    guild_id: int,
    payload: CreateInviteIn,
    session: SessionDep,
    current: CurrentUser,
):
    await check_permission(
        session, current, guild_id, Permissions.CREATE_INVITES
    )

    # Owner-only escalation when the server-wide allow_member_invites toggle
    # is off. We deliberately do NOT give global admins a special exemption
    # at the route level — the design says "nur Guild-Owner", and the admin
    # can flip the toggle if they need to rescue a server.
    settings_row = await session.get(ChatSettings, 1)
    if settings_row is not None and not settings_row.allow_member_invites:
        guild = await session.get(Guild, guild_id)
        if guild is None or guild.owner_id != current.id:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                detail="invite creation is restricted to the server owner",
            )

    channel_id: int | None = None
    if payload.channel_id is not None:
        channel = await session.get(Channel, payload.channel_id)
        if channel is None or channel.guild_id != guild_id:
            raise HTTPException(400, detail="channel does not belong to this guild")
        channel_id = channel.id

    expires_at: datetime | None = None
    if payload.expires_in_seconds is not None:
        expires_at = datetime.now(tz=UTC) + timedelta(seconds=payload.expires_in_seconds)

    last_error: Exception | None = None
    for _ in range(5):
        invite = GuildInvite(
            code=_new_code(),
            guild_id=guild_id,
            channel_id=channel_id,
            creator_id=current.id,
            expires_at=expires_at,
            max_uses=payload.max_uses,
        )
        session.add(invite)
        try:
            await session.commit()
        except IntegrityError as exc:
            await session.rollback()
            last_error = exc
            continue
        await session.refresh(invite)
        return invite
    raise HTTPException(500, detail="could not allocate an invite code") from last_error


@router.get("/guilds/{guild_id}/invites", response_model=list[InviteOut])
async def list_invites(guild_id: int, session: SessionDep, current: CurrentUser):
    await require_member(session, guild_id, current.id)
    now = datetime.now(tz=UTC)
    stmt = (
        select(GuildInvite)
        .where(
            GuildInvite.guild_id == guild_id,
            GuildInvite.revoked_at.is_(None),
        )
        .order_by(GuildInvite.created_at.desc())
    )
    rows = (await session.execute(stmt)).scalars().all()
    return [inv for inv in rows if _is_active(inv, now)]


# ---- Revoke ----------------------------------------------------------------


@router.delete("/invites/{code}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_invite(code: str, session: SessionDep, current: CurrentUser):
    invite = await session.get(GuildInvite, code)
    if invite is None:
        raise HTTPException(404, detail="invite not found")
    # Creators can always revoke their own invites; otherwise the caller
    # needs MANAGE_INVITES (mods cleaning up stale links).
    if invite.creator_id != current.id:
        await check_permission(
            session, current, invite.guild_id, Permissions.MANAGE_INVITES,
            detail="not allowed to revoke this invite",
        )
    if invite.revoked_at is None:
        invite.revoked_at = datetime.now(tz=UTC)
        await session.commit()
    return None


# ---- Preview / accept ------------------------------------------------------


@router.get("/invites/{code}", response_model=InvitePreviewOut)
async def get_invite(code: str, session: SessionDep, current: CurrentUser):
    invite = await session.get(GuildInvite, code)
    now = datetime.now(tz=UTC)
    if invite is None or not _is_active(invite, now):
        raise HTTPException(404, detail=_INVITE_INVALID)
    guild = await session.get(Guild, invite.guild_id)
    if guild is None:
        raise HTTPException(404, detail=_INVITE_INVALID)
    return InvitePreviewOut(
        guild=InviteGuildOut(id=guild.id, name=guild.name, icon_url=guild.icon_url),
        channel_id=invite.channel_id,
        member_count=await _member_count(session, guild.id),
    )


@router.post("/invites/{code}/accept", response_model=InviteAcceptOut)
async def accept_invite(code: str, session: SessionDep, current: CurrentUser, request: Request):
    invite = await session.get(GuildInvite, code)
    if invite is None:
        raise HTTPException(404, detail=_INVITE_INVALID)
    guild = await session.get(Guild, invite.guild_id)
    if guild is None:
        raise HTTPException(404, detail=_INVITE_INVALID)
    guild_name, guild_icon = guild.name, guild.icon_url

    # Ban check before anything else — a banned user must not be able to
    # consume an invite use, hit the "already member" idempotent path,
    # or learn anything about the guild they're banned from.
    from dcc_chat_gateway.routes.bans import is_user_banned  # local: import cycle

    if await is_user_banned(session, invite.guild_id, current.id):
        raise HTTPException(403, detail="you are banned from this server")

    existing = await session.get(GuildMember, (invite.guild_id, current.id))
    if existing is not None:
        # Already a member: idempotent, do not consume a use.
        channel_id = invite.channel_id or await _first_text_channel_id(session, guild.id)
        return InviteAcceptOut(
            guild=InviteGuildOut(id=guild.id, name=guild_name, icon_url=guild_icon),
            channel_id=channel_id,
        )

    # Atomically consume one use iff the invite is still valid. Reacting to
    # a 0-row result closes the TOCTOU window between the validity check and
    # the increment.
    now = datetime.now(tz=UTC)
    stmt = (
        update(GuildInvite)
        .where(
            GuildInvite.code == code,
            GuildInvite.revoked_at.is_(None),
            (GuildInvite.expires_at.is_(None)) | (GuildInvite.expires_at > now),
            (GuildInvite.max_uses.is_(None)) | (GuildInvite.uses < GuildInvite.max_uses),
        )
        .values(uses=GuildInvite.uses + 1)
        .returning(GuildInvite.guild_id, GuildInvite.channel_id)
        .execution_options(synchronize_session=False)
    )
    result = (await session.execute(stmt)).first()
    if result is None:
        await session.rollback()
        raise HTTPException(404, detail=_INVITE_INVALID)
    # Read the resolved guild/channel id from the RETURNING row — NOT from the
    # `invite` ORM object, which would be expired after a possible rollback.
    guild_id, invite_channel_id = result

    session.add(GuildMember(guild_id=guild_id, user_id=current.id))
    try:
        await session.commit()
    except IntegrityError:
        # Race: another request added the same member concurrently. The use
        # we consumed above stays counted; that is acceptable for an MVP.
        await session.rollback()

    channel_id = invite_channel_id or await _first_text_channel_id(session, guild_id)
    await _publish_member_added(request, guild_id, current.id)
    return InviteAcceptOut(
        guild=InviteGuildOut(id=guild.id, name=guild_name, icon_url=guild_icon),
        channel_id=channel_id,
    )
