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


# ---- Delete + reorder happy paths ------------------------------------------


@pytest.mark.asyncio
async def test_delete_role_happy_path_as_owner(client, _auth_signer):
    """Owner creates a role, deletes it, follow-up list confirms absence.
    Discord-style: delete is idempotent at the wire level (the next call
    on the same id would 404, but that path is covered elsewhere)."""
    t_owner, _, _, g = await _make_guild_with_member(client, _auth_signer)
    mod = (await client.post(
        f"/guilds/{g['id']}/roles",
        json={"name": "Mod", "permissions": "0"},
        headers=auth(t_owner),
    )).json()

    r = await client.delete(
        f"/guilds/{g['id']}/roles/{mod['id']}", headers=auth(t_owner)
    )
    assert r.status_code == 204, r.text

    roles = (await client.get(
        f"/guilds/{g['id']}/roles", headers=auth(t_owner)
    )).json()
    assert mod["id"] not in {r["id"] for r in roles}


@pytest.mark.asyncio
async def test_delete_role_403_without_manage_roles(client, _auth_signer):
    """Regular member without MANAGE_ROLES gets a 403 on delete — the
    @everyone default doesn't include MANAGE_ROLES so this is the bare
    'member tries to delete' path."""
    t_owner, t_other, _, g = await _make_guild_with_member(client, _auth_signer)
    mod = (await client.post(
        f"/guilds/{g['id']}/roles",
        json={"name": "Mod", "permissions": "0"},
        headers=auth(t_owner),
    )).json()

    r = await client.delete(
        f"/guilds/{g['id']}/roles/{mod['id']}", headers=auth(t_other)
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_roles_positions_happy_path(client, _auth_signer):
    """Owner creates two roles and reorders both in one PATCH. The
    follow-up GET reflects the requested positions; the order is
    descending by position (see ``list_roles``), so we just verify
    the per-role position values."""
    t_owner, _, _, g = await _make_guild_with_member(client, _auth_signer)
    a = (await client.post(
        f"/guilds/{g['id']}/roles",
        json={"name": "Alpha", "permissions": "0"},
        headers=auth(t_owner),
    )).json()
    b = (await client.post(
        f"/guilds/{g['id']}/roles",
        json={"name": "Beta", "permissions": "0"},
        headers=auth(t_owner),
    )).json()

    # Move Alpha above Beta. New positions: Beta=5, Alpha=10 → Alpha is
    # the higher-position role on the follow-up read.
    r = await client.patch(
        f"/guilds/{g['id']}/roles-positions",
        json={
            "positions": [
                {"id": a["id"], "position": 10},
                {"id": b["id"], "position": 5},
            ]
        },
        headers=auth(t_owner),
    )
    assert r.status_code == 200, r.text

    roles = (await client.get(
        f"/guilds/{g['id']}/roles", headers=auth(t_owner)
    )).json()
    by_id = {row["id"]: row for row in roles}
    assert by_id[a["id"]]["position"] == 10
    assert by_id[b["id"]]["position"] == 5


@pytest.mark.asyncio
async def test_reorder_positions_anti_escalation_blocks_role_above_actor(
    client, _auth_signer
):
    """A mod with MANAGE_ROLES cannot reorder a role that sits at/above
    their own highest role — otherwise they could push an admin's role
    below theirs and then kick/ban its holders via the position-based
    hierarchy check. The reorder must 403 and leave positions untouched."""
    t_owner, t_mod, uid_mod, g = await _make_guild_with_member(client, _auth_signer)
    mod_role = (await client.post(
        f"/guilds/{g['id']}/roles",
        json={"name": "Mod", "permissions": str(int(Permissions.MANAGE_ROLES))},
        headers=auth(t_owner),
    )).json()  # position 1
    higher_role = (await client.post(
        f"/guilds/{g['id']}/roles",
        json={"name": "Higher", "permissions": "0"},
        headers=auth(t_owner),
    )).json()  # position 2 — above the mod's ceiling
    await client.put(
        f"/guilds/{g['id']}/members/{uid_mod}/roles/{mod_role['id']}",
        headers=auth(t_owner),
    )

    # Mod (actor_top == 1) tries to drop the higher role beneath theirs.
    r = await client.patch(
        f"/guilds/{g['id']}/roles-positions",
        json={"positions": [{"id": higher_role["id"], "position": 0}]},
        headers=auth(t_mod),
    )
    assert r.status_code == 403

    # Self-promotion above the ceiling is rejected too.
    r2 = await client.patch(
        f"/guilds/{g['id']}/roles-positions",
        json={"positions": [{"id": mod_role["id"], "position": 50}]},
        headers=auth(t_mod),
    )
    assert r2.status_code == 403

    # Positions are unchanged after the rejected reorders.
    roles = (await client.get(f"/guilds/{g['id']}/roles", headers=auth(t_owner))).json()
    by_id = {row["id"]: row for row in roles}
    assert by_id[higher_role["id"]]["position"] == 2
    assert by_id[mod_role["id"]]["position"] == 1


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
async def test_assign_role_anti_escalation_blocks_non_admin_bits(
    client, _auth_signer
):
    """Mod with MANAGE_ROLES (only) cannot assign a role granting BAN_MEMBERS
    — they don't hold BAN_MEMBERS themselves, so the assign would smuggle in
    a privilege escalation. Anti-escalation is broader than just ADMINISTRATOR."""
    t_owner, t_mod, uid_mod, g = await _make_guild_with_member(client, _auth_signer)
    # Owner creates: a "ban-only" role + a "mod" role.
    ban_role = (await client.post(
        f"/guilds/{g['id']}/roles",
        json={"name": "Banhammer", "permissions": str(int(Permissions.BAN_MEMBERS))},
        headers=auth(t_owner),
    )).json()
    mod_role = (await client.post(
        f"/guilds/{g['id']}/roles",
        json={"name": "Mod", "permissions": str(int(Permissions.MANAGE_ROLES))},
        headers=auth(t_owner),
    )).json()
    await client.put(
        f"/guilds/{g['id']}/members/{uid_mod}/roles/{mod_role['id']}",
        headers=auth(t_owner),
    )
    # Mod tries to assign the Banhammer role to themselves.
    r = await client.put(
        f"/guilds/{g['id']}/members/{uid_mod}/roles/{ban_role['id']}",
        headers=auth(t_mod),
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_unassign_role_anti_escalation_blocks_non_admin_bits(
    client, _auth_signer
):
    """A mod who can't grant BAN_MEMBERS also can't unassign a BAN_MEMBERS
    role — unassigning is a privilege change of the same blast radius."""
    t_owner, t_mod, uid_mod, g = await _make_guild_with_member(client, _auth_signer)
    # Third user gets the ban-role assigned by the owner.
    t_victim, uid_victim = await _register_user(_auth_signer)
    await client.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": str(uid_victim)},
        headers=auth(t_owner),
    )
    ban_role = (await client.post(
        f"/guilds/{g['id']}/roles",
        json={"name": "Banhammer", "permissions": str(int(Permissions.BAN_MEMBERS))},
        headers=auth(t_owner),
    )).json()
    await client.put(
        f"/guilds/{g['id']}/members/{uid_victim}/roles/{ban_role['id']}",
        headers=auth(t_owner),
    )
    # Mod (only MANAGE_ROLES) tries to unassign Banhammer from victim.
    mod_role = (await client.post(
        f"/guilds/{g['id']}/roles",
        json={"name": "Mod", "permissions": str(int(Permissions.MANAGE_ROLES))},
        headers=auth(t_owner),
    )).json()
    await client.put(
        f"/guilds/{g['id']}/members/{uid_mod}/roles/{mod_role['id']}",
        headers=auth(t_owner),
    )
    r = await client.delete(
        f"/guilds/{g['id']}/members/{uid_victim}/roles/{ban_role['id']}",
        headers=auth(t_mod),
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_delete_role_anti_escalation_blocks_non_admin_bits(
    client, _auth_signer
):
    """Mod with MANAGE_ROLES (only) cannot delete a role granting BAN_MEMBERS.
    Deleting it strips the bit from every holder — same privilege change
    as bulk-unassign — so the editor must hold every bit the role carries."""
    t_owner, t_mod, uid_mod, g = await _make_guild_with_member(client, _auth_signer)
    ban_role = (await client.post(
        f"/guilds/{g['id']}/roles",
        json={"name": "Banhammer", "permissions": str(int(Permissions.BAN_MEMBERS))},
        headers=auth(t_owner),
    )).json()
    mod_role = (await client.post(
        f"/guilds/{g['id']}/roles",
        json={"name": "Mod", "permissions": str(int(Permissions.MANAGE_ROLES))},
        headers=auth(t_owner),
    )).json()
    await client.put(
        f"/guilds/{g['id']}/members/{uid_mod}/roles/{mod_role['id']}",
        headers=auth(t_owner),
    )
    r = await client.delete(
        f"/guilds/{g['id']}/roles/{ban_role['id']}",
        headers=auth(t_mod),
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


# ---- Rang: gleich berechtigt, verschieden hoch ------------------------------


async def _zwei_mod_rollen(client, _auth_signer):
    """Owner, ein Mitglied mit einer NIEDRIGEN Mod-Rolle, und eine HOEHERE
    Mod-Rolle mit denselben Rechten.
    Liefert (t_owner, t_other, gid, hohe_rolle_id).

    Beide Rollen tragen exakt MANAGE_ROLES — die Bit-Schranke greift hier also
    nicht, nur der Rang unterscheidet sie.
    """
    t_owner, t_other, uid_other, g = await _make_guild_with_member(client, _auth_signer)
    bits = str(int(Permissions.MANAGE_ROLES) | int(Permissions.VIEW_CHANNEL))
    niedrig = (await client.post(
        f"/guilds/{g['id']}/roles",
        json={"name": "Mod unten", "permissions": bits},
        headers=auth(t_owner),
    )).json()
    hoch = (await client.post(
        f"/guilds/{g['id']}/roles",
        json={"name": "Mod oben", "permissions": bits},
        headers=auth(t_owner),
    )).json()
    # Neu angelegte Rollen bekommen max+1 — die zweite steht also hoeher.
    assert hoch["position"] > niedrig["position"]
    await client.put(
        f"/guilds/{g['id']}/members/{uid_other}/roles/{niedrig['id']}",
        headers=auth(t_owner),
    )
    return t_owner, t_other, g["id"], hoch["id"]


@pytest.mark.asyncio
async def test_niedrige_rolle_kann_hoehere_nicht_bearbeiten(client, _auth_signer):
    """**Der Rang zaehlt, nicht nur die Bits.**

    Zwei Mod-Rollen mit identischen Rechten: die Bit-Schranke laesst den
    Zugriff durch (der Bearbeiter haelt jedes Bit der Zielrolle). Bis
    2026-08-13 konnte die niedrigere die hoehere damit umbenennen, leerraeumen
    und loeschen — und ihre Traeger serverweit entmachten. Beim Umsortieren
    wurde der Rang laengst geprueft, hier nicht.
    """
    _t_owner, t_other, gid, hoch_id = await _zwei_mod_rollen(client, _auth_signer)

    r = await client.patch(
        f"/guilds/{gid}/roles/{hoch_id}",
        json={"name": "gekapert"},
        headers=auth(t_other),
    )
    assert r.status_code == 403, r.text

    r = await client.delete(f"/guilds/{gid}/roles/{hoch_id}", headers=auth(t_other))
    assert r.status_code == 403, r.text

    # Und sie steht unveraendert da.
    rollen = (await client.get(f"/guilds/{gid}/roles", headers=auth(t_other))).json()
    assert any(x["id"] == hoch_id and x["name"] == "Mod oben" for x in rollen)


@pytest.mark.asyncio
async def test_niedrige_rolle_kann_hoehere_nicht_im_kanal_aussperren(
    client, _auth_signer
):
    """Dieselbe Luecke eine Ebene tiefer: die Kanal-Ausnahme. Ohne Rang-Pruefung
    konnte der rangniedrige Moderator der hoeheren Rolle in einem Kanal die
    Sicht nehmen — die Anti-Eskalation daneben prueft nur, welche BITS er
    selbst haelt, nicht, wen er trifft.
    """
    t_owner, t_other, gid, hoch_id = await _zwei_mod_rollen(client, _auth_signer)
    # Kanal legt der Owner an — der rangniedrige Moderator braucht ihn nur, um
    # darin eine Ausnahme zu setzen, und soll genau daran scheitern.
    kanal = await client.post(
        f"/guilds/{gid}/channels",
        json={"name": "geheim", "type": 0},
        headers=auth(t_owner),
    )
    assert kanal.status_code == 201, kanal.text
    cid = kanal.json()["id"]

    r = await client.put(
        f"/channels/{cid}/permissions/0/{hoch_id}",
        json={"allow": "0", "deny": str(int(Permissions.VIEW_CHANNEL))},
        headers=auth(t_other),
    )
    assert r.status_code == 403, r.text
