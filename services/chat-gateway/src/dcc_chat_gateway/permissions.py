"""Permission check glue between routes and the shared resolver.

The shared resolver (``dcc_shared.permission_resolver``) is pure-Python
and DB-agnostic. This module is the adapter: it knows how to fetch the
member's roles + the channel's overwrites from the chat-gateway's
SQLAlchemy schema and feed them to the resolver.

Hot-path note: every check loads role assignments + overwrites with one
``SELECT`` each. A future optimisation is a per-request cache (the same
route often checks two adjacent permissions, e.g. ``VIEW_CHANNEL`` and
``SEND_MESSAGES``). Not implemented yet — premature for current scale.
"""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.models import (
    Guild,
    GuildMember,
    MemberRole,
    PermissionOverwrite,
    Role,
)
from dcc_chat_gateway.security import AuthenticatedUser
from dcc_shared.permission_resolver import (
    OVERWRITE_TARGET_ROLE,
    OVERWRITE_TARGET_USER,
    Override,
    RoleSnapshot,
    calculate_channel_permissions,
    calculate_guild_permissions,
    has_permission,
)
from dcc_shared.permissions import Permissions


@dataclass
class _Ctx:
    """Concrete ``PermissionContext`` populated from a single batched fetch.

    Built by ``_load_context`` once; the resolver then walks the
    snapshot without further I/O. Snapshot is per-call — no cross-route
    caching at this layer (cheap because each route does at most one or
    two checks)."""

    user: int
    admin: bool
    owner: bool
    member: bool
    roles: list[RoleSnapshot]
    overwrites: dict[tuple[int, int], Override]

    def is_global_admin(self) -> bool:
        return self.admin

    def is_guild_owner(self) -> bool:
        return self.owner

    def is_guild_member(self) -> bool:
        return self.member

    def member_roles(self) -> list[RoleSnapshot]:
        return self.roles

    def channel_overwrite_for_target(
        self, target_type: int, target_id: int
    ) -> Override | None:
        return self.overwrites.get((target_type, target_id))

    def user_id(self) -> int:
        return self.user


async def _load_context(
    session: AsyncSession,
    user: AuthenticatedUser,
    guild_id: int,
    channel_id: int | None,
) -> _Ctx:
    """Populate the permission context for one (user, guild, channel?) tuple.

    Three batched lookups:
      1. ``guilds`` row (for owner_id; cheap, primary-key fetch)
      2. ``member_roles`` JOIN ``roles`` (skipped entirely when not a member)
      3. ``permission_overwrites`` for this channel (only when channel_id given)

    A non-member context is returned with ``member=False`` and empty roles
    — the resolver then short-circuits to 0 (or grants all on admin/owner).
    """
    guild = await session.get(Guild, guild_id)
    if guild is None:
        return _Ctx(
            user=user.id,
            admin=user.is_admin,
            owner=False,
            member=False,
            roles=[],
            overwrites={},
        )

    is_owner = guild.owner_id == user.id
    member = await session.get(GuildMember, (guild_id, user.id))
    is_member = member is not None

    roles: list[RoleSnapshot] = []
    if is_member:
        # One query for both the member's explicitly-assigned roles *and*
        # the implicit @everyone role (every member has it whether or not a
        # member_roles row exists). The OR-correlated subquery keeps it to a
        # single round-trip; the (guild_id, is_everyone) uniqueness guarantees
        # @everyone appears at most once.
        assigned_ids = (
            select(MemberRole.role_id)
            .where(
                MemberRole.guild_id == guild_id,
                MemberRole.user_id == user.id,
            )
            .scalar_subquery()
        )
        stmt = select(Role).where(
            Role.guild_id == guild_id,
            or_(Role.id.in_(assigned_ids), Role.is_everyone.is_(True)),
        )
        assigned = list((await session.execute(stmt)).scalars())
        roles = [
            RoleSnapshot(
                id=r.id,
                position=r.position,
                permissions=r.permissions,
                is_everyone=r.is_everyone,
            )
            for r in assigned
        ]

    overwrites: dict[tuple[int, int], Override] = {}
    if channel_id is not None:
        ow_stmt = select(PermissionOverwrite).where(
            PermissionOverwrite.channel_id == channel_id
        )
        for ow in (await session.execute(ow_stmt)).scalars():
            overwrites[(ow.target_type, ow.target_id)] = Override(
                allow=ow.allow_bf, deny=ow.deny_bf
            )

    return _Ctx(
        user=user.id,
        admin=user.is_admin,
        owner=is_owner,
        member=is_member,
        roles=roles,
        overwrites=overwrites,
    )


async def resolve_permissions(
    session: AsyncSession,
    user: AuthenticatedUser,
    guild_id: int,
    channel_id: int | None = None,
) -> int:
    """Return the effective permission bitfield. Use ``check_permission``
    if you just want a 403 on missing perms — this is the lower-level
    primitive for routes that need the bitfield itself (e.g. ws ``ready``
    or anti-escalation checks on overwrite edits)."""
    ctx = await _load_context(session, user, guild_id, channel_id)
    if channel_id is None:
        return calculate_guild_permissions(ctx)
    return calculate_channel_permissions(ctx)


def resolve_guild_permissions_from_snapshot(
    user: AuthenticatedUser,
    guild_owner_id: int,
    member_roles: list[Role],
    *,
    is_member: bool | None = None,
) -> int:
    """Resolve guild-wide permissions from already-batched data.

    The WS ``ready`` frame fetches every guild's roles + the caller's
    role assignments in two batched SELECTs. Calling ``resolve_permissions``
    once per guild then incurs three more SELECTs *per guild* on top of that,
    which dominates the ready latency on a user with many guilds. This helper
    rebuilds a ``PermissionContext`` purely from the in-memory snapshot and
    runs the resolver — no DB I/O.

    ``member_roles`` is the set of roles the user actually holds in this
    guild (including @everyone — callers must append it if the user is a
    member). The owner short-circuit still works via ``guild_owner_id ==
    user.id``.

    ``is_member`` is the authoritative membership flag. Callers that already
    know the user is a member (e.g. ``ws_ready`` builds the guild list from a
    ``GuildMember`` JOIN) should pass ``is_member=True`` so a missing/deleted
    @everyone role row does not silently demote a real member to zero
    permissions. When left ``None`` the flag is inferred from whether
    ``member_roles`` is non-empty (legacy behaviour: non-members pass an
    empty list)."""
    snapshots = [
        RoleSnapshot(
            id=r.id,
            position=r.position,
            permissions=r.permissions,
            is_everyone=r.is_everyone,
        )
        for r in member_roles
    ]
    member = bool(member_roles) if is_member is None else is_member
    ctx = _Ctx(
        user=user.id,
        admin=user.is_admin,
        owner=guild_owner_id == user.id,
        member=member,
        roles=snapshots,
        overwrites={},
    )
    return calculate_guild_permissions(ctx)


async def check_permission(
    session: AsyncSession,
    user: AuthenticatedUser,
    guild_id: int,
    permission: Permissions,
    *,
    channel_id: int | None = None,
    detail: str | None = None,
) -> int:
    """403 if ``user`` lacks ``permission`` in ``guild_id`` (optionally
    scoped to ``channel_id``). Returns the resolved bitfield on success
    so callers can branch on additional bits without a second query.

    ``detail`` overrides the default error message — useful when the
    same permission gates a more specific UX phrase ("only the owner
    can transfer this guild" etc.)."""
    value = await resolve_permissions(session, user, guild_id, channel_id)
    if not has_permission(value, permission):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail=detail or f"missing permission: {permission.name}",
        )
    return value


async def assert_overwrite_within_editor_scope(
    session: AsyncSession,
    user: AuthenticatedUser,
    guild_id: int,
    channel_id: int,
    *,
    new_allow: int,
    new_deny: int,
    existing_allow: int = 0,
    existing_deny: int = 0,
) -> None:
    """Stoatchat-style anti-privilege-escalation check.

    An editor of a channel-overwrite must themselves have every bit they
    are *adding* to ``allow`` or *removing* from ``deny`` — otherwise
    they'd be granting permissions they don't have. Bits being removed
    from ``allow`` or added to ``deny`` are fine (you can always revoke
    permissions you can't grant).

    Owners and ADMINISTRATOR-holders pass trivially via ``check_permission``
    short-circuits."""
    editor_perms = await resolve_permissions(session, user, guild_id, channel_id)

    granted_now = (~existing_allow) & new_allow
    ungated_now = existing_deny & (~new_deny)
    must_have = granted_now | ungated_now

    if must_have & ~editor_perms:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail="cannot grant permissions you do not yourself have",
        )


async def members_who_can_view(
    session: AsyncSession,
    guild_id: int,
    channel_id: int,
) -> set[int]:
    """User-ids of every guild member who currently holds ``VIEW_CHANNEL``
    on ``channel_id``.

    Batched: a fixed four SELECTs regardless of member count (guild row,
    members, the guild's roles + every member's role assignments, the
    channel's overwrites). The per-member resolve then runs purely
    in-memory via the shared resolver — no N+1.

    Used by the @-mention / channel-activity fan-out to decide who may be
    notified about a channel without leaking pings for channels the
    recipient cannot even open.

    Caveat: a user's *global-admin* flag lives in the auth-svc DB / the
    JWT and is not visible here, so a global admin who lacks VIEW via
    roles is conservatively excluded. Rare and non-fatal — they still see
    the message when they open the channel."""
    guild = await session.get(Guild, guild_id)
    if guild is None:
        return set()

    member_ids = {
        uid
        for (uid,) in (
            await session.execute(
                select(GuildMember.user_id).where(GuildMember.guild_id == guild_id)
            )
        ).all()
    }
    if not member_ids:
        return set()

    # Every role of the guild, indexed by id. @everyone is implicit for
    # every member whether or not a member_roles row exists.
    role_by_id: dict[int, Role] = {}
    everyone: Role | None = None
    for r in (
        await session.execute(select(Role).where(Role.guild_id == guild_id))
    ).scalars():
        role_by_id[r.id] = r
        if r.is_everyone:
            everyone = r

    # Explicit assignments: user_id -> [role_id, ...].
    assignments: dict[int, list[int]] = {}
    for uid, rid in (
        await session.execute(
            select(MemberRole.user_id, MemberRole.role_id).where(
                MemberRole.guild_id == guild_id
            )
        )
    ).all():
        assignments.setdefault(uid, []).append(rid)

    # Channel overwrites — identical for every member, fetched once.
    overwrites: dict[tuple[int, int], Override] = {}
    for ow in (
        await session.execute(
            select(PermissionOverwrite).where(
                PermissionOverwrite.channel_id == channel_id
            )
        )
    ).scalars():
        overwrites[(ow.target_type, ow.target_id)] = Override(
            allow=ow.allow_bf, deny=ow.deny_bf
        )

    out: set[int] = set()
    for uid in member_ids:
        member_roles: list[Role] = [
            role_by_id[rid] for rid in assignments.get(uid, ()) if rid in role_by_id
        ]
        if everyone is not None and everyone not in member_roles:
            member_roles.append(everyone)
        ctx = _Ctx(
            user=uid,
            admin=False,  # global-admin flag not visible here — see docstring
            owner=guild.owner_id == uid,
            member=True,
            roles=[
                RoleSnapshot(
                    id=r.id,
                    position=r.position,
                    permissions=r.permissions,
                    is_everyone=r.is_everyone,
                )
                for r in member_roles
            ],
            overwrites=overwrites,
        )
        if has_permission(
            calculate_channel_permissions(ctx), Permissions.VIEW_CHANNEL
        ):
            out.add(uid)
    return out


async def filter_viewable_channels(
    session: AsyncSession,
    user: AuthenticatedUser,
    guild_id: int,
    channel_ids: list[int],
) -> set[int]:
    """Return the subset of ``channel_ids`` the user may ``VIEW_CHANNEL``.

    Batched counterpart to calling ``resolve_permissions`` in a loop: the
    guild context (owner / membership / roles) is loaded once and *every*
    candidate channel's overwrites in a single ``IN`` query, then the
    pure-Python resolver runs per channel in-memory. A fixed ~3 SELECTs
    regardless of channel count, instead of ~3·N. Used by the channel-list
    route so private channels stay hidden without an N+1.
    """
    if not channel_ids:
        return set()
    base = await _load_context(session, user, guild_id, None)
    # Owner / global-admin resolve to GRANT_ALL (which includes VIEW_CHANNEL)
    # for every channel — skip the overwrite work entirely.
    if base.owner or base.admin:
        return set(channel_ids)
    if not base.member:
        return set()

    ow_by_channel: dict[int, dict[tuple[int, int], Override]] = {}
    for ow in (
        await session.execute(
            select(PermissionOverwrite).where(
                PermissionOverwrite.channel_id.in_(channel_ids)
            )
        )
    ).scalars():
        ow_by_channel.setdefault(ow.channel_id, {})[
            (ow.target_type, ow.target_id)
        ] = Override(allow=ow.allow_bf, deny=ow.deny_bf)

    out: set[int] = set()
    for cid in channel_ids:
        ctx = _Ctx(
            user=base.user,
            admin=base.admin,
            owner=base.owner,
            member=base.member,
            roles=base.roles,
            overwrites=ow_by_channel.get(cid, {}),
        )
        if has_permission(
            calculate_channel_permissions(ctx), Permissions.VIEW_CHANNEL
        ):
            out.add(cid)
    return out


__all__ = [
    "OVERWRITE_TARGET_ROLE",
    "OVERWRITE_TARGET_USER",
    "Permissions",
    "assert_overwrite_within_editor_scope",
    "check_permission",
    "filter_viewable_channels",
    "has_permission",
    "members_who_can_view",
    "resolve_guild_permissions_from_snapshot",
    "resolve_permissions",
]
