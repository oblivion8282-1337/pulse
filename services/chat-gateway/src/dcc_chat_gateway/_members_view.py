"""Permission-context dataclass and VIEW_CHANNEL fan-out helpers.

``_Ctx`` is the concrete ``PermissionContext`` implementation used throughout
``permissions.py``. The large-guild helpers live here too so that
``permissions.py`` stays under the 500-line hard limit.

Nothing in this module is part of the public API — import from
``dcc_chat_gateway.permissions`` instead.
"""

from __future__ import annotations

from dataclasses import dataclass

from dcc_shared.permission_resolver import (
    OVERWRITE_TARGET_ROLE,
    OVERWRITE_TARGET_USER,
    Override,
    RoleSnapshot,
    calculate_channel_permissions,
    has_permission,
)
from dcc_shared.permissions import Permissions
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.models import (
    Guild,
    GuildMember,
    MemberRole,
    PermissionOverwrite,
    Role,
)

# Guilds with more members than this threshold use a SQL-aggregated base-
# permission path to avoid loading the full member × role cross-product
# into Python memory. Threshold chosen to keep the fast in-memory path for
# the realistic "small community" case while capping worst-case allocation.
_LARGE_GUILD_THRESHOLD = 500


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


async def members_who_can_view_small(
    session: AsyncSession,
    guild: Guild,
    channel_id: int,
) -> set[int]:
    """In-memory resolver path for small guilds (≤ _LARGE_GUILD_THRESHOLD).

    Loads all member ids, all guild roles, all role assignments, and the
    channel's overwrites in four fixed SELECTs, then resolves per-member
    purely in Python via the shared resolver."""
    guild_id = guild.id

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
            admin=False,  # global-admin flag not visible here
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


async def members_who_can_view_large(
    session: AsyncSession,
    guild: Guild,
    channel_id: int,
) -> set[int]:
    """SQL-aggregated path for large guilds (> _LARGE_GUILD_THRESHOLD).

    Avoids loading the full member × role cross-product into Python memory
    by pushing the ``bit_or`` aggregation into the database. Only the
    small set of roles that carry channel-level overwrites need their
    member-assignments loaded into Python — all other members' VIEW_CHANNEL
    is resolved from the SQL-computed base permission alone.

    Correctness guarantee: produces the same result as the in-memory path.
    Global-admin exclusion caveat applies identically (see parent docstring)."""
    guild_id = guild.id

    # ── 1. Channel overwrites (always small) ──────────────────────────────
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

    # ── 2. All guild roles (always small) ────────────────────────────────
    role_by_id: dict[int, RoleSnapshot] = {}
    everyone_snap: RoleSnapshot | None = None
    for r in (
        await session.execute(select(Role).where(Role.guild_id == guild_id))
    ).scalars():
        snap = RoleSnapshot(
            id=r.id,
            position=r.position,
            permissions=r.permissions,
            is_everyone=r.is_everyone,
        )
        role_by_id[r.id] = snap
        if r.is_everyone:
            everyone_snap = snap

    # ── 3. SQL bit_or — base permissions per member ───────────────────────
    # Joins guild_members → member_roles → roles (left so members with no
    # explicit roles still appear) and OR-aggregates their permission bits.
    # @everyone permissions are added as a literal so members without any
    # explicit roles still get the @everyone base.
    everyone_perms: int = everyone_snap.permissions if everyone_snap else 0

    base_stmt = (
        select(
            GuildMember.user_id,
            (func.coalesce(func.bit_or(Role.permissions), 0) | everyone_perms).label(
                "base_perms"
            ),
        )
        .select_from(GuildMember)
        .outerjoin(
            MemberRole,
            (MemberRole.guild_id == GuildMember.guild_id)
            & (MemberRole.user_id == GuildMember.user_id),
        )
        .outerjoin(
            Role,
            (Role.id == MemberRole.role_id) & (Role.is_everyone.is_(False)),
        )
        .where(GuildMember.guild_id == guild_id)
        .group_by(GuildMember.user_id)
    )
    base_perms_by_uid: dict[int, int] = {}
    for uid, bp in (await session.execute(base_stmt)).all():
        base_perms_by_uid[uid] = int(bp)

    # ── 4. Role assignments for overwrite-affecting roles only ────────────
    # Most role overwrites affect a handful of roles; loading only those
    # assignments is bounded by (overwrite_roles × members_with_that_role),
    # not by total membership.
    overwrite_role_ids = {
        target_id
        for (target_type, target_id) in overwrites
        if target_type == OVERWRITE_TARGET_ROLE
        and target_id in role_by_id
        and not role_by_id[target_id].is_everyone  # @everyone handled via base
    }
    # user_id -> list of RoleSnapshot for roles that have channel overwrites
    ow_roles_by_uid: dict[int, list[RoleSnapshot]] = {}
    if overwrite_role_ids:
        for uid, rid in (
            await session.execute(
                select(MemberRole.user_id, MemberRole.role_id).where(
                    MemberRole.guild_id == guild_id,
                    MemberRole.role_id.in_(overwrite_role_ids),
                )
            )
        ).all():
            ow_roles_by_uid.setdefault(uid, []).append(role_by_id[rid])

    # ── 5. Resolve per member using pre-computed base ─────────────────────
    admin_bit = int(Permissions.ADMINISTRATOR)
    out: set[int] = set()
    for uid, base in base_perms_by_uid.items():
        # Owner and ADMINISTRATOR holders bypass all overwrite checks.
        if uid == guild.owner_id or (base & admin_bit):
            out.add(uid)
            continue

        # Build a minimal role list for the overwrite-application phase.
        # We only need roles that have channel-level overwrites; the base
        # permission already encodes the aggregate guild-wide effect of all
        # other roles. @everyone is included so its channel overwrite —
        # the most common case — is always applied.
        ow_roles: list[RoleSnapshot] = list(ow_roles_by_uid.get(uid, ()))
        if everyone_snap is not None:
            ow_roles.append(everyone_snap)

        # Apply overwrites in the same order as the full resolver:
        # @everyone overwrite first, then role overwrites by position,
        # then the user-specific overwrite.
        value = base
        for role in sorted(ow_roles, key=lambda r: (not r.is_everyone, r.position)):
            ow = overwrites.get((OVERWRITE_TARGET_ROLE, role.id))
            if ow is not None:
                value = ow.apply(value)
        user_ow = overwrites.get((OVERWRITE_TARGET_USER, uid))
        if user_ow is not None:
            value = user_ow.apply(value)

        if value & int(Permissions.VIEW_CHANNEL):
            out.add(uid)
    return out


# Guild-level moderator bits — holding ANY one grants mod-queue access
# (mirrors ``_MOD_PERMS`` in routes/mod_queue.py). No channel overlay: mod-queue
# access is guild-scoped, so base permissions alone decide it.
_MOD_BITS = int(
    Permissions.MANAGE_MESSAGES | Permissions.BAN_MEMBERS | Permissions.MANAGE_GUILD
)


async def members_who_can_moderate(
    session: AsyncSession,
    guild: Guild,
) -> set[int]:
    """User-ids of guild members holding any of MANAGE_MESSAGES | BAN_MEMBERS |
    MANAGE_GUILD at the guild level. Owner + ADMINISTRATOR pass trivially.

    Used to narrow ``report_new`` fan-out to a guild's moderators. Resolves
    base (guild-wide) permissions in Python — no channel overwrites, since
    mod-queue access is guild-scoped, not per-channel; no SQL ``bit_or`` so it
    runs identically under SQLite (tests) and Postgres. Reports are rare
    (rate-limited), so the in-memory member scan is not a hot path. Global-admin
    exclusion caveat applies identically (the auth-svc flag is invisible here);
    the fan-out filter re-adds admin sockets from ``_ws_user``."""
    guild_id = guild.id

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

    perms_by_role: dict[int, int] = {}
    everyone_perms = 0
    for rid, perms, is_everyone in (
        await session.execute(
            select(Role.id, Role.permissions, Role.is_everyone).where(
                Role.guild_id == guild_id
            )
        )
    ).all():
        perms_by_role[rid] = perms
        if is_everyone:
            everyone_perms = perms

    role_perms_by_uid: dict[int, int] = {}
    for uid, rid in (
        await session.execute(
            select(MemberRole.user_id, MemberRole.role_id).where(
                MemberRole.guild_id == guild_id
            )
        )
    ).all():
        role_perms_by_uid[uid] = role_perms_by_uid.get(uid, 0) | perms_by_role.get(rid, 0)

    admin_bit = int(Permissions.ADMINISTRATOR)
    out: set[int] = set()
    for uid in member_ids:
        base = everyone_perms | role_perms_by_uid.get(uid, 0)
        if uid == guild.owner_id or (base & admin_bit) or (base & _MOD_BITS):
            out.add(uid)
    return out
