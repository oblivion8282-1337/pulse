"""Guild CRUD + member endpoints."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import delete as sa_delete, select
from sqlalchemy.exc import IntegrityError

from dcc_chat_gateway import ratelimit
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import (
    Channel,
    Guild,
    GuildMember,
    MessageAttachment,
    PermissionOverwrite,
    Role,
)
from dcc_shared.permissions import DEFAULT_EVERYONE_PERMISSIONS
from dcc_chat_gateway.permissions import Permissions, check_permission
from dcc_chat_gateway.routes._deps import require_member
from dcc_chat_gateway.routes.attachments import hard_delete_attachments
from dcc_chat_gateway.schemas import (
    GuildIn,
    GuildOut,
    GuildPatchIn,
    MemberIn,
    MemberNicknameIn,
    MemberOut,
    TransferOwnershipIn,
)
from dcc_chat_gateway.voice_evict import evict_user_from_guild_voice
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id
from dcc_shared.events import (
    GuildDeletedEvent,
    GuildMemberAddedEvent,
    GuildMemberRemovedEvent,
    GuildMemberUpdatedEvent,
    GuildUpdatedEvent,
    _EventBase,
)

router = APIRouter()


def _guild_dict(guild: Guild) -> dict[str, object]:
    """Wire shape for guild:events envelopes — same field names as GuildOut
    (minus created_at, which lifecycle consumers don't need)."""
    return {
        "id": str(guild.id),
        "name": guild.name,
        "icon_url": guild.icon_url,
        "owner_id": str(guild.owner_id),
    }


async def _publish_guild_event(
    request: Request, envelope: _EventBase | dict[str, object]
) -> None:
    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is not None:
        await mgr.publish_guild_event(envelope)


# ---- Guilds ----------------------------------------------------------------


@router.post("/guilds", response_model=GuildOut, status_code=status.HTTP_201_CREATED)
async def create_guild(payload: GuildIn, session: SessionDep, current: CurrentUser):
    if not ratelimit.check("create_guild", current.id):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limit exceeded"
        )
    # Admin-gated when allow_guild_creation is off. Admins always pass.
    if not current.is_admin:
        from dcc_chat_gateway.models import ChatSettings  # avoid circular
        settings_row = await session.get(ChatSettings, 1)
        if settings_row is not None and not settings_row.allow_guild_creation:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                detail="server creation is disabled by the admin",
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
    # Seed @everyone so the permission resolver has something to anchor on
    # for non-owner members joining later. Mirrors the data-migration in
    # 0009 that did the same for guilds existing before the feature shipped.
    session.add(
        Role(
            id=next_id(),
            guild_id=guild.id,
            name="@everyone",
            permissions=DEFAULT_EVERYONE_PERMISSIONS,
            position=0,
            is_everyone=True,
        )
    )
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


@router.patch("/guilds/{guild_id}", response_model=GuildOut)
async def patch_guild(
    guild_id: int,
    payload: GuildPatchIn,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    """Rename / update guild metadata. Requires ``MANAGE_GUILD``.

    Broadcasts ``op:guild_updated`` on guild:events so every connected client
    can refresh its sidebar without a refetch.
    """
    guild = await session.get(Guild, guild_id)
    if guild is None:
        raise HTTPException(404, detail="guild not found")
    await check_permission(session, current, guild_id, Permissions.MANAGE_GUILD)
    if payload.name is not None:
        guild.name = payload.name
    if payload.icon_url is not None:
        guild.icon_url = payload.icon_url
    await session.commit()
    await session.refresh(guild)
    await _publish_guild_event(
        request, GuildUpdatedEvent(guild=_guild_dict(guild))
    )
    return guild


@router.delete("/guilds/{guild_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_guild(
    guild_id: int,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    """Delete a guild and everything inside it. Owner-only (a
    MANAGE_GUILD permission grants rename/icon edits, not nuke).
    Global admins bypass.

    Channels / messages / members / invites cascade via ON DELETE CASCADE in
    the DB schema. Broadcasts ``op:guild_deleted`` so clients can navigate
    away and prune their local stores.
    """
    guild = await session.get(Guild, guild_id)
    if guild is None:
        raise HTTPException(404, detail="guild not found")
    if guild.owner_id != current.id and not current.is_admin:
        raise HTTPException(403, detail="only the owner can delete the guild")
    # Hard-delete MinIO attachments for all channels before the DB cascade
    # removes the rows — the cascade can't clean up object-store objects.
    channel_ids_stmt = select(Channel.id).where(Channel.guild_id == guild_id)
    channel_ids = list((await session.execute(channel_ids_stmt)).scalars())
    if channel_ids:
        att_ids_stmt = select(MessageAttachment.id).where(
            MessageAttachment.channel_id.in_(channel_ids),
            MessageAttachment.deleted_at.is_(None),
        )
        att_ids = list((await session.execute(att_ids_stmt)).scalars())
        if att_ids:
            await hard_delete_attachments(session, attachment_ids=att_ids)
    await session.delete(guild)
    await session.commit()
    await _publish_guild_event(
        request, GuildDeletedEvent(guild_id=str(guild_id))
    )


@router.post(
    "/guilds/{guild_id}/transfer-ownership",
    response_model=GuildOut,
)
async def transfer_ownership(
    guild_id: int,
    payload: TransferOwnershipIn,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    """Hand the guild over to another member.

    Only the current owner may call this. The target must already be a
    guild member (no implicit invite). ``confirm_name`` must match the
    guild's current name verbatim — see ``TransferOwnershipIn`` for the
    reasoning. The transfer is atomic: the previous owner stays as a
    regular member afterward.
    """
    guild = await session.get(Guild, guild_id)
    if guild is None:
        raise HTTPException(404, detail="guild not found")
    if guild.owner_id != current.id:
        raise HTTPException(
            403, detail="only the owner can transfer ownership"
        )
    if payload.confirm_name != guild.name:
        raise HTTPException(
            400, detail="confirm_name does not match the guild name"
        )
    if payload.new_owner_id == current.id:
        raise HTTPException(
            400, detail="cannot transfer ownership to yourself"
        )
    target_member = await session.get(
        GuildMember, (guild_id, payload.new_owner_id)
    )
    if target_member is None:
        raise HTTPException(
            400, detail="target user is not a member of this guild"
        )

    guild.owner_id = payload.new_owner_id
    await session.commit()
    await session.refresh(guild)
    await _publish_guild_event(
        request, GuildUpdatedEvent(guild=_guild_dict(guild))
    )
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
    # MANAGE_INVITES gates direct-add-by-id (same caller-trust as creating
    # an invite link). Self-add is intentionally NOT allowed: guild IDs are
    # enumerable, so a self-add path would let any authenticated user join
    # any guild (IDOR over all channels/messages/voice tokens).
    await check_permission(
        session, current, guild_id, Permissions.MANAGE_INVITES,
        detail="not allowed to add members",
    )
    # Ban check — even a MANAGE_INVITES caller can't re-add a banned
    # user; unban is the explicit path. Imported lazily to avoid the
    # import cycle (bans.py needs to import from guilds via models).
    from dcc_chat_gateway.routes.bans import is_user_banned  # local

    if await is_user_banned(session, guild_id, payload.user_id):
        raise HTTPException(403, detail="user is banned from this server")
    member = GuildMember(guild_id=guild_id, user_id=payload.user_id)
    session.add(member)
    # Re-check the ban-list inside the transaction (post-INSERT, pre-
    # commit) so a concurrent PUT /bans/{uid} that committed between
    # the first check and now can't sneak through.
    if await is_user_banned(session, guild_id, payload.user_id):
        await session.rollback()
        raise HTTPException(403, detail="user is banned from this server")
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
            GuildMemberAddedEvent(
                guild_id=str(guild_id),
                user_id=str(payload.user_id),
            )
        )
    return member


def _normalise_nickname(value: str | None) -> str | None:
    """Trim whitespace; empty / whitespace-only string clears the nickname.

    Single source of truth so the @me and admin routes agree on what
    "" vs None means. ``None`` from the payload means "no change" and
    is filtered upstream — by the time we reach here we already know
    the caller is patching the field.
    """
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


async def _publish_member_updated(
    request: Request, guild_id: int, user_id: int, nickname: str | None
) -> None:
    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is not None:
        await mgr.publish_guild_event(
            GuildMemberUpdatedEvent(
                guild_id=str(guild_id),
                user_id=str(user_id),
                nickname=nickname,
            )
        )


@router.patch(
    "/guilds/{guild_id}/members/@me",
    response_model=MemberOut,
)
async def patch_self_member(
    guild_id: int,
    payload: MemberNicknameIn,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    """Update the caller's own per-guild profile. Currently only
    nickname; requires ``CHANGE_NICKNAME``."""
    member = await session.get(GuildMember, (guild_id, current.id))
    if member is None:
        raise HTTPException(404, detail="not a member of this guild")
    if payload.nickname is None:
        # Caller submitted an empty patch — return current state untouched.
        return member
    await check_permission(
        session, current, guild_id, Permissions.CHANGE_NICKNAME
    )
    member.nickname = _normalise_nickname(payload.nickname)
    await session.commit()
    await session.refresh(member)
    await _publish_member_updated(request, guild_id, current.id, member.nickname)
    return member


@router.patch(
    "/guilds/{guild_id}/members/{user_id}",
    response_model=MemberOut,
)
async def patch_member(
    guild_id: int,
    user_id: int,
    payload: MemberNicknameIn,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    """Update another member's per-guild profile. Currently only
    nickname; requires ``MANAGE_NICKNAMES``. Callers patching their
    own row should use ``PATCH .../@me`` — this route 400s on
    ``user_id == current.id`` so the two paths don't share a gate."""
    if user_id == current.id:
        raise HTTPException(400, detail="use PATCH .../members/@me for self-edits")
    member = await session.get(GuildMember, (guild_id, user_id))
    if member is None:
        raise HTTPException(404, detail="member not found")
    if payload.nickname is None:
        return member
    await check_permission(
        session, current, guild_id, Permissions.MANAGE_NICKNAMES
    )
    member.nickname = _normalise_nickname(payload.nickname)
    await session.commit()
    await session.refresh(member)
    await _publish_member_updated(request, guild_id, user_id, member.nickname)
    return member


@router.delete(
    "/guilds/{guild_id}/members/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def kick_member(
    guild_id: int,
    user_id: int,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    """Remove a member from a guild. Requires ``KICK_MEMBERS``.

    Restrictions:
      * cannot kick yourself — leave-flow is a separate concept (not built);
      * cannot kick the guild owner — ownership transfer is the only path;
      * member-role rows cascade via the composite FK on ``member_roles``;
      * per-channel user-target permission overwrites for this user are
        wiped explicitly (they're not cascaded — see
        ``permission_overwrites`` schema).

    Broadcasts ``guild_member_removed`` on guild:events. Clients that are
    the kicked user drop the guild locally; other clients prune their
    member list. The WS connection is not force-closed — the next
    permission-gated action on that guild will 403 naturally.
    """
    if user_id == current.id:
        raise HTTPException(400, detail="cannot kick yourself")
    guild = await session.get(Guild, guild_id)
    if guild is None:
        raise HTTPException(404, detail="guild not found")
    if guild.owner_id == user_id:
        raise HTTPException(403, detail="cannot kick the guild owner")
    member = await session.get(GuildMember, (guild_id, user_id))
    if member is None:
        raise HTTPException(404, detail="member not found")
    await check_permission(
        session, current, guild_id, Permissions.KICK_MEMBERS
    )
    # Wipe per-channel user-target overwrites — composite FKs only cascade
    # member_roles; channel overwrites live on a different table and would
    # otherwise come back if the user is re-invited later.
    channel_ids_stmt = select(Channel.id).where(Channel.guild_id == guild_id)
    channel_ids = list((await session.execute(channel_ids_stmt)).scalars())
    if channel_ids:
        await session.execute(
            sa_delete(PermissionOverwrite).where(
                PermissionOverwrite.channel_id.in_(channel_ids),
                PermissionOverwrite.target_type == 1,
                PermissionOverwrite.target_id == user_id,
            )
        )
    await session.delete(member)
    await session.commit()
    # Yank the kicked user out of LiveKit + clear any voice-overrides
    # for every voice channel of this guild. Fire-and-forget — failure
    # is logged but doesn't unwind the kick (the WS event already went
    # out and the membership is gone).
    await evict_user_from_guild_voice(session, guild_id, user_id)
    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is not None:
        await mgr.publish_guild_event(
            GuildMemberRemovedEvent(
                guild_id=str(guild_id), user_id=str(user_id)
            )
        )


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
