"""Permission check glue between routes and the shared resolver.

The shared resolver (``dcc_shared.permission_resolver``) is pure-Python
and DB-agnostic. This module is the adapter: it knows how to fetch the
member's roles + the channel's overwrites from the chat-gateway's
SQLAlchemy schema and feed them to the resolver.

Hot-path note: every check loads role assignments + overwrites with one
``SELECT`` each. A future optimisation is a per-request cache (the same
route often checks two adjacent permissions, e.g. ``VIEW_CHANNEL`` and
``SEND_MESSAGES``). Not implemented yet — premature for current scale.

Implementation note: ``_Ctx``, ``_LARGE_GUILD_THRESHOLD``, and the private
fan-out helpers live in ``_members_view`` to keep this file under the
500-line hard limit. All public symbols are re-exported from here.
"""

from __future__ import annotations

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
from fastapi import HTTPException, status
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway._members_view import (
    _LARGE_GUILD_THRESHOLD,
    _Ctx,
)
from dcc_chat_gateway._members_view import (
    members_who_can_moderate as _members_who_can_moderate,
)
from dcc_chat_gateway._members_view import (
    members_who_can_view_large as _members_who_can_view_large,
)
from dcc_chat_gateway._members_view import (
    members_who_can_view_small as _members_who_can_view_small,
)
from dcc_chat_gateway.models import (
    Guild,
    GuildMember,
    MemberRole,
    PermissionOverwrite,
    Role,
)
from dcc_chat_gateway.security import AuthenticatedUser


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
    def _non_member_ctx() -> _Ctx:
        # Zero (non-member) context: the resolver short-circuits every
        # permission to 0 (or grants all on admin/owner via the flags).
        return _Ctx(
            user=user.id,
            admin=user.is_admin,
            owner=False,
            member=False,
            roles=[],
            overwrites={},
        )

    guild = await session.get(Guild, guild_id)
    if guild is None:
        return _non_member_ctx()

    # Platform-suspended community: frozen for everyone (including its own
    # guild owner) except global admins/operators, who must still be able to
    # inspect + unfreeze. Return a zero context so every permission — send,
    # react, read, voice CONNECT, stream — resolves to 0.
    if guild.suspended_at is not None and not user.is_admin:
        return _non_member_ctx()

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

    For guilds with ≤ ``_LARGE_GUILD_THRESHOLD`` members: a fixed four
    SELECTs load all data into memory; per-member resolve is pure Python
    via the shared resolver — no N+1.

    For larger guilds: a SQL ``bit_or`` aggregation computes base permissions
    per member in the database, avoiding the unbounded member × role
    allocation. Role assignments are still fetched, but only for the small
    set of roles that have channel-level overwrites — all other members'
    VIEW_CHANNEL is resolved from the SQL-computed base alone.

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

    # Count members first — cheap primary-key scan used as the fast-path
    # guard. Avoids fetching all member rows just to discover the guild is
    # small and we wanted to branch on count anyway.
    member_count: int = (
        await session.scalar(
            select(func.count()).select_from(GuildMember).where(
                GuildMember.guild_id == guild_id
            )
        )
    ) or 0
    if member_count == 0:
        return set()

    if member_count <= _LARGE_GUILD_THRESHOLD:
        return await _members_who_can_view_small(session, guild, channel_id)
    return await _members_who_can_view_large(session, guild, channel_id)


async def members_who_can_moderate(
    session: AsyncSession,
    guild_id: int,
) -> set[int]:
    """User-ids of every guild member holding any of MANAGE_MESSAGES |
    BAN_MEMBERS | MANAGE_GUILD at the guild level (owner + ADMINISTRATOR pass
    trivially). Used to narrow ``report_new`` fan-out to a guild's moderators.

    Same global-admin exclusion caveat as ``members_who_can_view``."""
    guild = await session.get(Guild, guild_id)
    if guild is None:
        return set()
    return await _members_who_can_moderate(session, guild)


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

    # No pre-sort needed: calculate_channel_permissions sorts internally via
    # sorted() (a fresh copy each call), so sorting here has no effect.
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
        base.overwrites = ow_by_channel.get(cid, {})
        if has_permission(
            calculate_channel_permissions(base), Permissions.VIEW_CHANNEL
        ):
            out.add(cid)
    return out


def filter_viewable_channels_from_snapshot(
    user: AuthenticatedUser,
    guild_owner_id: int,
    member_roles: list[Role],
    channel_ids: list[int],
    overwrites_by_channel: dict[int, dict[tuple[int, int], Override]],
    *,
    is_member: bool,
) -> set[int]:
    """Pure-Python ``VIEW_CHANNEL`` filter from already-batched data.

    Behaviour-identical to :func:`filter_viewable_channels` but does **no**
    DB I/O: the caller supplies the guild's owner, the user's roles
    (``member_roles`` — explicit assignments + @everyone, the same snapshot
    fed to :func:`resolve_guild_permissions_from_snapshot`) and a
    ``{channel_id: {(target_type, target_id): Override}}`` map of the relevant
    overwrites. Lets the WS ``ready`` frame filter every guild's voice channels
    using one cross-guild overwrite query plus the roles/membership it already
    loaded, instead of the 2 redundant SELECTs/guild that going through
    ``_load_context`` would re-issue.

    ``is_member`` is authoritative (callers build the guild list from a
    ``GuildMember`` JOIN → pass ``True``). Owner / global-admin short-circuit
    to "all visible" exactly as the DB variant does.
    """
    if not channel_ids:
        return set()
    if guild_owner_id == user.id or user.is_admin:
        return set(channel_ids)
    if not is_member:
        return set()

    snapshots = [
        RoleSnapshot(
            id=r.id,
            position=r.position,
            permissions=r.permissions,
            is_everyone=r.is_everyone,
        )
        for r in member_roles
    ]
    # No pre-sort needed: calculate_channel_permissions sorts internally via
    # sorted() (a fresh copy each call), so sorting here has no effect.
    ctx = _Ctx(
        user=user.id,
        admin=user.is_admin,
        owner=False,
        member=True,
        roles=snapshots,
        overwrites={},
    )
    out: set[int] = set()
    for cid in channel_ids:
        ctx.overwrites = overwrites_by_channel.get(cid, {})
        if has_permission(
            calculate_channel_permissions(ctx), Permissions.VIEW_CHANNEL
        ):
            out.add(cid)
    return out


async def restricted_channel_ids(
    session: AsyncSession, guild_id: int, channel_ids: list[int]
) -> set[int]:
    """Subset of ``channel_ids`` whose @everyone overwrite denies
    ``VIEW_CHANNEL`` — i.e. channels only visible via explicit role/user
    allows. Powers the lock indicator in the channel list; one query,
    no per-channel resolver run (the *viewer's* access is a separate
    concern handled by :func:`filter_viewable_channels`).
    """
    if not channel_ids:
        return set()
    everyone_id = (
        await session.execute(
            select(Role.id).where(Role.guild_id == guild_id, Role.is_everyone)
        )
    ).scalar_one_or_none()
    if everyone_id is None:
        return set()
    rows = await session.execute(
        select(PermissionOverwrite.channel_id).where(
            PermissionOverwrite.channel_id.in_(channel_ids),
            PermissionOverwrite.target_type == OVERWRITE_TARGET_ROLE,
            PermissionOverwrite.target_id == everyone_id,
            PermissionOverwrite.deny_bf.op("&")(int(Permissions.VIEW_CHANNEL)) != 0,
        )
    )
    return set(rows.scalars())


__all__ = [
    "OVERWRITE_TARGET_ROLE",
    "OVERWRITE_TARGET_USER",
    "Permissions",
    "assert_overwrite_within_editor_scope",
    "check_permission",
    "filter_viewable_channels",
    "filter_viewable_channels_from_snapshot",
    "has_permission",
    "members_who_can_moderate",
    "members_who_can_view",
    "resolve_guild_permissions_from_snapshot",
    "resolve_permissions",
    "restricted_channel_ids",
]
