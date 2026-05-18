"""Coverage for the role-CRUD endpoints + anti-escalation invariants.

These tests pin the security-relevant behaviour around the role system:

* Owner can always operate (resolver short-circuits to GRANT_ALL_SAFE).
* Non-owner members need MANAGE_ROLES on a role to mutate them.
* Anti-escalation: granting bits you don't have is forbidden.
* @everyone is special: not renamable, not deletable, not repositionable,
  not explicitly assignable.
"""

from __future__ import annotations

import random

import pytest

from dcc_shared.permissions import Permissions


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register_user(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


async def _make_guild_with_member(client, _auth_signer):
    t_owner, _ = await _register_user(_auth_signer)
    t_other, uid_other = await _register_user(_auth_signer)
    g = (await client.post(
        "/guilds", json={"name": "g"}, headers=auth(t_owner)
    )).json()
    await client.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": str(uid_other)},
        headers=auth(t_owner),
    )
    return t_owner, t_other, uid_other, g


# ---- @everyone autocreated -------------------------------------------------


@pytest.mark.asyncio
async def test_creating_guild_seeds_everyone(client, _auth_signer):
    t, _ = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t))).json()
    roles = (await client.get(f"/guilds/{g['id']}/roles", headers=auth(t))).json()
    assert len(roles) == 1
    assert roles[0]["is_everyone"] is True
    assert roles[0]["name"] == "@everyone"
    assert roles[0]["position"] == 0
    # Permissions are sent as strings (wire format).
    assert isinstance(roles[0]["permissions"], str)
    assert int(roles[0]["permissions"]) > 0


# ---- Role CRUD happy paths --------------------------------------------------


@pytest.mark.asyncio
async def test_owner_can_create_role(client, _auth_signer):
    t_owner, _, _, g = await _make_guild_with_member(client, _auth_signer)
    r = await client.post(
        f"/guilds/{g['id']}/roles",
        json={
            "name": "Mods",
            "permissions": str(int(Permissions.MANAGE_MESSAGES)),
        },
        headers=auth(t_owner),
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["name"] == "Mods"
    assert int(body["permissions"]) == int(Permissions.MANAGE_MESSAGES)
    assert body["is_everyone"] is False
    assert body["position"] == 1  # @everyone is 0, new one bumps to max+1


@pytest.mark.asyncio
async def test_non_member_cannot_list_roles(client, _auth_signer):
    t_owner, _ = await _register_user(_auth_signer)
    t_stranger, _ = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t_owner))).json()
    r = await client.get(f"/guilds/{g['id']}/roles", headers=auth(t_stranger))
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_member_without_manage_roles_cannot_create(client, _auth_signer):
    _, t_other, _, g = await _make_guild_with_member(client, _auth_signer)
    r = await client.post(
        f"/guilds/{g['id']}/roles",
        json={"name": "x", "permissions": "0"},
        headers=auth(t_other),
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_patch_role_permissions(client, _auth_signer):
    t_owner, _, _, g = await _make_guild_with_member(client, _auth_signer)
    role = (await client.post(
        f"/guilds/{g['id']}/roles",
        json={"name": "Mods", "permissions": "0"},
        headers=auth(t_owner),
    )).json()
    r = await client.patch(
        f"/guilds/{g['id']}/roles/{role['id']}",
        json={"permissions": str(int(Permissions.MANAGE_MESSAGES))},
        headers=auth(t_owner),
    )
    assert r.status_code == 200, r.text
    assert int(r.json()["permissions"]) == int(Permissions.MANAGE_MESSAGES)


# ---- @everyone protections --------------------------------------------------


@pytest.mark.asyncio
async def test_everyone_cannot_be_renamed(client, _auth_signer):
    t_owner, _, _, g = await _make_guild_with_member(client, _auth_signer)
    roles = (await client.get(f"/guilds/{g['id']}/roles", headers=auth(t_owner))).json()
    everyone = next(r for r in roles if r["is_everyone"])
    r = await client.patch(
        f"/guilds/{g['id']}/roles/{everyone['id']}",
        json={"name": "Everyone Else"},
        headers=auth(t_owner),
    )
    assert r.status_code == 400
    assert "rename" in r.json()["detail"]


@pytest.mark.asyncio
async def test_everyone_cannot_be_deleted(client, _auth_signer):
    t_owner, _, _, g = await _make_guild_with_member(client, _auth_signer)
    roles = (await client.get(f"/guilds/{g['id']}/roles", headers=auth(t_owner))).json()
    everyone = next(r for r in roles if r["is_everyone"])
    r = await client.delete(
        f"/guilds/{g['id']}/roles/{everyone['id']}", headers=auth(t_owner)
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_everyone_position_cannot_be_changed(client, _auth_signer):
    t_owner, _, _, g = await _make_guild_with_member(client, _auth_signer)
    roles = (await client.get(f"/guilds/{g['id']}/roles", headers=auth(t_owner))).json()
    everyone = next(r for r in roles if r["is_everyone"])
    r = await client.patch(
        f"/guilds/{g['id']}/roles-positions",
        json={"positions": [{"id": everyone["id"], "position": 5}]},
        headers=auth(t_owner),
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_everyone_cannot_be_explicitly_assigned(client, _auth_signer):
    t_owner, _, uid_other, g = await _make_guild_with_member(client, _auth_signer)
    roles = (await client.get(f"/guilds/{g['id']}/roles", headers=auth(t_owner))).json()
    everyone = next(r for r in roles if r["is_everyone"])
    r = await client.put(
        f"/guilds/{g['id']}/members/{uid_other}/roles/{everyone['id']}",
        headers=auth(t_owner),
    )
    assert r.status_code == 400


# ---- Anti-escalation ------------------------------------------------------


@pytest.mark.asyncio
async def test_member_with_manage_roles_cannot_grant_admin(
    client, _auth_signer
):
    """A mod with MANAGE_ROLES but no ADMINISTRATOR cannot create a role
    that includes ADMINISTRATOR. Stoatchat-style anti-privilege-
    escalation."""
    t_owner, t_other, uid_other, g = await _make_guild_with_member(client, _auth_signer)
    mod_role = (await client.post(
        f"/guilds/{g['id']}/roles",
        json={
            "name": "Mod",
            "permissions": str(int(Permissions.MANAGE_ROLES)),
        },
        headers=auth(t_owner),
    )).json()
    await client.put(
        f"/guilds/{g['id']}/members/{uid_other}/roles/{mod_role['id']}",
        headers=auth(t_owner),
    )
    # Mod tries to create an ADMIN role.
    r = await client.post(
        f"/guilds/{g['id']}/roles",
        json={
            "name": "Pwn",
            "permissions": str(int(Permissions.ADMINISTRATOR)),
        },
        headers=auth(t_other),
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_member_cannot_assign_admin_role_without_admin(client, _auth_signer):
    """Mod with MANAGE_ROLES but no ADMINISTRATOR can't assign someone
    a role that has ADMINISTRATOR even if the role already exists."""
    t_owner, t_other, uid_other, g = await _make_guild_with_member(client, _auth_signer)
    # Owner creates both: an ADMIN role and a mod role.
    admin_role = (await client.post(
        f"/guilds/{g['id']}/roles",
        json={"name": "Admin", "permissions": str(int(Permissions.ADMINISTRATOR))},
        headers=auth(t_owner),
    )).json()
    mod_role = (await client.post(
        f"/guilds/{g['id']}/roles",
        json={"name": "Mod", "permissions": str(int(Permissions.MANAGE_ROLES))},
        headers=auth(t_owner),
    )).json()
    await client.put(
        f"/guilds/{g['id']}/members/{uid_other}/roles/{mod_role['id']}",
        headers=auth(t_owner),
    )
    # The mod-user tries to give themselves the ADMIN role.
    r = await client.put(
        f"/guilds/{g['id']}/members/{uid_other}/roles/{admin_role['id']}",
        headers=auth(t_other),
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_member_with_manage_roles_can_grant_bits_they_have(client, _auth_signer):
    """Positive control: a mod can grant bits *contained within* their own
    permissions — anti-escalation only blocks grants of bits the editor
    lacks."""
    t_owner, t_other, uid_other, g = await _make_guild_with_member(client, _auth_signer)
    perms = int(Permissions.MANAGE_ROLES | Permissions.MANAGE_MESSAGES)
    mod_role = (await client.post(
        f"/guilds/{g['id']}/roles",
        json={"name": "Mod", "permissions": str(perms)},
        headers=auth(t_owner),
    )).json()
    await client.put(
        f"/guilds/{g['id']}/members/{uid_other}/roles/{mod_role['id']}",
        headers=auth(t_owner),
    )
    r = await client.post(
        f"/guilds/{g['id']}/roles",
        json={"name": "JuniorMod", "permissions": str(int(Permissions.MANAGE_MESSAGES))},
        headers=auth(t_other),
    )
    assert r.status_code == 201, r.text


# ---- my_guild_permissions read-side ---------------------------------------


@pytest.mark.asyncio
async def test_my_guild_permissions_owner_grant_all_safe(client, _auth_signer):
    t_owner, _, _, g = await _make_guild_with_member(client, _auth_signer)
    r = await client.get(
        f"/guilds/{g['id']}/permissions/me", headers=auth(t_owner)
    )
    assert r.status_code == 200
    # GRANT_ALL_SAFE = (1<<52) - 1.
    assert int(r.json()["permissions"]) == (1 << 52) - 1


@pytest.mark.asyncio
async def test_my_guild_permissions_member_gets_everyone_default(
    client, _auth_signer
):
    """Plain member with no extra roles resolves to the @everyone default."""
    from dcc_shared.permissions import DEFAULT_EVERYONE_PERMISSIONS

    _, t_other, _, g = await _make_guild_with_member(client, _auth_signer)
    r = await client.get(
        f"/guilds/{g['id']}/permissions/me", headers=auth(t_other)
    )
    assert r.status_code == 200
    assert int(r.json()["permissions"]) == DEFAULT_EVERYONE_PERMISSIONS


# ---- bulk member-roles endpoint -------------------------------------------


@pytest.mark.asyncio
async def test_bulk_member_roles_returns_only_assigned(client, _auth_signer):
    """Members with explicit role assignments show up; members with only
    the implicit @everyone are omitted (clients treat absence as
    @everyone-only). @everyone-itself is never included."""
    t_owner, t_other, uid_other, g = await _make_guild_with_member(client, _auth_signer)
    role = (await client.post(
        f"/guilds/{g['id']}/roles",
        json={"name": "Mod", "permissions": "0"},
        headers=auth(t_owner),
    )).json()
    await client.put(
        f"/guilds/{g['id']}/members/{uid_other}/roles/{role['id']}",
        headers=auth(t_owner),
    )
    r = await client.get(f"/guilds/{g['id']}/member-roles", headers=auth(t_owner))
    assert r.status_code == 200
    body = r.json()
    assert body.get(str(uid_other)) == [role["id"]]


@pytest.mark.asyncio
async def test_bulk_member_roles_requires_membership(client, _auth_signer):
    t_owner, _ = await _register_user(_auth_signer)
    g = (await client.post(
        "/guilds", json={"name": "g"}, headers=auth(t_owner)
    )).json()
    t_stranger, _ = await _register_user(_auth_signer)
    r = await client.get(f"/guilds/{g['id']}/member-roles", headers=auth(t_stranger))
    assert r.status_code == 403
