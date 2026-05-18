"""Role CRUD + member-role assignment + bulk position reorder.

Permission gates:
  * Read endpoints require guild membership.
  * Mutations require ``MANAGE_ROLES``.
  * Setting/removing a role on a member with ``ADMINISTRATOR`` is rejected
    unless the editor *also* has ``ADMINISTRATOR`` (anti-escalation —
    same shape as the channel-overwrite editor check, but on a role-
    assignment basis).
  * The implicit ``@everyone`` role can be edited (permissions/color) but
    not renamed/deleted/repositioned.

WebSocket-side: each mutation publishes a ``role_*`` envelope on
``guild:events`` so connected clients can refresh their permission-
resolved state without a hard refetch. Per the WS-layer plan, the
frontend will keep a resolved-permission cache keyed by channel — this
file does not yet do the broadcast for ``permissions`` value changes
that affect specific members' resolved view (Phase 3).
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import delete, select

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import Guild, Role
from dcc_chat_gateway.permissions import Permissions, check_permission
from dcc_chat_gateway.routes._deps import require_member
from dcc_chat_gateway.schemas import (
    RoleIn,
    RoleOut,
    RolePatchIn,
    RolePositionsIn,
)
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id

router = APIRouter()


def _role_dict(role: Role) -> dict[str, object]:
    """Wire shape mirroring ``RoleOut`` for guild:events broadcasts."""
    return {
        "id": str(role.id),
        "guild_id": str(role.guild_id),
        "name": role.name,
        "permissions": str(role.permissions),
        "color": role.color,
        "position": role.position,
        "hoist": role.hoist,
        "mentionable": role.mentionable,
        "is_everyone": role.is_everyone,
    }


async def _publish(request: Request, envelope: dict[str, object]) -> None:
    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is not None:
        await mgr.publish_guild_event(envelope)


# ---- List / create --------------------------------------------------------


@router.get("/guilds/{guild_id}/roles", response_model=list[RoleOut])
async def list_roles(guild_id: int, session: SessionDep, current: CurrentUser):
    await require_member(session, guild_id, current.id)
    stmt = (
        select(Role)
        .where(Role.guild_id == guild_id)
        .order_by(Role.position.desc(), Role.id)
    )
    rows = (await session.execute(stmt)).scalars().all()
    return list(rows)


@router.post(
    "/guilds/{guild_id}/roles",
    response_model=RoleOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_role(
    guild_id: int,
    payload: RoleIn,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    guild = await session.get(Guild, guild_id)
    if guild is None:
        raise HTTPException(404, detail="guild not found")
    editor_perms = await check_permission(
        session, current, guild_id, Permissions.MANAGE_ROLES
    )
    # Anti-escalation: cannot create a role that grants bits you don't
    # have yourself. Owners + ADMINISTRATOR holders pass via the
    # GRANT_ALL_SAFE short-circuit in the resolver.
    if payload.permissions & ~editor_perms:
        raise HTTPException(
            403, detail="cannot grant permissions you do not yourself have"
        )

    # New roles default to position = max + 1 so newest = highest, which is
    # the Discord-UI mental model.
    max_pos_stmt = select(Role.position).where(Role.guild_id == guild_id)
    existing = list((await session.execute(max_pos_stmt)).scalars())
    next_pos = (max(existing) if existing else 0) + 1

    role = Role(
        id=next_id(),
        guild_id=guild_id,
        name=payload.name,
        permissions=payload.permissions,
        color=payload.color,
        position=next_pos,
        hoist=payload.hoist,
        mentionable=payload.mentionable,
    )
    session.add(role)
    await session.commit()
    await session.refresh(role)
    await _publish(request, {"op": "role_created", "role": _role_dict(role)})
    return role


# ---- Update / delete ------------------------------------------------------


@router.patch("/guilds/{guild_id}/roles/{role_id}", response_model=RoleOut)
async def patch_role(
    guild_id: int,
    role_id: int,
    payload: RolePatchIn,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    role = await session.get(Role, role_id)
    if role is None or role.guild_id != guild_id:
        raise HTTPException(404, detail="role not found")
    editor_perms = await check_permission(
        session, current, guild_id, Permissions.MANAGE_ROLES
    )

    if payload.name is not None:
        if role.is_everyone:
            raise HTTPException(400, detail="@everyone cannot be renamed")
        role.name = payload.name
    if payload.permissions is not None:
        # Editor must already have every bit they're adding (anti-
        # escalation). Removing bits is always fine. Single-pass mask:
        # bits being newly granted = new & ~old.
        newly_granted = payload.permissions & ~role.permissions
        if newly_granted & ~editor_perms:
            raise HTTPException(
                403, detail="cannot grant permissions you do not yourself have"
            )
        role.permissions = payload.permissions
    if payload.color is not None:
        role.color = payload.color
    if payload.hoist is not None:
        role.hoist = payload.hoist
    if payload.mentionable is not None:
        role.mentionable = payload.mentionable

    await session.commit()
    await session.refresh(role)
    await _publish(request, {"op": "role_updated", "role": _role_dict(role)})
    return role


@router.delete(
    "/guilds/{guild_id}/roles/{role_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_role(
    guild_id: int,
    role_id: int,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    role = await session.get(Role, role_id)
    if role is None or role.guild_id != guild_id:
        raise HTTPException(404, detail="role not found")
    if role.is_everyone:
        raise HTTPException(400, detail="@everyone cannot be deleted")
    await check_permission(session, current, guild_id, Permissions.MANAGE_ROLES)

    await session.delete(role)
    await session.commit()
    await _publish(
        request,
        {
            "op": "role_deleted",
            "guild_id": str(guild_id),
            "role_id": str(role_id),
        },
    )


# ---- Bulk position reorder ------------------------------------------------


@router.patch(
    "/guilds/{guild_id}/roles-positions",
    response_model=list[RoleOut],
)
async def update_role_positions(
    guild_id: int,
    payload: RolePositionsIn,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    """Bulk-set positions for one or more roles.

    Used by drag-and-drop in the settings UI. @everyone's position is
    locked at 0 — any payload entry targeting it is rejected. Two roles
    sharing the same position is allowed (sort stable by id) — Discord
    doesn't enforce uniqueness here either.
    """
    await check_permission(session, current, guild_id, Permissions.MANAGE_ROLES)

    role_ids = [p.id for p in payload.positions]
    stmt = select(Role).where(Role.guild_id == guild_id, Role.id.in_(role_ids))
    rows = {r.id: r for r in (await session.execute(stmt)).scalars()}

    if len(rows) != len(role_ids):
        raise HTTPException(400, detail="one or more roles not in this guild")

    for entry in payload.positions:
        role = rows[entry.id]
        if role.is_everyone:
            raise HTTPException(400, detail="@everyone position is fixed at 0")
        role.position = entry.position

    await session.commit()
    for role in rows.values():
        await session.refresh(role)
        await _publish(request, {"op": "role_updated", "role": _role_dict(role)})
    return list(rows.values())


# Member-assignment endpoints + the resolved-permission read-side live in
# ``role_members.py`` to keep this file under the §12.1 line cap.
