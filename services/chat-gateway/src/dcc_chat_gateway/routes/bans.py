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

from dcc_shared.events import (
    GuildBanAddedEvent,
    GuildBanLiftedEvent,
    GuildBanRemovedEvent,
    GuildMemberRemovedEvent,
    GuildMembershipRevokedEvent,
)
from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import delete as sa_delete
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.audit_log import write_audit_log
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import (
    Channel,
    Guild,
    GuildBan,
    GuildMember,
    PermissionOverwrite,
)
from dcc_chat_gateway.permissions import Permissions, check_permission
from dcc_chat_gateway.role_hierarchy import assert_actor_outranks
from dcc_chat_gateway.schemas import BanIn, BanOut
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.system_dm import send_moderation_dm
from dcc_chat_gateway.voice_evict import evict_user_from_guild_voice

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
    if op == "guild_ban_added":
        envelope = GuildBanAddedEvent(
            guild_id=str(guild_id),
            user_id=str(user_id),
            reason=reason,
        )
    elif op == "guild_ban_removed":
        envelope = GuildBanRemovedEvent(
            guild_id=str(guild_id), user_id=str(user_id)
        )
    else:
        raise ValueError(f"unknown ban op: {op!r}")
    await mgr.publish_guild_event(envelope)


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
        GuildMemberRemovedEvent(
            guild_id=str(guild_id), user_id=str(user_id)
        )
    )


async def _notify_membership_revoked(
    request: Request,
    user_id: int,
    guild_id: int,
    guild_name: str,
    kind: str,
    reason: str | None,
) -> None:
    """Direct-to-user notice that THIS user was banned/kicked. Goes over
    ``user:events`` so it reaches them even though their membership is gone.
    The reason is private to the recipient (never in the guild broadcast)."""
    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is None:
        return
    await mgr.publish_user_event(
        user_id,
        GuildMembershipRevokedEvent(
            guild_id=str(guild_id),
            guild_name=guild_name,
            kind=kind,  # type: ignore[arg-type]
            reason=reason,
        ),
    )


async def _notify_ban_lifted(
    request: Request,
    user_id: int,
    guild_id: int,
    guild_name: str,
    invite_code: str,
) -> None:
    """Direct-to-user notice that a mod lifted this user's ban, carrying a
    one-click rejoin invite."""
    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is None:
        return
    await mgr.publish_user_event(
        user_id,
        GuildBanLiftedEvent(
            guild_id=str(guild_id),
            guild_name=guild_name,
            invite_code=invite_code,
        ),
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
    guild = await session.get(Guild, guild_id)
    if guild is None:
        raise HTTPException(404, detail="guild not found")
    # Permission-Gate VOR den self/owner-Branches: sonst leakt die owner-Prüfung
    # ("cannot ban the guild owner") einem Aufrufer OHNE BAN_MEMBERS, dass ein
    # geratenes user_id der Owner ist (Bestätigungs-Orakel). Erst autorisieren,
    # dann auf privilegierte Resource-Daten verzweigen.
    await check_permission(session, current, guild_id, Permissions.BAN_MEMBERS)
    if user_id == current.id:
        raise HTTPException(400, detail="cannot ban yourself")
    if guild.owner_id == user_id:
        raise HTTPException(403, detail="cannot ban the guild owner")
    await assert_actor_outranks(
        session,
        current,
        guild,
        user_id,
        detail="cannot ban a user with an equal or higher role",
    )

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

    await write_audit_log(
        session,
        guild_id=guild_id,
        actor_user_id=current.id,
        action_type="ban",
        target_kind="user",
        target_id=user_id,
        payload={"reason": payload.reason, "was_member": was_member},
    )

    try:
        await session.commit()
    except IntegrityError:
        # Concurrent ban — refresh the row and continue. The rollback
        # also reverts the session.delete(member) staged above, so the
        # member eviction never happened in this TX; guard the WS event
        # accordingly.
        await session.rollback()
        was_member = False
        existing = await session.get(GuildBan, (guild_id, user_id))
        if existing is None:
            raise HTTPException(500, detail="ban could not be persisted")  # noqa: B904
    await session.refresh(existing)

    if was_member:
        # Yank the banned user out of any LiveKit voice session before
        # the WS broadcast goes out so by the time other clients see
        # "member_removed" the target is already disconnected.
        await evict_user_from_guild_voice(session, guild_id, user_id)
        await _publish_member_removed(request, guild_id, user_id)
        # Tell the banned user directly (with the reason) — otherwise the
        # community just silently vanishes from their client.
        await _notify_membership_revoked(
            request, user_id, guild_id, guild.name, "ban", existing.reason
        )
        # Durable PM from the acting admin (bypasses the friend-gate).
        dm_text = f"Du wurdest aus der Community „{guild.name}“ ausgeschlossen."
        if existing.reason:
            dm_text += f"\nGrund: {existing.reason}"
        manager = getattr(request.app.state, "connection_manager", None)
        await send_moderation_dm(
            session, manager, from_user_id=current.id, to_user_id=user_id, content=dm_text
        )
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
    await write_audit_log(
        session,
        guild_id=guild_id,
        actor_user_id=current.id,
        action_type="unban",
        target_kind="user",
        target_id=user_id,
    )
    await session.commit()

    # Mint a one-click rejoin invite (single-use, 7 days) and tell the
    # unbanned user directly — lifting a ban otherwise leaves them with no
    # way back and no idea it happened. Local import avoids the bans↔invites
    # cycle (invites.py imports is_user_banned from here).
    from dcc_chat_gateway.routes.invites import create_rejoin_invite

    invite_code = await create_rejoin_invite(session, guild_id, current.id)
    await _publish_ban_event(request, "guild_ban_removed", guild_id, user_id)
    if invite_code is not None:
        await _notify_ban_lifted(request, user_id, guild_id, guild.name, invite_code)
        # Durable PM with the rejoin invite (from the acting admin). The client
        # renders the /invite/<code> link as a one-click join card, so the user
        # can return even after the toast is gone / if they were offline.
        from dcc_chat_gateway.config import get_settings

        invite_url = get_settings().app_base_url.rstrip("/") + f"/invite/{invite_code}"
        manager = getattr(request.app.state, "connection_manager", None)
        await send_moderation_dm(
            session,
            manager,
            from_user_id=current.id,
            to_user_id=user_id,
            content=(
                f"Deine Sperre in „{guild.name}“ wurde aufgehoben. "
                f"Über diese Einladung kommst du wieder rein:\n{invite_url}"
            ),
        )
