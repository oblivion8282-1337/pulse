"""Guild ban-list endpoints + join-block paths.

Endpoints under test:
  * PUT    /guilds/{gid}/bans/{uid}
  * DELETE /guilds/{gid}/bans/{uid}
  * GET    /guilds/{gid}/bans

Plus the two join-block side-effects:
  * POST /guilds/{gid}/members              (direct add)
  * POST /invites/{code}/accept             (invite acceptance)
"""

from __future__ import annotations

import random

import pytest


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register_user(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"user{uid}"), uid


async def _setup(client, _auth_signer) -> dict:
    """Owner + two regular members."""
    t_owner, uid_owner = await _register_user(_auth_signer)
    t_a, uid_a = await _register_user(_auth_signer)
    t_b, uid_b = await _register_user(_auth_signer)
    g = (
        await client.post("/guilds", json={"name": "bantown"}, headers=auth(t_owner))
    ).json()
    for uid in (uid_a, uid_b):
        await client.post(
            f"/guilds/{g['id']}/members",
            json={"user_id": str(uid)},
            headers=auth(t_owner),
        )
    return {
        "t_owner": t_owner,
        "uid_owner": uid_owner,
        "t_a": t_a,
        "uid_a": uid_a,
        "t_b": t_b,
        "uid_b": uid_b,
        "g": g,
    }


@pytest.mark.asyncio
async def test_owner_can_ban_member(client, _auth_signer):
    s = await _setup(client, _auth_signer)
    r = await client.put(
        f"/guilds/{s['g']['id']}/bans/{s['uid_a']}",
        json={"reason": "spam"},
        headers=auth(s["t_owner"]),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["user_id"] == str(s["uid_a"])
    assert body["reason"] == "spam"
    assert body["banned_by_id"] == str(s["uid_owner"])

    # Banned user is no longer a member.
    members = (
        await client.get(
            f"/guilds/{s['g']['id']}/members", headers=auth(s["t_owner"])
        )
    ).json()
    assert all(m["user_id"] != str(s["uid_a"]) for m in members)


@pytest.mark.asyncio
async def test_cannot_ban_self(client, _auth_signer):
    s = await _setup(client, _auth_signer)
    r = await client.put(
        f"/guilds/{s['g']['id']}/bans/{s['uid_owner']}",
        json={},
        headers=auth(s["t_owner"]),
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_cannot_ban_owner(client, _auth_signer):
    """A non-owner with BAN_MEMBERS still can't ban the owner — same
    asymmetric protection as kick."""
    s = await _setup(client, _auth_signer)
    # Give A the BAN_MEMBERS bit via a role to lift them above default
    # @everyone perms.
    role = (
        await client.post(
            f"/guilds/{s['g']['id']}/roles",
            json={"name": "mod", "permissions": str(1 << 9)},
            headers=auth(s["t_owner"]),
        )
    ).json()
    await client.put(
        f"/guilds/{s['g']['id']}/members/{s['uid_a']}/roles/{role['id']}",
        headers=auth(s["t_owner"]),
    )
    r = await client.put(
        f"/guilds/{s['g']['id']}/bans/{s['uid_owner']}",
        json={},
        headers=auth(s["t_a"]),
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_non_permitted_member_is_403(client, _auth_signer):
    s = await _setup(client, _auth_signer)
    r = await client.put(
        f"/guilds/{s['g']['id']}/bans/{s['uid_b']}",
        json={},
        headers=auth(s["t_a"]),
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_ban_blocks_re_add(client, _auth_signer):
    s = await _setup(client, _auth_signer)
    await client.put(
        f"/guilds/{s['g']['id']}/bans/{s['uid_a']}",
        json={},
        headers=auth(s["t_owner"]),
    )
    # Owner tries to add the banned user back — must 403.
    r = await client.post(
        f"/guilds/{s['g']['id']}/members",
        json={"user_id": str(s["uid_a"])},
        headers=auth(s["t_owner"]),
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_ban_blocks_invite_acceptance(client, _auth_signer):
    s = await _setup(client, _auth_signer)
    # Owner creates an invite, owner bans user A, A tries to accept it.
    invite = (
        await client.post(
            f"/guilds/{s['g']['id']}/invites",
            json={},
            headers=auth(s["t_owner"]),
        )
    ).json()
    await client.put(
        f"/guilds/{s['g']['id']}/bans/{s['uid_a']}",
        json={},
        headers=auth(s["t_owner"]),
    )
    r = await client.post(
        f"/invites/{invite['code']}/accept",
        headers=auth(s["t_a"]),
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_unban_allows_rejoin(client, _auth_signer):
    s = await _setup(client, _auth_signer)
    await client.put(
        f"/guilds/{s['g']['id']}/bans/{s['uid_a']}",
        json={},
        headers=auth(s["t_owner"]),
    )
    r = await client.delete(
        f"/guilds/{s['g']['id']}/bans/{s['uid_a']}",
        headers=auth(s["t_owner"]),
    )
    assert r.status_code == 204
    # Owner can re-add now.
    r2 = await client.post(
        f"/guilds/{s['g']['id']}/members",
        json={"user_id": str(s["uid_a"])},
        headers=auth(s["t_owner"]),
    )
    assert r2.status_code == 201


@pytest.mark.asyncio
async def test_unban_404_when_not_banned(client, _auth_signer):
    s = await _setup(client, _auth_signer)
    r = await client.delete(
        f"/guilds/{s['g']['id']}/bans/{s['uid_a']}",
        headers=auth(s["t_owner"]),
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_list_bans_requires_ban_members(client, _auth_signer):
    s = await _setup(client, _auth_signer)
    # Regular member can't see the list.
    r = await client.get(
        f"/guilds/{s['g']['id']}/bans", headers=auth(s["t_a"])
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_list_bans_owner(client, _auth_signer):
    s = await _setup(client, _auth_signer)
    await client.put(
        f"/guilds/{s['g']['id']}/bans/{s['uid_a']}",
        json={"reason": "raid"},
        headers=auth(s["t_owner"]),
    )
    await client.put(
        f"/guilds/{s['g']['id']}/bans/{s['uid_b']}",
        json={"reason": None},
        headers=auth(s["t_owner"]),
    )
    r = await client.get(
        f"/guilds/{s['g']['id']}/bans", headers=auth(s["t_owner"])
    )
    assert r.status_code == 200
    body = r.json()
    assert len(body) == 2
    user_ids = {row["user_id"] for row in body}
    assert user_ids == {str(s["uid_a"]), str(s["uid_b"])}


@pytest.mark.asyncio
async def test_ban_non_member_user_still_blocks_future_join(client, _auth_signer):
    """A user who has never been a member can be pre-banned. The 403
    triggers when they try to accept a future invite."""
    s = await _setup(client, _auth_signer)
    t_new, uid_new = await _register_user(_auth_signer)
    r = await client.put(
        f"/guilds/{s['g']['id']}/bans/{uid_new}",
        json={},
        headers=auth(s["t_owner"]),
    )
    assert r.status_code == 200
    invite = (
        await client.post(
            f"/guilds/{s['g']['id']}/invites",
            json={},
            headers=auth(s["t_owner"]),
        )
    ).json()
    r2 = await client.post(
        f"/invites/{invite['code']}/accept",
        headers=auth(t_new),
    )
    assert r2.status_code == 403


@pytest.mark.asyncio
async def test_mod_can_ban_peer_mod_no_hierarchy(client, _auth_signer):
    """No position-hierarchy in v1 — a mod with BAN_MEMBERS can ban
    another mod that holds the same (or higher) permission bits.
    Pulse-v1 is self-host MVP where mods are trusted; if a Discord-
    style hierarchy lands later, flip this test to 403."""
    s = await _setup(client, _auth_signer)
    # Grant both A and B a mod role with BAN_MEMBERS + MANAGE_ROLES.
    mod_role = (
        await client.post(
            f"/guilds/{s['g']['id']}/roles",
            json={
                "name": "mod",
                "permissions": str((1 << 9) | (1 << 3)),  # BAN | MANAGE_ROLES
            },
            headers=auth(s["t_owner"]),
        )
    ).json()
    for uid in (s["uid_a"], s["uid_b"]):
        await client.put(
            f"/guilds/{s['g']['id']}/members/{uid}/roles/{mod_role['id']}",
            headers=auth(s["t_owner"]),
        )
    # A bans B — currently allowed.
    r = await client.put(
        f"/guilds/{s['g']['id']}/bans/{s['uid_b']}",
        json={"reason": "mod-vs-mod"},
        headers=auth(s["t_a"]),
    )
    assert r.status_code == 200
