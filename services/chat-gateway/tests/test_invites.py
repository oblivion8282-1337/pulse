"""Tests for the guild invite flow."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import update


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register_user(_auth_signer, uid: int | None = None) -> tuple[str, int]:
    import random

    uid = uid or random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"user{uid}"), uid


async def _make_guild(client, token: str, name: str = "g") -> dict:
    return (await client.post("/guilds", json={"name": name}, headers=auth(token))).json()


async def _make_channel(client, token: str, guild_id: str, name: str = "general") -> dict:
    return (
        await client.post(
            f"/guilds/{guild_id}/channels", json={"name": name}, headers=auth(token)
        )
    ).json()


# ---- create / list ---------------------------------------------------------


@pytest.mark.asyncio
async def test_create_invite_as_member(client, _auth_signer):
    owner_t, _ = await _register_user(_auth_signer)
    g = await _make_guild(client, owner_t)
    r = await client.post(f"/guilds/{g['id']}/invites", json={}, headers=auth(owner_t))
    assert r.status_code == 201, r.text
    body = r.json()
    assert len(body["code"]) == 8
    assert body["guild_id"] == g["id"]
    assert body["uses"] == 0
    assert body["channel_id"] is None
    assert body["max_uses"] is None


@pytest.mark.asyncio
async def test_create_invite_with_channel(client, _auth_signer):
    owner_t, _ = await _register_user(_auth_signer)
    g = await _make_guild(client, owner_t)
    c = await _make_channel(client, owner_t, g["id"])
    r = await client.post(
        f"/guilds/{g['id']}/invites",
        json={"channel_id": c["id"], "max_uses": 5, "expires_in_seconds": 3600},
        headers=auth(owner_t),
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["channel_id"] == c["id"]
    assert body["max_uses"] == 5
    assert body["expires_at"] is not None


@pytest.mark.asyncio
async def test_create_invite_channel_wrong_guild(client, _auth_signer):
    owner_t, _ = await _register_user(_auth_signer)
    g1 = await _make_guild(client, owner_t, "g1")
    g2 = await _make_guild(client, owner_t, "g2")
    c2 = await _make_channel(client, owner_t, g2["id"])
    r = await client.post(
        f"/guilds/{g1['id']}/invites",
        json={"channel_id": c2["id"]},
        headers=auth(owner_t),
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_create_invite_as_non_member_forbidden(client, _auth_signer):
    owner_t, _ = await _register_user(_auth_signer)
    intruder_t, _ = await _register_user(_auth_signer)
    g = await _make_guild(client, owner_t)
    r = await client.post(f"/guilds/{g['id']}/invites", json={}, headers=auth(intruder_t))
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_create_invite_requires_auth(client, _auth_signer):
    owner_t, _ = await _register_user(_auth_signer)
    g = await _make_guild(client, owner_t)
    r = await client.post(f"/guilds/{g['id']}/invites", json={})
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_list_invites_shows_only_active(client, _auth_signer, session_factory):
    owner_t, _ = await _register_user(_auth_signer)
    g = await _make_guild(client, owner_t)
    active = (
        await client.post(f"/guilds/{g['id']}/invites", json={}, headers=auth(owner_t))
    ).json()
    revoked = (
        await client.post(f"/guilds/{g['id']}/invites", json={}, headers=auth(owner_t))
    ).json()
    expired = (
        await client.post(
            f"/guilds/{g['id']}/invites",
            json={"expires_in_seconds": 60},
            headers=auth(owner_t),
        )
    ).json()
    # revoke one
    await client.delete(f"/invites/{revoked['code']}", headers=auth(owner_t))
    # force-expire one
    from dcc_chat_gateway.models import GuildInvite

    async with session_factory() as s:
        await s.execute(
            update(GuildInvite)
            .where(GuildInvite.code == expired["code"])
            .values(expires_at=datetime.now(tz=UTC) - timedelta(seconds=1))
            .execution_options(synchronize_session=False)
        )
        await s.commit()

    listing = (await client.get(f"/guilds/{g['id']}/invites", headers=auth(owner_t))).json()
    codes = {inv["code"] for inv in listing}
    assert codes == {active["code"]}


@pytest.mark.asyncio
async def test_list_invites_non_member_forbidden(client, _auth_signer):
    owner_t, _ = await _register_user(_auth_signer)
    intruder_t, _ = await _register_user(_auth_signer)
    g = await _make_guild(client, owner_t)
    r = await client.get(f"/guilds/{g['id']}/invites", headers=auth(intruder_t))
    assert r.status_code == 403


# ---- preview ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_invite_preview(client, _auth_signer):
    owner_t, _ = await _register_user(_auth_signer)
    other_t, _ = await _register_user(_auth_signer)
    g = await _make_guild(client, owner_t, "Cool Guild")
    inv = (
        await client.post(f"/guilds/{g['id']}/invites", json={}, headers=auth(owner_t))
    ).json()
    r = await client.get(f"/invites/{inv['code']}", headers=auth(other_t))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["guild"]["id"] == g["id"]
    assert body["guild"]["name"] == "Cool Guild"
    assert body["member_count"] == 1


@pytest.mark.asyncio
async def test_get_invite_preview_requires_auth(client, _auth_signer):
    owner_t, _ = await _register_user(_auth_signer)
    g = await _make_guild(client, owner_t)
    inv = (
        await client.post(f"/guilds/{g['id']}/invites", json={}, headers=auth(owner_t))
    ).json()
    r = await client.get(f"/invites/{inv['code']}")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_get_invite_preview_unknown_code(client, _auth_signer):
    t, _ = await _register_user(_auth_signer)
    r = await client.get("/invites/ZZZZZZZZ", headers=auth(t))
    assert r.status_code == 404
    assert r.json()["detail"] == "invite invalid or expired"


@pytest.mark.asyncio
async def test_get_invite_preview_expired(client, _auth_signer, session_factory):
    owner_t, _ = await _register_user(_auth_signer)
    other_t, _ = await _register_user(_auth_signer)
    g = await _make_guild(client, owner_t)
    inv = (
        await client.post(
            f"/guilds/{g['id']}/invites",
            json={"expires_in_seconds": 60},
            headers=auth(owner_t),
        )
    ).json()
    from dcc_chat_gateway.models import GuildInvite

    async with session_factory() as s:
        await s.execute(
            update(GuildInvite)
            .where(GuildInvite.code == inv["code"])
            .values(expires_at=datetime.now(tz=UTC) - timedelta(seconds=1))
            .execution_options(synchronize_session=False)
        )
        await s.commit()
    r = await client.get(f"/invites/{inv['code']}", headers=auth(other_t))
    assert r.status_code == 404


# ---- accept ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_accept_invite_joins_guild(client, _auth_signer):
    owner_t, _ = await _register_user(_auth_signer)
    joiner_t, joiner_uid = await _register_user(_auth_signer)
    g = await _make_guild(client, owner_t)
    c = await _make_channel(client, owner_t, g["id"])
    inv = (
        await client.post(
            f"/guilds/{g['id']}/invites", json={"channel_id": c["id"]}, headers=auth(owner_t)
        )
    ).json()
    r = await client.post(f"/invites/{inv['code']}/accept", headers=auth(joiner_t))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["guild"]["id"] == g["id"]
    assert body["channel_id"] == c["id"]
    # joiner is now a member: can list channels
    r2 = await client.get(f"/guilds/{g['id']}/channels", headers=auth(joiner_t))
    assert r2.status_code == 200
    # uses incremented
    listing = (await client.get(f"/guilds/{g['id']}/invites", headers=auth(owner_t))).json()
    assert listing[0]["uses"] == 1


@pytest.mark.asyncio
async def test_accept_invite_fallback_channel(client, _auth_signer):
    owner_t, _ = await _register_user(_auth_signer)
    joiner_t, _ = await _register_user(_auth_signer)
    g = await _make_guild(client, owner_t)
    c = await _make_channel(client, owner_t, g["id"])
    inv = (
        await client.post(f"/guilds/{g['id']}/invites", json={}, headers=auth(owner_t))
    ).json()
    r = await client.post(f"/invites/{inv['code']}/accept", headers=auth(joiner_t))
    assert r.status_code == 200, r.text
    assert r.json()["channel_id"] == c["id"]


@pytest.mark.asyncio
async def test_accept_invite_already_member_idempotent(client, _auth_signer):
    owner_t, _ = await _register_user(_auth_signer)
    g = await _make_guild(client, owner_t)
    inv = (
        await client.post(f"/guilds/{g['id']}/invites", json={}, headers=auth(owner_t))
    ).json()
    # owner is already a member
    r = await client.post(f"/invites/{inv['code']}/accept", headers=auth(owner_t))
    assert r.status_code == 200, r.text
    assert r.json()["guild"]["id"] == g["id"]
    listing = (await client.get(f"/guilds/{g['id']}/invites", headers=auth(owner_t))).json()
    assert listing[0]["uses"] == 0


@pytest.mark.asyncio
async def test_accept_invite_expired(client, _auth_signer, session_factory):
    owner_t, _ = await _register_user(_auth_signer)
    joiner_t, _ = await _register_user(_auth_signer)
    g = await _make_guild(client, owner_t)
    inv = (
        await client.post(
            f"/guilds/{g['id']}/invites",
            json={"expires_in_seconds": 60},
            headers=auth(owner_t),
        )
    ).json()
    from dcc_chat_gateway.models import GuildInvite

    async with session_factory() as s:
        await s.execute(
            update(GuildInvite)
            .where(GuildInvite.code == inv["code"])
            .values(expires_at=datetime.now(tz=UTC) - timedelta(seconds=1))
            .execution_options(synchronize_session=False)
        )
        await s.commit()
    r = await client.post(f"/invites/{inv['code']}/accept", headers=auth(joiner_t))
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_accept_invite_max_uses_reached(client, _auth_signer):
    owner_t, _ = await _register_user(_auth_signer)
    j1_t, _ = await _register_user(_auth_signer)
    j2_t, _ = await _register_user(_auth_signer)
    g = await _make_guild(client, owner_t)
    inv = (
        await client.post(
            f"/guilds/{g['id']}/invites", json={"max_uses": 1}, headers=auth(owner_t)
        )
    ).json()
    r1 = await client.post(f"/invites/{inv['code']}/accept", headers=auth(j1_t))
    assert r1.status_code == 200
    r2 = await client.post(f"/invites/{inv['code']}/accept", headers=auth(j2_t))
    assert r2.status_code == 404


@pytest.mark.asyncio
async def test_accept_invite_unknown_code(client, _auth_signer):
    t, _ = await _register_user(_auth_signer)
    r = await client.post("/invites/ZZZZZZZZ/accept", headers=auth(t))
    assert r.status_code == 404


# ---- revoke ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_revoke_invite_as_owner(client, _auth_signer):
    owner_t, _ = await _register_user(_auth_signer)
    joiner_t, _ = await _register_user(_auth_signer)
    g = await _make_guild(client, owner_t)
    inv = (
        await client.post(f"/guilds/{g['id']}/invites", json={}, headers=auth(owner_t))
    ).json()
    r = await client.delete(f"/invites/{inv['code']}", headers=auth(owner_t))
    assert r.status_code == 204
    # after revoke, accept fails with the same opaque 404
    r2 = await client.post(f"/invites/{inv['code']}/accept", headers=auth(joiner_t))
    assert r2.status_code == 404
    r3 = await client.get(f"/invites/{inv['code']}", headers=auth(joiner_t))
    assert r3.status_code == 404


@pytest.mark.asyncio
async def test_revoke_invite_as_creator(client, _auth_signer):
    owner_t, _ = await _register_user(_auth_signer)
    creator_t, creator_uid = await _register_user(_auth_signer)
    g = await _make_guild(client, owner_t)
    # owner adds creator as a member so they can create an invite
    await client.post(
        f"/guilds/{g['id']}/members", json={"user_id": str(creator_uid)}, headers=auth(owner_t)
    )
    inv = (
        await client.post(f"/guilds/{g['id']}/invites", json={}, headers=auth(creator_t))
    ).json()
    r = await client.delete(f"/invites/{inv['code']}", headers=auth(creator_t))
    assert r.status_code == 204


@pytest.mark.asyncio
async def test_revoke_invite_as_stranger_forbidden(client, _auth_signer):
    owner_t, _ = await _register_user(_auth_signer)
    member_t, member_uid = await _register_user(_auth_signer)
    g = await _make_guild(client, owner_t)
    await client.post(
        f"/guilds/{g['id']}/members", json={"user_id": str(member_uid)}, headers=auth(owner_t)
    )
    inv = (
        await client.post(f"/guilds/{g['id']}/invites", json={}, headers=auth(owner_t))
    ).json()
    # member is in the guild but is neither owner nor creator of this invite
    r = await client.delete(f"/invites/{inv['code']}", headers=auth(member_t))
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_revoke_invite_unknown_code(client, _auth_signer):
    t, _ = await _register_user(_auth_signer)
    r = await client.delete("/invites/ZZZZZZZZ", headers=auth(t))
    assert r.status_code == 404
