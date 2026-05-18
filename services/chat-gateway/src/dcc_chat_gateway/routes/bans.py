"""Guild ban routes.

Endpoints:
  * ``GET /guilds/{gid}/bans``      — list bans (BAN_MEMBERS)
  * ``PUT /guilds/{gid}/bans/{uid}`` — ban a user (BAN_MEMBERS)
  * ``DELETE /guilds/{gid}/bans/{uid}`` — unban (BAN_MEMBERS)

Lives in a separate module because the guilds.py route file already
sits near the §12.1 soft cap. The ban-block check used by invite + add-
member paths lives here too (``is_user_banned``) so callers don't have
to know the schema.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import delete as sa_delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import (
    Channel,
    Guild,
    GuildBan,
    GuildMember,
    PermissionOverwrite,
)
from dcc_chat_gateway.permissions import Permissions, check_permission
from dcc_chat_gateway.schemas import BanIn, BanOut
from dcc_chat_gateway.security import CurrentUser

router = APIRouter()


async def is_user_banned(session: AsyncSession, guild_id: int, user_id: int) -> bool:
    """Membership-creation gate. Imported by invites.py + guilds.py
    (add_member) — keeps the schema knowledge in one place."""
    row = await session.get(GuildBan, (guild_id, user_id))
    return row is not None


async def _publish_ban_event(
    request: Request,
    op: str,
    guild_id: int,
    user_id: int,
    reason: str | None = None,
) -> None:
    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is None:
        return
    payload: dict[str, object] = {
        "op": op,
        "guild_id": str(guild_id),
        "user_id": str(user_id),
    }
    if op == "guild_ban_added" and reason is not None:
        payload["reason"] = reason
    await mgr.publish_guild_event(payload)


async def _publish_member_removed(
    request: Request, guild_id: int, user_id: int
) -> None:
    """When a ban evicts an existing member, surface it as a regular
    guild_member_removed so clients run the same cleanup path as a kick
    (drop guild locally if it's me, prune member-list otherwise)."""
    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is None:
        return
    await mgr.publish_guild_event(
        {
            "op": "guild_member_removed",
            "guild_id": str(guild_id),
            "user_id": str(user_id),
        }
    )


@router.get("/guilds/{guild_id}/bans", response_model=list[BanOut])
async def list_bans(
    guild_id: int,
    session: SessionDep,
    current: CurrentUser,
) -> list[GuildBan]:
    guild = await session.get(Guild, guild_id)
    if guild is None:
        raise HTTPException(404, detail="guild not found")
    await check_permission(session, current, guild_id, Permissions.BAN_MEMBERS)
    stmt = (
        select(GuildBan)
        .where(GuildBan.guild_id == guild_id)
        .order_by(GuildBan.banned_at.desc())
    )
    rows = (await session.execute(stmt)).scalars().all()
    return list(rows)


@router.put("/guilds/{guild_id}/bans/{user_id}", response_model=BanOut)
async def ban_user(
    guild_id: int,
    user_id: int,
    payload: BanIn,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    """Add (or refresh) a ban entry for ``user_id`` in ``guild_id``.

    Restrictions:
      * cannot ban yourself;
      * cannot ban the guild owner (transfer-ownership remains the
        only path off the owner slot — and a ban here would be a
        confusing one-way trap).

    Side-effects:
      * if the target is currently a member, their guild_members row
        and per-user channel overwrites are wiped — same cleanup as
        kick — so the ban is effective immediately;
      * broadcasts ``guild_member_removed`` (if a member was evicted)
        followed by ``guild_ban_added``.
    """
    if user_id == current.id:
        raise HTTPException(400, detail="cannot ban yourself")
    guild = await session.get(Guild, guild_id)
    if guild is None:
        raise HTTPException(404, detail="guild not found")
    if guild.owner_id == user_id:
        raise HTTPException(403, detail="cannot ban the guild owner")
    await check_permission(session, current, guild_id, Permissions.BAN_MEMBERS)

    # Upsert the ban row. ON CONFLICT support varies by dialect; we
    # instead try INSERT, on uniqueness violation refresh the existing.
    existing = await session.get(GuildBan, (guild_id, user_id))
    if existing is not None:
        existing.reason = payload.reason
        existing.banned_by_id = current.id
    else:
        existing = GuildBan(
            guild_id=guild_id,
            user_id=user_id,
            reason=payload.reason,
            banned_by_id=current.id,
        )
        session.add(existing)

    # If the target is currently a member, evict them. Same cleanup
    # path as ``kick_member``: drop the row + clean per-user channel
    # overwrites in the same transaction.
    member = await session.get(GuildMember, (guild_id, user_id))
    was_member = member is not None
    if member is not None:
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

    try:
        await session.commit()
    except IntegrityError:
        # Concurrent ban — refresh the row and continue.
        await session.rollback()
        existing = await session.get(GuildBan, (guild_id, user_id))
        if existing is None:
            raise HTTPException(500, detail="ban could not be persisted")  # noqa: B904
    await session.refresh(existing)

    if was_member:
        await _publish_member_removed(request, guild_id, user_id)
    await _publish_ban_event(
        request, "guild_ban_added", guild_id, user_id, reason=existing.reason
    )
    return existing


@router.delete(
    "/guilds/{guild_id}/bans/{user_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def unban_user(
    guild_id: int,
    user_id: int,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    """Remove a ban entry. The user can then re-join via any normal
    membership-creation path (invite, direct add). Idempotent: 404 if
    the user was not banned to begin with, to keep the API explicit."""
    guild = await session.get(Guild, guild_id)
    if guild is None:
        raise HTTPException(404, detail="guild not found")
    await check_permission(session, current, guild_id, Permissions.BAN_MEMBERS)
    row = await session.get(GuildBan, (guild_id, user_id))
    if row is None:
        raise HTTPException(404, detail="user is not banned")
    await session.delete(row)
    await session.commit()
    await _publish_ban_event(request, "guild_ban_removed", guild_id, user_id)
