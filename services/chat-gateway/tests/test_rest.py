"""REST-level tests for the chat-gateway."""

from __future__ import annotations

import pytest


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register_user(_auth_signer, uid: int | None = None) -> tuple[str, int]:
    import random

    uid = uid or random.randint(1, 1_000_000)
    token = _auth_signer.issue_access(uid, f"user{uid}")
    return token, uid


@pytest.mark.asyncio
async def test_health(client):
    r = await client.get("/health")
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_create_guild_requires_auth(client):
    r = await client.post("/guilds", json={"name": "x"})
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_create_guild(client, _auth_signer):
    token, _ = await _register_user(_auth_signer)
    r = await client.post("/guilds", json={"name": "G1"}, headers=auth(token))
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["name"] == "G1"
    assert isinstance(body["id"], str)


@pytest.mark.asyncio
async def test_list_guilds_only_returns_member(client, _auth_signer):
    t1, uid1 = await _register_user(_auth_signer)
    t2, uid2 = await _register_user(_auth_signer)

    g1 = (await client.post("/guilds", json={"name": "g1"}, headers=auth(t1))).json()
    _ = (await client.post("/guilds", json={"name": "g2"}, headers=auth(t2))).json()

    r1 = await client.get("/guilds", headers=auth(t1))
    assert {g["id"] for g in r1.json()} == {g1["id"]}


@pytest.mark.asyncio
async def test_create_channel_requires_owner(client, _auth_signer):
    t1, _ = await _register_user(_auth_signer)
    t2, uid2 = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t1))).json()
    # add the second user as a member, but they are not owner
    await client.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": uid2},
        headers=auth(t1),
    )
    r = await client.post(
        f"/guilds/{g['id']}/channels",
        json={"name": "general"},
        headers=auth(t2),
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_create_and_list_channels(client, _auth_signer):
    t1, _ = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t1))).json()
    c = (await client.post(
        f"/guilds/{g['id']}/channels",
        json={"name": "general"},
        headers=auth(t1),
    )).json()
    assert c["name"] == "general"
    listing = (await client.get(f"/guilds/{g['id']}/channels", headers=auth(t1))).json()
    assert any(ch["id"] == c["id"] for ch in listing)


@pytest.mark.asyncio
async def test_non_member_cant_list_channels(client, _auth_signer):
    t1, _ = await _register_user(_auth_signer)
    t2, _ = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t1))).json()
    r = await client.get(f"/guilds/{g['id']}/channels", headers=auth(t2))
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_post_and_list_messages(client, _auth_signer):
    t1, _ = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t1))).json()
    c = (await client.post(
        f"/guilds/{g['id']}/channels",
        json={"name": "general"},
        headers=auth(t1),
    )).json()

    for i in range(3):
        r = await client.post(
            f"/channels/{c['id']}/messages",
            json={"content": f"hi {i}", "nonce": f"n{i}"},
            headers=auth(t1),
        )
        assert r.status_code == 201, r.text

    r = await client.get(f"/channels/{c['id']}/messages?limit=10", headers=auth(t1))
    assert r.status_code == 200
    msgs = r.json()
    assert len(msgs) == 3
    # Newest first (descending id)
    assert msgs[0]["content"] == "hi 2"


@pytest.mark.asyncio
async def test_messages_paginated(client, _auth_signer):
    t1, _ = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t1))).json()
    c = (await client.post(
        f"/guilds/{g['id']}/channels",
        json={"name": "general"},
        headers=auth(t1),
    )).json()
    ids = []
    for i in range(5):
        r = await client.post(
            f"/channels/{c['id']}/messages",
            json={"content": f"m{i}"},
            headers=auth(t1),
        )
        ids.append(r.json()["id"])

    second_page = await client.get(
        f"/channels/{c['id']}/messages?limit=2&before={ids[-1]}",
        headers=auth(t1),
    )
    page = second_page.json()
    assert len(page) == 2
    assert page[0]["id"] == ids[-2]


@pytest.mark.asyncio
async def test_non_member_cannot_post(client, _auth_signer):
    t1, _ = await _register_user(_auth_signer)
    t2, _ = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t1))).json()
    c = (await client.post(
        f"/guilds/{g['id']}/channels",
        json={"name": "general"},
        headers=auth(t1),
    )).json()
    r = await client.post(
        f"/channels/{c['id']}/messages",
        json={"content": "snoop"},
        headers=auth(t2),
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_invalid_token_rejected(client):
    r = await client.get("/guilds", headers={"Authorization": "Bearer bogus"})
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_self_add_to_guild_forbidden(client, _auth_signer):
    # Audit #1: a user must not be able to add *themselves* to an arbitrary
    # guild (guild IDs are enumerable -> IDOR over all channels/messages).
    owner_t, _ = await _register_user(_auth_signer)
    intruder_t, intruder_uid = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(owner_t))).json()
    r = await client.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": str(intruder_uid)},
        headers=auth(intruder_t),  # intruder tries to add themselves
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_owner_can_add_member(client, _auth_signer):
    owner_t, _ = await _register_user(_auth_signer)
    _, member_uid = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(owner_t))).json()
    r = await client.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": str(member_uid)},
        headers=auth(owner_t),
    )
    assert r.status_code == 201, r.text


@pytest.mark.asyncio
async def test_message_rate_limit(client, _auth_signer):
    # Audit #10: chat-gateway must throttle message posts. Limit is 10/s.
    t, _ = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t))).json()
    c = (await client.post(
        f"/guilds/{g['id']}/channels", json={"name": "general"}, headers=auth(t)
    )).json()
    statuses = []
    for i in range(15):
        r = await client.post(
            f"/channels/{c['id']}/messages", json={"content": f"m{i}"}, headers=auth(t)
        )
        statuses.append(r.status_code)
    assert 201 in statuses
    assert 429 in statuses


@pytest.mark.asyncio
async def test_post_empty_message_rejected(client, _auth_signer):
    t1, _ = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t1))).json()
    c = (await client.post(
        f"/guilds/{g['id']}/channels",
        json={"name": "general"},
        headers=auth(t1),
    )).json()
    r = await client.post(
        f"/channels/{c['id']}/messages",
        json={"content": ""},
        headers=auth(t1),
    )
    assert r.status_code == 422
