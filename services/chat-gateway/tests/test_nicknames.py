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
