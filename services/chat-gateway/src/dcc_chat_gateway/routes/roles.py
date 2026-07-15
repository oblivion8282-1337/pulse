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

import asyncio

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import delete, func, select

from dcc_chat_gateway.audit_log import write_audit_log
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.guild_caps import enforce_role_cap
from dcc_chat_gateway.models import Guild, Role
from dcc_chat_gateway.permissions import Permissions, check_permission
from dcc_chat_gateway.role_hierarchy import highest_role_position
from dcc_chat_gateway.routes._deps import require_member
from dcc_chat_gateway.schemas import (
    RoleIn,
    RoleOut,
    RolePatchIn,
    RolePositionsIn,
)
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id
from dcc_shared.events import (
    RoleCreatedEvent,
    RoleDeletedEvent,
    RoleUpdatedEvent,
    _EventBase,
)

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


async def _publish(
    request: Request, envelope: _EventBase | dict[str, object]
) -> None:
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

    await enforce_role_cap(session, guild_id)

    # New roles default to position = max + 1 so newest = highest, which is
    # the Discord-UI mental model.
    max_pos = await session.scalar(
        select(func.max(Role.position)).where(Role.guild_id == guild_id)
    )
    next_pos = (max_pos if max_pos is not None else 0) + 1

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
    await write_audit_log(
        session,
        guild_id=guild_id,
        actor_user_id=current.id,
        action_type="role_change",
        target_kind="role",
        target_id=role.id,
        payload={"op": "create", "name": role.name, "permissions": str(role.permissions)},
    )
    await session.commit()
    await session.refresh(role)
    await _publish(request, RoleCreatedEvent(role=_role_dict(role)))
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
    # Hierarchy guard: the editor must hold every bit the target role
    # carries — otherwise a MANAGE_ROLES-only holder could gut or rename
    # an admin role. Owners + ADMINISTRATOR-holders resolve to
    # GRANT_ALL_SAFE so `role.permissions & ~GRANT_ALL_SAFE == 0` → they
    # always pass. Mirrors delete_role.
    if role.permissions & ~editor_perms:
        raise HTTPException(
            403, detail="cannot edit a role granting bits you do not yourself have"
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

    await write_audit_log(
        session,
        guild_id=guild_id,
        actor_user_id=current.id,
        action_type="role_change",
        target_kind="role",
        target_id=role.id,
        payload={"op": "update", "name": role.name, "permissions": str(role.permissions)},
    )
    await session.commit()
    await session.refresh(role)
    await _publish(request, RoleUpdatedEvent(role=_role_dict(role)))
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
    editor_perms = await check_permission(
        session, current, guild_id, Permissions.MANAGE_ROLES
    )
    # Anti-escalation: deleting a role implicitly *removes* whatever bits
    # it granted to every holder — that's a privilege change in the same
    # blast-radius as un-assigning it from each one individually. Apply
    # the same gate as create/patch_role: the editor must hold every bit
    # the role carries (Owner/ADMINISTRATOR short-circuit via the resolver).
    if role.permissions & ~editor_perms:
        raise HTTPException(
            403, detail="cannot delete a role granting bits you do not yourself have"
        )

    await write_audit_log(
        session,
        guild_id=guild_id,
        actor_user_id=current.id,
        action_type="role_change",
        target_kind="role",
        target_id=role_id,
        payload={"op": "delete", "name": role.name},
    )
    await session.delete(role)
    await session.commit()
    await _publish(
        request,
        RoleDeletedEvent(
            guild_id=str(guild_id), role_id=str(role_id)
        ),
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

    # Anti-escalation: an editor may only reorder roles that sit strictly
    # below their own highest role, and may not lift any role to/above that
    # ceiling. Without this, a MANAGE_ROLES holder could push their own role
    # above an admin's (or an admin's below their own) and then kick/ban its
    # holders via the position-based hierarchy check in role_hierarchy.py.
    # Owners and instance admins are exempt.
    guild = await session.get(Guild, guild_id)
    if not (current.is_admin or (guild is not None and guild.owner_id == current.id)):
        actor_top = await highest_role_position(session, guild_id, current.id)
        for entry in payload.positions:
            if rows[entry.id].position >= actor_top or entry.position >= actor_top:
                raise HTTPException(
                    403, detail="cannot reorder roles at or above your highest role"
                )

    for entry in payload.positions:
        role = rows[entry.id]
        if role.is_everyone:
            raise HTTPException(400, detail="@everyone position is fixed at 0")
        role.position = entry.position

    await session.commit()
    # In-memory objects already hold the updated positions after commit —
    # no need for per-row session.refresh(). Fan out all WS events concurrently.
    # NB: kept as per-role `role_updated` events (not a single bulk event) — the
    # frontend WS layer only registers a `role_updated` handler; introducing a
    # new `role_positions_updated` op would silently drop reorder updates on
    # clients until a matching handler ships.
    await asyncio.gather(
        *[_publish(request, RoleUpdatedEvent(role=_role_dict(role))) for role in rows.values()]
    )
    return list(rows.values())


# Member-assignment endpoints + the resolved-permission read-side live in
# ``role_members.py`` to keep this file under the §12.1 line cap.
