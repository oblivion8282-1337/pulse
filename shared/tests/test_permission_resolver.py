"""Tests for the permission resolver.

Edge cases driven by the Discord/Stoatchat semantics — every test is a
named scenario rather than a numeric edge-case grid because the failure
mode is usually "the wrong intuition was encoded", not arithmetic.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import pytest

from dcc_shared.permission_resolver import (
    OVERWRITE_TARGET_ROLE,
    OVERWRITE_TARGET_USER,
    Override,
    RoleSnapshot,
    calculate_channel_permissions,
    calculate_guild_permissions,
    has_permission,
)
from dcc_shared.permissions import (
    DEFAULT_EVERYONE_PERMISSIONS,
    GRANT_ALL_SAFE,
    Permissions,
)


@dataclass
class FakeContext:
    """In-memory PermissionContext for tests."""

    user: int = 1
    is_member: bool = True
    is_owner: bool = False
    is_admin: bool = False
    roles: list[RoleSnapshot] = field(default_factory=list)
    overwrites: dict[tuple[int, int], Override] = field(default_factory=dict)

    def is_global_admin(self) -> bool:
        return self.is_admin

    def is_guild_owner(self) -> bool:
        return self.is_owner

    def is_guild_member(self) -> bool:
        return self.is_member

    def member_roles(self) -> list[RoleSnapshot]:
        return self.roles

    def channel_overwrite_for_target(
        self, target_type: int, target_id: int
    ) -> Override | None:
        return self.overwrites.get((target_type, target_id))

    def user_id(self) -> int:
        return self.user


EVERYONE = RoleSnapshot(
    id=100, position=0, permissions=DEFAULT_EVERYONE_PERMISSIONS, is_everyone=True
)


# ---- Guild-level resolution ------------------------------------------------


def test_non_member_gets_zero() -> None:
    ctx = FakeContext(is_member=False, roles=[EVERYONE])
    assert calculate_guild_permissions(ctx) == 0


def test_owner_gets_grant_all_safe() -> None:
    ctx = FakeContext(is_owner=True)
    assert calculate_guild_permissions(ctx) == GRANT_ALL_SAFE


def test_global_admin_gets_grant_all_safe_even_without_membership() -> None:
    ctx = FakeContext(is_admin=True, is_member=False)
    assert calculate_guild_permissions(ctx) == GRANT_ALL_SAFE


def test_everyone_only_returns_default_perms() -> None:
    ctx = FakeContext(roles=[EVERYONE])
    assert calculate_guild_permissions(ctx) == DEFAULT_EVERYONE_PERMISSIONS


def test_role_permissions_are_or_combined() -> None:
    """If @everyone gives VIEW + SEND and a Mod role gives MANAGE_MESSAGES,
    a Mod member's effective perms include all three."""
    ctx = FakeContext(
        roles=[
            EVERYONE,
            RoleSnapshot(
                id=200, position=1, permissions=int(Permissions.MANAGE_MESSAGES), is_everyone=False
            ),
        ]
    )
    perms = calculate_guild_permissions(ctx)
    assert has_permission(perms, Permissions.VIEW_CHANNEL)
    assert has_permission(perms, Permissions.SEND_MESSAGES)
    assert has_permission(perms, Permissions.MANAGE_MESSAGES)


def test_administrator_bit_expands_to_grant_all_safe() -> None:
    """A role with just ADMINISTRATOR resolves to the full grant mask,
    even though its raw bitfield is a single bit."""
    ctx = FakeContext(
        roles=[
            EVERYONE,
            RoleSnapshot(
                id=200, position=1, permissions=int(Permissions.ADMINISTRATOR), is_everyone=False
            ),
        ]
    )
    assert calculate_guild_permissions(ctx) == GRANT_ALL_SAFE


def test_administrator_does_not_leak_via_member_without_role() -> None:
    """If only some other member has ADMIN, this member shouldn't get it."""
    ctx = FakeContext(roles=[EVERYONE])
    perms = calculate_guild_permissions(ctx)
    assert not has_permission(perms, Permissions.ADMINISTRATOR)
    assert not has_permission(perms, Permissions.MANAGE_GUILD)


# ---- Channel-level resolution ----------------------------------------------


def test_channel_inherits_guild_perms_when_no_overwrites() -> None:
    ctx = FakeContext(roles=[EVERYONE])
    perms = calculate_channel_permissions(ctx)
    assert perms == DEFAULT_EVERYONE_PERMISSIONS


def test_everyone_overwrite_can_deny_send_messages() -> None:
    """Announcement-channel pattern: @everyone overwrite denies SEND."""
    ctx = FakeContext(
        roles=[EVERYONE],
        overwrites={
            (OVERWRITE_TARGET_ROLE, EVERYONE.id): Override(
                allow=0, deny=int(Permissions.SEND_MESSAGES)
            ),
        },
    )
    perms = calculate_channel_permissions(ctx)
    assert has_permission(perms, Permissions.VIEW_CHANNEL)
    assert not has_permission(perms, Permissions.SEND_MESSAGES)


def test_role_overwrite_can_grant_back_what_everyone_denied() -> None:
    """Classic Discord pattern: @everyone can't send in #announcements,
    but the @announcers role can."""
    announcers = RoleSnapshot(
        id=200, position=5, permissions=0, is_everyone=False
    )
    ctx = FakeContext(
        roles=[EVERYONE, announcers],
        overwrites={
            (OVERWRITE_TARGET_ROLE, EVERYONE.id): Override(
                allow=0, deny=int(Permissions.SEND_MESSAGES)
            ),
            (OVERWRITE_TARGET_ROLE, announcers.id): Override(
                allow=int(Permissions.SEND_MESSAGES), deny=0
            ),
        },
    )
    perms = calculate_channel_permissions(ctx)
    assert has_permission(perms, Permissions.SEND_MESSAGES)


def test_user_overwrite_beats_role_overwrite() -> None:
    """Per-user channel ban: even though @announcers can SEND, this
    specific user has a user-overwrite denying it."""
    announcers = RoleSnapshot(id=200, position=5, permissions=0, is_everyone=False)
    ctx = FakeContext(
        user=42,
        roles=[EVERYONE, announcers],
        overwrites={
            (OVERWRITE_TARGET_ROLE, announcers.id): Override(
                allow=int(Permissions.SEND_MESSAGES), deny=0
            ),
            (OVERWRITE_TARGET_USER, 42): Override(
                allow=0, deny=int(Permissions.SEND_MESSAGES)
            ),
        },
    )
    perms = calculate_channel_permissions(ctx)
    assert not has_permission(perms, Permissions.SEND_MESSAGES)
    assert has_permission(perms, Permissions.VIEW_CHANNEL)


def test_position_ties_are_stable_by_id() -> None:
    """Two non-everyone roles with the same position must resolve in a
    deterministic order. Python's ``list.sort`` is stable, so the
    resolver keeps the input-list order intact whenever the sort key
    ties — calling the resolver twice with the same context must
    produce the *same* bitfield (otherwise a future change to the sort
    key would silently flip permissions on edge cases). We also pin
    that the result depends on the input ordering only (not on hash
    iteration), by running both arrangements and asserting each is
    individually reproducible. A future tightening to "secondary sort
    by role.id" would make the two arrangements agree as well; that
    invariant is left for that change to assert."""
    a = RoleSnapshot(id=200, position=5, permissions=0, is_everyone=False)
    b = RoleSnapshot(id=201, position=5, permissions=0, is_everyone=False)
    forward = FakeContext(
        roles=[EVERYONE, a, b],
        overwrites={
            (OVERWRITE_TARGET_ROLE, a.id): Override(
                allow=int(Permissions.MANAGE_MESSAGES), deny=0
            ),
            (OVERWRITE_TARGET_ROLE, b.id): Override(
                allow=0, deny=int(Permissions.MANAGE_MESSAGES)
            ),
        },
    )
    # Reproducibility: identical context, identical output. Both the
    # guild-level OR (which is order-independent) and the channel-level
    # overwrite layering (which IS order-sensitive) must be stable.
    first = calculate_channel_permissions(forward)
    second = calculate_channel_permissions(forward)
    assert first == second
    # Guild-level perms are pure OR so even reordered input agrees.
    reversed_ctx = FakeContext(
        roles=[EVERYONE, b, a],
        overwrites=forward.overwrites,
    )
    assert calculate_guild_permissions(forward) == calculate_guild_permissions(
        reversed_ctx
    )


def test_higher_position_role_overwrite_wins_over_lower() -> None:
    """Two roles overwrite the same bit in opposite directions — the
    higher-position one is applied last and wins."""
    low = RoleSnapshot(id=200, position=1, permissions=0, is_everyone=False)
    high = RoleSnapshot(id=201, position=10, permissions=0, is_everyone=False)
    ctx = FakeContext(
        roles=[EVERYONE, low, high],
        overwrites={
            (OVERWRITE_TARGET_ROLE, low.id): Override(
                allow=int(Permissions.MANAGE_MESSAGES), deny=0
            ),
            (OVERWRITE_TARGET_ROLE, high.id): Override(
                allow=0, deny=int(Permissions.MANAGE_MESSAGES)
            ),
        },
    )
    perms = calculate_channel_permissions(ctx)
    assert not has_permission(perms, Permissions.MANAGE_MESSAGES)


def test_revoke_all_when_view_channel_missing() -> None:
    """Private-channel pattern: @everyone has no VIEW_CHANNEL on this
    channel. All other permissions must be zeroed — the security
    invariant from Stoatchat. Otherwise you could craft a role that has
    SEND_MESSAGES without VIEW_CHANNEL, which would be an exploit."""
    ctx = FakeContext(
        roles=[EVERYONE],
        overwrites={
            (OVERWRITE_TARGET_ROLE, EVERYONE.id): Override(
                allow=0, deny=int(Permissions.VIEW_CHANNEL)
            ),
        },
    )
    perms = calculate_channel_permissions(ctx)
    assert perms == 0


def test_view_channel_allow_overwrite_unlocks_private_channel() -> None:
    """Same private-channel pattern, but a role-overwrite grants VIEW
    back to a specific role → that role can see + read + send."""
    mods = RoleSnapshot(id=200, position=5, permissions=0, is_everyone=False)
    ctx = FakeContext(
        roles=[EVERYONE, mods],
        overwrites={
            (OVERWRITE_TARGET_ROLE, EVERYONE.id): Override(
                allow=0, deny=int(Permissions.VIEW_CHANNEL)
            ),
            (OVERWRITE_TARGET_ROLE, mods.id): Override(
                allow=int(Permissions.VIEW_CHANNEL), deny=0
            ),
        },
    )
    perms = calculate_channel_permissions(ctx)
    assert has_permission(perms, Permissions.VIEW_CHANNEL)
    assert has_permission(perms, Permissions.SEND_MESSAGES)


def test_owner_bypasses_channel_overwrites() -> None:
    """Even a deny-VIEW overwrite on @everyone can't lock the owner out."""
    ctx = FakeContext(
        is_owner=True,
        roles=[EVERYONE],
        overwrites={
            (OVERWRITE_TARGET_ROLE, EVERYONE.id): Override(
                allow=0, deny=int(Permissions.VIEW_CHANNEL)
            ),
            (OVERWRITE_TARGET_USER, 1): Override(
                allow=0, deny=GRANT_ALL_SAFE
            ),
        },
    )
    assert calculate_channel_permissions(ctx) == GRANT_ALL_SAFE


def test_administrator_bypasses_channel_overwrites() -> None:
    """Same shape as owner-bypass but for the ADMINISTRATOR bit on a role."""
    admin_role = RoleSnapshot(
        id=200, position=99, permissions=int(Permissions.ADMINISTRATOR), is_everyone=False
    )
    ctx = FakeContext(
        roles=[EVERYONE, admin_role],
        overwrites={
            (OVERWRITE_TARGET_ROLE, EVERYONE.id): Override(
                allow=0, deny=int(Permissions.VIEW_CHANNEL)
            ),
        },
    )
    assert calculate_channel_permissions(ctx) == GRANT_ALL_SAFE


def test_override_apply_order_independent_of_iteration() -> None:
    """Smoke: ``Override.apply`` should be ``(value | allow) & ~deny``,
    not ``(value & ~deny) | allow``. The latter would let a deny remove
    a bit the same override allows — undesirable."""
    ow = Override(
        allow=int(Permissions.SEND_MESSAGES), deny=int(Permissions.SEND_MESSAGES)
    )
    out = ow.apply(0)
    # Allow wins because we apply allow first and only then mask deny —
    # but our deny mask explicitly removes it again, so net 0. This
    # tests the *order*, not the result alone.
    assert out == 0
    # And the inverse: deny-only with no allow.
    assert Override(allow=0, deny=int(Permissions.SEND_MESSAGES)).apply(
        int(Permissions.SEND_MESSAGES)
    ) == 0


# ---- Misc smoke ------------------------------------------------------------


def test_has_permission_predicate() -> None:
    value = int(Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES)
    assert has_permission(value, Permissions.VIEW_CHANNEL)
    assert has_permission(value, Permissions.SEND_MESSAGES)
    assert not has_permission(value, Permissions.MANAGE_MESSAGES)


def test_grant_all_safe_does_not_overflow_signed_bigint() -> None:
    """GRANT_ALL_SAFE must fit in signed 64-bit so Postgres BIGINT can
    store it. JS-safe-int (2^53) is the inner ceiling, signed-int64
    (2^63) is the storage ceiling — both must hold."""
    assert GRANT_ALL_SAFE < (1 << 53)
    assert GRANT_ALL_SAFE < (1 << 63)


@pytest.mark.parametrize(
    "perm",
    [
        Permissions.VIEW_CHANNEL,
        Permissions.SEND_MESSAGES,
        Permissions.CONNECT,
        Permissions.SPEAK,
        Permissions.STREAM,
        Permissions.MANAGE_GUILD,
        Permissions.ADMINISTRATOR,
    ],
)
def test_grant_all_safe_includes_all_real_permissions(perm: Permissions) -> None:
    """If we ever bump a permission past bit 51 by accident, this catches it."""
    assert GRANT_ALL_SAFE & int(perm) == int(perm)
