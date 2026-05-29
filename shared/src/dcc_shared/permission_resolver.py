"""Pure-Python permission resolver.

The resolver knows nothing about SQLAlchemy, Redis, or any specific
storage layer — it talks to a ``PermissionContext`` protocol that the
caller implements (a SQLAlchemy-backed one for chat-gateway, a fake one
for tests). Pattern taken from Stoatchat's ``PermissionQuery`` trait.

Resolution reference (Discord-shaped, but deny-wins per-overwrite):

    base = OR(role.permissions for role in member.roles incl @everyone)
    if base & ADMINISTRATOR: grant all
    if member is owner: grant all

    # channel scope only:
    apply(channel.overwrite for target=@everyone)
    for role in member.roles ordered low->high position:
        apply(channel.overwrite for target=role)
    apply(channel.overwrite for target=member)

    # each apply() is (value | allow) & ~deny — i.e. DENY WINS when a bit
    # is set in both allow and deny (stricter than Discord's allow-wins
    # ``(base & ~deny) | allow``; see ``Override.apply``).
    if not final & VIEW_CHANNEL: final = 0

The "lowest-to-highest" ordering matters because higher-position role
overwrites win over lower-position ones — Stoatchat does the same.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from dcc_shared.permissions import GRANT_ALL_SAFE, Permissions


@dataclass(frozen=True, slots=True)
class Override:
    """A single (allow, deny) pair as stored in ``permission_overwrites``."""

    allow: int
    deny: int

    def apply(self, value: int) -> int:
        """Layer this override onto ``value``: OR in the allows first, then
        stamp out the denies. Implemented as ``(value | allow) & ~deny``.

        Note this is **deny-wins**, not allow-wins: if a bit is set in both
        ``allow`` and ``deny`` the result is denied. (Discord's documented
        ``(base & ~deny) | allow`` is allow-wins and differs only in that
        both-set case — Pulse deliberately resolves it the stricter way; see
        the ``OverwriteIn`` schema comment which documents "bits in both means
        deny wins".) Applying repeatedly is safe because each apply is
        idempotent for a fixed (allow, deny)."""
        return (value | self.allow) & ~self.deny


@dataclass(frozen=True, slots=True)
class RoleSnapshot:
    """A role's resolver-relevant fields. ``position`` is the ordering key:
    higher = more powerful, applied later. ``is_everyone`` is true for the
    implicit per-guild @everyone role."""

    id: int
    position: int
    permissions: int
    is_everyone: bool


class PermissionContext(Protocol):
    """Everything the resolver needs to know. Implementations may be
    sync (returning plain values) or async — the resolver is sync; the
    caller is responsible for awaiting any DB lookups *before* building
    the context. This keeps the hot path branch-free and easy to test.

    Why no I/O in here: a single message-send path resolves permissions
    repeatedly across recipients. The caller should fetch member-roles +
    overwrites in one batched query, then pass an in-memory snapshot.
    """

    def is_global_admin(self) -> bool:
        """Server-wide ``is_admin`` flag from auth-svc JWT. Bypasses all
        guild-level checks but is **not** a per-guild role."""
        ...

    def is_guild_owner(self) -> bool:
        ...

    def is_guild_member(self) -> bool:
        ...

    def member_roles(self) -> list[RoleSnapshot]:
        """All roles the member has *including* @everyone, in any order
        — the resolver sorts by position."""
        ...

    def channel_overwrite_for_target(
        self, target_type: int, target_id: int
    ) -> Override | None:
        """``target_type`` is 0 for role, 1 for user. Returns None when
        no overwrite is set for this (channel, target). Only consulted
        during ``calculate_channel_permissions``."""
        ...

    def user_id(self) -> int:
        """Current user's snowflake — used to look up the per-user channel
        overwrite (target_type=1)."""
        ...


# Target-type constants for permission_overwrites.target_type. Kept in
# sync with the SQLAlchemy model + frontend.
OVERWRITE_TARGET_ROLE = 0
OVERWRITE_TARGET_USER = 1


def calculate_guild_permissions(ctx: PermissionContext) -> int:
    """Resolve a member's effective guild-wide permission bitfield.

    Guild-wide = OR of all the member's role permissions. Owner +
    global-admin short-circuit to GRANT_ALL_SAFE. Non-members return 0.
    """
    if ctx.is_global_admin() or ctx.is_guild_owner():
        return GRANT_ALL_SAFE
    if not ctx.is_guild_member():
        return 0

    value = 0
    for role in ctx.member_roles():
        value |= role.permissions

    if value & int(Permissions.ADMINISTRATOR):
        return GRANT_ALL_SAFE

    return value


def calculate_channel_permissions(ctx: PermissionContext) -> int:
    """Resolve a member's effective permission bitfield for one channel.

    Layering order (Stoatchat / Discord):
        1. start with guild-wide permissions
        2. apply @everyone channel overwrite
        3. apply role channel overwrites in position order (low → high)
        4. apply user channel overwrite (always wins)
        5. if !VIEW_CHANNEL → revoke everything (security invariant —
           must not be possible to have ``SEND_MESSAGES`` without
           ``VIEW_CHANNEL``, that would be an exploit)
    """
    if ctx.is_global_admin() or ctx.is_guild_owner():
        return GRANT_ALL_SAFE
    if not ctx.is_guild_member():
        return 0

    # Pull the role list once and reuse it for both the guild-base
    # accumulation and the overwrite-application phase — ``member_roles()``
    # is only guaranteed cheap by the in-memory impl, not by the Protocol.
    member_roles = ctx.member_roles()

    base = 0
    for role in member_roles:
        base |= role.permissions
    if base & int(Permissions.ADMINISTRATOR):
        # ADMINISTRATOR bit was set; channel overwrites cannot revoke it.
        return GRANT_ALL_SAFE

    roles = sorted(member_roles, key=lambda r: (not r.is_everyone, r.position))
    # @everyone first (it sorts as is_everyone=True → key=(False, position)
    # which beats any normal role's (True, position) tuple).

    value = base
    for role in roles:
        ow = ctx.channel_overwrite_for_target(OVERWRITE_TARGET_ROLE, role.id)
        if ow is not None:
            value = ow.apply(value)

    user_ow = ctx.channel_overwrite_for_target(OVERWRITE_TARGET_USER, ctx.user_id())
    if user_ow is not None:
        value = user_ow.apply(value)

    if not value & int(Permissions.VIEW_CHANNEL):
        return 0

    return value


def has_permission(value: int, permission: Permissions) -> bool:
    """Convenience predicate for ``calculate_*`` outputs."""
    return bool(value & int(permission))


__all__ = [
    "OVERWRITE_TARGET_ROLE",
    "OVERWRITE_TARGET_USER",
    "Override",
    "PermissionContext",
    "RoleSnapshot",
    "calculate_channel_permissions",
    "calculate_guild_permissions",
    "has_permission",
]
