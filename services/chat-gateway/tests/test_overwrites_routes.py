"""Coverage for channel permission-overwrite endpoints.

The interesting cases are the anti-escalation invariants and the
private-channel pattern (deny VIEW on @everyone). The non-private
positive case is covered indirectly via the role-route tests + the
resolver unit tests."""

from __future__ import annotations

import random

import pytest

from dcc_shared.permission_resolver import (
    OVERWRITE_TARGET_ROLE,
    OVERWRITE_TARGET_USER,
)
from dcc_shared.permissions import Permissions


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register_user(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


async def _make_guild_channel_with_member(client, _auth_signer):
    t_owner, _ = await _register_user(_auth_signer)
    t_other, uid_other = await _register_user(_auth_signer)
    g = (await client.post(
        "/guilds", json={"name": "g"}, headers=auth(t_owner)
    )).json()
    c = (await client.post(
        f"/guilds/{g['id']}/channels",
        json={"name": "general"},
        headers=auth(t_owner),
    )).json()
    await client.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": str(uid_other)},
        headers=auth(t_owner),
    )
    return t_owner, t_other, uid_other, g, c


# ---- Set / delete by owner -------------------------------------------------


@pytest.mark.asyncio
async def test_owner_can_set_overwrite(client, _auth_signer):
    t_owner, _, uid_other, _, c = await _make_guild_channel_with_member(
        client, _auth_signer
    )
    r = await client.put(
        f"/channels/{c['id']}/permissions/{OVERWRITE_TARGET_USER}/{uid_other}",
        json={"allow": "0", "deny": str(int(Permissions.SEND_MESSAGES))},
        headers=auth(t_owner),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert int(body["deny"]) == int(Permissions.SEND_MESSAGES)


@pytest.mark.asyncio
async def test_owner_can_delete_overwrite(client, _auth_signer):
    t_owner, _, uid_other, _, c = await _make_guild_channel_with_member(
        client, _auth_signer
    )
    await client.put(
        f"/channels/{c['id']}/permissions/{OVERWRITE_TARGET_USER}/{uid_other}",
        json={"allow": "0", "deny": str(int(Permissions.SEND_MESSAGES))},
        headers=auth(t_owner),
    )
    r = await client.delete(
        f"/channels/{c['id']}/permissions/{OVERWRITE_TARGET_USER}/{uid_other}",
        headers=auth(t_owner),
    )
    assert r.status_code == 204


@pytest.mark.asyncio
async def test_list_overwrites_returns_what_was_set(client, _auth_signer):
    t_owner, _, uid_other, _, c = await _make_guild_channel_with_member(
        client, _auth_signer
    )
    await client.put(
        f"/channels/{c['id']}/permissions/{OVERWRITE_TARGET_USER}/{uid_other}",
        json={"allow": "0", "deny": str(int(Permissions.SEND_MESSAGES))},
        headers=auth(t_owner),
    )
    r = await client.get(f"/channels/{c['id']}/permissions", headers=auth(t_owner))
    assert r.status_code == 200
    rows = r.json()
    assert any(
        row["target_type"] == OVERWRITE_TARGET_USER
        and row["target_id"] == str(uid_other)
        and int(row["deny"]) == int(Permissions.SEND_MESSAGES)
        for row in rows
    )


# ---- Permission gate -------------------------------------------------------


@pytest.mark.asyncio
async def test_member_without_manage_permissions_forbidden(client, _auth_signer):
    _, t_other, uid_other, _, c = await _make_guild_channel_with_member(
        client, _auth_signer
    )
    r = await client.put(
        f"/channels/{c['id']}/permissions/{OVERWRITE_TARGET_USER}/{uid_other}",
        json={"allow": "0", "deny": "0"},
        headers=auth(t_other),
    )
    assert r.status_code == 403


# ---- Anti-escalation (the load-bearing security invariant) ---------------


@pytest.mark.asyncio
async def test_mod_cannot_grant_admin_via_overwrite(client, _auth_signer):
    """A mod with MANAGE_PERMISSIONS but no ADMINISTRATOR can't write an
    overwrite that *allows* ADMINISTRATOR for anyone — that would let
    them escalate the target's privileges via a side channel."""
    t_owner, t_other, uid_other, g, c = await _make_guild_channel_with_member(
        client, _auth_signer
    )
    mod_role = (await client.post(
        f"/guilds/{g['id']}/roles",
        json={
            "name": "Mod",
            "permissions": str(
                int(Permissions.MANAGE_PERMISSIONS | Permissions.VIEW_CHANNEL)
            ),
        },
        headers=auth(t_owner),
    )).json()
    await client.put(
        f"/guilds/{g['id']}/members/{uid_other}/roles/{mod_role['id']}",
        headers=auth(t_owner),
    )
    r = await client.put(
        f"/channels/{c['id']}/permissions/{OVERWRITE_TARGET_USER}/{uid_other}",
        json={
            "allow": str(int(Permissions.ADMINISTRATOR)),
            "deny": "0",
        },
        headers=auth(t_other),
    )
    assert r.status_code == 403


async def _everyone_id(client, g, t_owner) -> str:
    roles = (await client.get(f"/guilds/{g['id']}/roles", headers=auth(t_owner))).json()
    return next(r["id"] for r in roles if r["is_everyone"])


async def _give_role(client, g, uid, role_id, t_owner):
    return await client.put(
        f"/guilds/{g['id']}/members/{uid}/roles/{role_id}",
        headers=auth(t_owner),
    )


@pytest.mark.asyncio
async def test_mod_cannot_remove_deny_for_bits_they_lack(client, _auth_signer):
    """Symmetric anti-escalation: removing a deny effectively grants the
    bit, so the editor must have it. ADMINISTRATOR-deny → mod can't
    remove it because mod doesn't have ADMINISTRATOR themselves."""
    t_owner, t_other, uid_other, g, c = await _make_guild_channel_with_member(
        client, _auth_signer
    )
    everyone_id = await _everyone_id(client, g, t_owner)
    # Owner: @everyone deny-ADMINISTRATOR (silly but crystallizes the case).
    await client.put(
        f"/channels/{c['id']}/permissions/{OVERWRITE_TARGET_ROLE}/{everyone_id}",
        json={"allow": "0", "deny": str(int(Permissions.ADMINISTRATOR))},
        headers=auth(t_owner),
    )
    # Mod with MANAGE_PERMISSIONS but not ADMINISTRATOR.
    mod_role = (await client.post(
        f"/guilds/{g['id']}/roles",
        json={"name": "Mod", "permissions": str(int(Permissions.MANAGE_PERMISSIONS))},
        headers=auth(t_owner),
    )).json()
    await _give_role(client, g, uid_other, mod_role["id"], t_owner)
    # Mod tries to remove the @everyone deny → un-denies ADMINISTRATOR.
    r = await client.put(
        f"/channels/{c['id']}/permissions/{OVERWRITE_TARGET_ROLE}/{everyone_id}",
        json={"allow": "0", "deny": "0"},
        headers=auth(t_other),
    )
    assert r.status_code == 403


# ---- Private-channel pattern + resolution ---------------------------------


@pytest.mark.asyncio
async def test_deny_view_on_everyone_zeroes_member_perms(
    client, _auth_signer, session_factory
):
    """End-to-end of the resolver's !VIEW_CHANNEL→0 invariant via the
    REST surface: after the @everyone deny-VIEW, a regular member's
    resolved channel-permission is 0."""
    from dcc_chat_gateway.permissions import resolve_permissions
    from dcc_chat_gateway.security import AuthenticatedUser

    t_owner, _, uid_other, g, c = await _make_guild_channel_with_member(
        client, _auth_signer
    )
    everyone_id = await _everyone_id(client, g, t_owner)
    await client.put(
        f"/channels/{c['id']}/permissions/{OVERWRITE_TARGET_ROLE}/{everyone_id}",
        json={"allow": "0", "deny": str(int(Permissions.VIEW_CHANNEL))},
        headers=auth(t_owner),
    )
    other = AuthenticatedUser(id=uid_other, username="o", is_admin=False, payload={})
    async with session_factory() as s:
        value = await resolve_permissions(
            s, other, int(g["id"]), channel_id=int(c["id"])
        )
    assert value == 0
