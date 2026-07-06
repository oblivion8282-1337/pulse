"""Per-guild nickname endpoints.

Endpoints:
- PATCH /guilds/{gid}/members/@me  — needs CHANGE_NICKNAME
- PATCH /guilds/{gid}/members/{uid} — needs MANAGE_NICKNAMES

@everyone seeded by create_guild grants CHANGE_NICKNAME by default
(``DEFAULT_EVERYONE_PERMISSIONS``), so any member can edit their own.
MANAGE_NICKNAMES is owner-only by default — verified via the
non-permitted-member-403 test below.
"""

from __future__ import annotations

import random

import pytest


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register_user(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"user{uid}"), uid


async def _setup(client, _auth_signer):
    t_owner, uid_owner = await _register_user(_auth_signer)
    t_other, uid_other = await _register_user(_auth_signer)
    g = (
        await client.post("/guilds", json={"name": "nicks"}, headers=auth(t_owner))
    ).json()
    await client.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": str(uid_other)},
        headers=auth(t_owner),
    )
    return t_owner, uid_owner, t_other, uid_other, g


@pytest.mark.asyncio
async def test_self_nickname_set_and_clear(client, _auth_signer):
    _, _, t_other, uid_other, g = await _setup(client, _auth_signer)

    r = await client.patch(
        f"/guilds/{g['id']}/members/@me",
        json={"nickname": "  Coolname  "},
        headers=auth(t_other),
    )
    assert r.status_code == 200, r.text
    assert r.json()["nickname"] == "Coolname"  # trimmed

    # Empty string clears it.
    r = await client.patch(
        f"/guilds/{g['id']}/members/@me",
        json={"nickname": ""},
        headers=auth(t_other),
    )
    assert r.status_code == 200
    assert r.json()["nickname"] is None


@pytest.mark.asyncio
async def test_self_nickname_max_length_64(client, _auth_signer):
    _, _, t_other, _, g = await _setup(client, _auth_signer)
    r = await client.patch(
        f"/guilds/{g['id']}/members/@me",
        json={"nickname": "x" * 65},
        headers=auth(t_other),
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_self_nickname_not_a_member_is_404(client, _auth_signer):
    """Caller targets @me on a guild they're not in → 404 before the
    permission gate runs (avoids leaking which guilds exist)."""
    t_outsider, _ = await _register_user(_auth_signer)
    t_owner, _ = await _register_user(_auth_signer)
    g = (
        await client.post("/guilds", json={"name": "x"}, headers=auth(t_owner))
    ).json()
    r = await client.patch(
        f"/guilds/{g['id']}/members/@me",
        json={"nickname": "nope"},
        headers=auth(t_outsider),
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_admin_route_rejects_self(client, _auth_signer):
    """Calling .../members/{own_id} must 400 — forces the caller to use
    the @me path so the two permission gates stay separated."""
    t_owner, uid_owner, _, _, g = await _setup(client, _auth_signer)
    r = await client.patch(
        f"/guilds/{g['id']}/members/{uid_owner}",
        json={"nickname": "owner-of-self"},
        headers=auth(t_owner),
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_owner_can_set_member_nickname(client, _auth_signer):
    """Owner has GRANT_ALL_SAFE → bypasses MANAGE_NICKNAMES."""
    t_owner, _, _, uid_other, g = await _setup(client, _auth_signer)
    r = await client.patch(
        f"/guilds/{g['id']}/members/{uid_other}",
        json={"nickname": "Forced"},
        headers=auth(t_owner),
    )
    assert r.status_code == 200
    assert r.json()["nickname"] == "Forced"


@pytest.mark.asyncio
async def test_non_owner_without_manage_nicknames_is_403(client, _auth_signer):
    """Default @everyone grants CHANGE_NICKNAME but not MANAGE_NICKNAMES
    — a regular member trying to rename someone else must 403."""
    t_owner, _ = await _register_user(_auth_signer)
    t_a, uid_a = await _register_user(_auth_signer)
    t_b, uid_b = await _register_user(_auth_signer)
    g = (
        await client.post("/guilds", json={"name": "n"}, headers=auth(t_owner))
    ).json()
    for uid in (uid_a, uid_b):
        await client.post(
            f"/guilds/{g['id']}/members",
            json={"user_id": str(uid)},
            headers=auth(t_owner),
        )
    r = await client.patch(
        f"/guilds/{g['id']}/members/{uid_b}",
        json={"nickname": "spite"},
        headers=auth(t_a),
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_admin_route_on_missing_member_is_404(client, _auth_signer):
    t_owner, _, _, _, g = await _setup(client, _auth_signer)
    r = await client.patch(
        f"/guilds/{g['id']}/members/999999",
        json={"nickname": "nope"},
        headers=auth(t_owner),
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_admin_route_non_member_empty_body_is_rejected(client, _auth_signer):
    """Regression (IDOR): a non-member hitting .../members/{uid} with an empty
    body `{}` must NOT receive the target member's row. The membership check
    runs before the target fetch, so an outsider gets 403 — never a 200 that
    would leak the nickname/join-time or act as a cross-guild membership
    oracle (200-vs-404)."""
    t_owner, _ = await _register_user(_auth_signer)
    t_target, uid_target = await _register_user(_auth_signer)
    t_outsider, _ = await _register_user(_auth_signer)
    g = (
        await client.post("/guilds", json={"name": "idor"}, headers=auth(t_owner))
    ).json()
    await client.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": str(uid_target)},
        headers=auth(t_owner),
    )
    r = await client.patch(
        f"/guilds/{g['id']}/members/{uid_target}",
        json={},
        headers=auth(t_outsider),
    )
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_empty_payload_is_noop(client, _auth_signer):
    """``nickname: null`` (or omitted) means 'don't touch' — the route
    returns the current row without writing or publishing an event."""
    _, _, t_other, _, g = await _setup(client, _auth_signer)
    # First set a nickname so we have something to verify isn't changed.
    await client.patch(
        f"/guilds/{g['id']}/members/@me",
        json={"nickname": "Stable"},
        headers=auth(t_other),
    )
    r = await client.patch(
        f"/guilds/{g['id']}/members/@me",
        json={},
        headers=auth(t_other),
    )
    assert r.status_code == 200
    assert r.json()["nickname"] == "Stable"


# --- hierarchy / owner protection (parity with kick_member) -----------------
#
# MANAGE_NICKNAMES alone is not enough — the owner is immune and a mod may
# only rename members strictly below their own top role (Discord semantics).
MANAGE_NICKNAMES = 1 << 11  # Permissions.MANAGE_NICKNAMES


async def _grant_role(client, g, owner_token, name, permissions, *uids) -> dict:
    """Owner creates a role (position = max+1, so later = higher) and
    assigns it to ``uids``. Mirrors ``test_kick._grant_role``."""
    role = (
        await client.post(
            f"/guilds/{g['id']}/roles",
            json={"name": name, "permissions": str(permissions)},
            headers=auth(owner_token),
        )
    ).json()
    for uid in uids:
        await client.put(
            f"/guilds/{g['id']}/members/{uid}/roles/{role['id']}",
            headers=auth(owner_token),
        )
    return role


async def _add_member(client, g, owner_token, uid) -> None:
    await client.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": str(uid)},
        headers=auth(owner_token),
    )


@pytest.mark.asyncio
async def test_mod_cannot_rename_owner(client, _auth_signer):
    """Owner is immune: a mod with MANAGE_NICKNAMES must not rebrand the
    guild owner (mirrors kick_member's owner guard)."""
    t_owner, uid_owner = await _register_user(_auth_signer)
    t_mod, uid_mod = await _register_user(_auth_signer)
    g = (
        await client.post("/guilds", json={"name": "own"}, headers=auth(t_owner))
    ).json()
    await _add_member(client, g, t_owner, uid_mod)
    await _grant_role(client, g, t_owner, "mod", MANAGE_NICKNAMES, uid_mod)
    r = await client.patch(
        f"/guilds/{g['id']}/members/{uid_owner}",
        json={"nickname": "punked"},
        headers=auth(t_mod),
    )
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_mod_cannot_rename_higher_member(client, _auth_signer):
    """A mod can't rename a member whose top role sits strictly above
    their own."""
    t_owner, _ = await _register_user(_auth_signer)
    t_mod, uid_mod = await _register_user(_auth_signer)
    _, uid_senior = await _register_user(_auth_signer)
    g = (
        await client.post("/guilds", json={"name": "hi"}, headers=auth(t_owner))
    ).json()
    await _add_member(client, g, t_owner, uid_mod)
    await _add_member(client, g, t_owner, uid_senior)
    await _grant_role(client, g, t_owner, "mod", MANAGE_NICKNAMES, uid_mod)
    await _grant_role(client, g, t_owner, "senior", 0, uid_senior)  # higher position
    r = await client.patch(
        f"/guilds/{g['id']}/members/{uid_senior}",
        json={"nickname": "lowered"},
        headers=auth(t_mod),
    )
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_mod_cannot_rename_peer_same_role(client, _auth_signer):
    """Equal top role positions block the rename — two mods sharing one
    role can't rebrand each other."""
    t_owner, _ = await _register_user(_auth_signer)
    t_a, uid_a = await _register_user(_auth_signer)
    _, uid_b = await _register_user(_auth_signer)
    g = (
        await client.post("/guilds", json={"name": "peer"}, headers=auth(t_owner))
    ).json()
    await _add_member(client, g, t_owner, uid_a)
    await _add_member(client, g, t_owner, uid_b)
    await _grant_role(client, g, t_owner, "mod", MANAGE_NICKNAMES, uid_a, uid_b)
    r = await client.patch(
        f"/guilds/{g['id']}/members/{uid_b}",
        json={"nickname": "spite"},
        headers=auth(t_a),
    )
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_mod_can_rename_lower_member(client, _auth_signer):
    """Strictly higher top role → rename succeeds. Target with no extra
    roles sits at the @everyone baseline (position 0)."""
    t_owner, _ = await _register_user(_auth_signer)
    t_mod, uid_mod = await _register_user(_auth_signer)
    _, uid_low = await _register_user(_auth_signer)
    g = (
        await client.post("/guilds", json={"name": "lo"}, headers=auth(t_owner))
    ).json()
    await _add_member(client, g, t_owner, uid_mod)
    await _add_member(client, g, t_owner, uid_low)
    await _grant_role(client, g, t_owner, "mod", MANAGE_NICKNAMES, uid_mod)
    r = await client.patch(
        f"/guilds/{g['id']}/members/{uid_low}",
        json={"nickname": "renamed"},
        headers=auth(t_mod),
    )
    assert r.status_code == 200, r.text
    assert r.json()["nickname"] == "renamed"
