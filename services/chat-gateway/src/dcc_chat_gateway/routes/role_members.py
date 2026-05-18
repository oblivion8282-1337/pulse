"""Member ↔ role assignment endpoints + the per-user "resolved permissions"
read-side.

Split off from ``routes/roles.py`` to keep each file under the §12.1
line cap. The two halves share the ``_role_dict`` wire shape, which
lives here as well so role_members can reuse it (small enough to
duplicate; the alternative is a third module just for the helper)."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import delete, select

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import MemberRole, Role
from dcc_chat_gateway.permissions import (
    Permissions,
    check_permission,
    has_permission,
    resolve_permissions,
)
from dcc_chat_gateway.routes._deps import require_member
from dcc_chat_gateway.schemas import RoleOut
from dcc_chat_gateway.security import CurrentUser

router = APIRouter()


async def _publish_member_roles_updated(
    request: Request, guild_id: int, user_id: int
) -> None:
    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is not None:
        await mgr.publish_guild_event(
            {
                "op": "member_roles_updated",
                "guild_id": str(guild_id),
                "user_id": str(user_id),
            }
        )


@router.put(
    "/guilds/{guild_id}/members/{user_id}/roles/{role_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def assign_member_role(
    guild_id: int,
    user_id: int,
    role_id: int,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    role = await session.get(Role, role_id)
    if role is None or role.guild_id != guild_id:
        raise HTTPException(404, detail="role not found")
    if role.is_everyone:
        raise HTTPException(
            400, detail="@everyone is implicit — cannot be assigned explicitly"
        )
    editor_perms = await check_permission(
        session, current, guild_id, Permissions.MANAGE_ROLES
    )
    # Anti-escalation: assigning a role with ADMINISTRATOR requires the
    # editor to have ADMINISTRATOR (or be owner — short-circuits in the
    # resolver to GRANT_ALL_SAFE).
    if role.permissions & int(Permissions.ADMINISTRATOR) and not has_permission(
        editor_perms, Permissions.ADMINISTRATOR
    ):
        raise HTTPException(
            403, detail="cannot grant ADMINISTRATOR without having it yourself"
        )

    existing = await session.get(MemberRole, (guild_id, user_id, role_id))
    if existing is None:
        session.add(MemberRole(guild_id=guild_id, user_id=user_id, role_id=role_id))
        await session.commit()
    await _publish_member_roles_updated(request, guild_id, user_id)


@router.delete(
    "/guilds/{guild_id}/members/{user_id}/roles/{role_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def unassign_member_role(
    guild_id: int,
    user_id: int,
    role_id: int,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    role = await session.get(Role, role_id)
    if role is None or role.guild_id != guild_id:
        raise HTTPException(404, detail="role not found")
    if role.is_everyone:
        raise HTTPException(
            400, detail="@everyone is implicit — cannot be unassigned"
        )
    await check_permission(session, current, guild_id, Permissions.MANAGE_ROLES)

    await session.execute(
        delete(MemberRole).where(
            MemberRole.guild_id == guild_id,
            MemberRole.user_id == user_id,
            MemberRole.role_id == role_id,
        )
    )
    await session.commit()
    await _publish_member_roles_updated(request, guild_id, user_id)


@router.get(
    "/guilds/{guild_id}/members/{user_id}/roles",
    response_model=list[RoleOut],
)
async def list_member_roles(
    guild_id: int,
    user_id: int,
    session: SessionDep,
    current: CurrentUser,
):
    """Roles a specific member holds. Requires guild membership; doesn't
    require MANAGE_ROLES — every member can see who has which roles
    (matches Discord's transparency)."""
    await require_member(session, guild_id, current.id)
    stmt = (
        select(Role)
        .join(MemberRole, MemberRole.role_id == Role.id)
        .where(
            MemberRole.guild_id == guild_id,
            MemberRole.user_id == user_id,
        )
        .order_by(Role.position.desc(), Role.id)
    )
    rows = (await session.execute(stmt)).scalars().all()
    return list(rows)


@router.get("/guilds/{guild_id}/member-roles")
async def bulk_member_roles(
    guild_id: int,
    session: SessionDep,
    current: CurrentUser,
) -> dict[str, list[str]]:
    """Every member's role-id list in one shot.

    Lets the frontend avoid the N+1 pattern of fetching per-member roles
    when rendering a member list of any size. The shape is
    ``{user_id: [role_id, ...]}``; users with only the implicit
    @everyone role show up as an empty list (or are omitted — clients
    treat absence as "@everyone only"). Snowflake ids as strings.

    Permission: same as ``list_member_roles`` — guild membership is
    enough. No MANAGE_ROLES gate; Discord exposes the same data to
    every member."""
    await require_member(session, guild_id, current.id)
    stmt = (
        select(MemberRole.user_id, MemberRole.role_id)
        .join(Role, Role.id == MemberRole.role_id)
        .where(
            MemberRole.guild_id == guild_id,
            Role.is_everyone.is_(False),
        )
    )
    out: dict[str, list[str]] = {}
    for user_id, role_id in (await session.execute(stmt)).all():
        out.setdefault(str(user_id), []).append(str(role_id))
    return out


@router.get("/guilds/{guild_id}/permissions/me")
async def my_guild_permissions(
    guild_id: int,
    session: SessionDep,
    current: CurrentUser,
) -> dict[str, str]:
    """The current user's resolved guild-level permission bitfield.

    Returned as ``{"permissions": "<int-as-string>"}``. The frontend
    uses this for the initial render before ``ready`` arrives (and as a
    refresh after a role mutation, in case the ws event got dropped)."""
    value = await resolve_permissions(session, current, guild_id)
    return {"permissions": str(value)}
