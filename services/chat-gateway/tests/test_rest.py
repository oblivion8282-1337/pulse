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
async def test_messages_after_cursor(client, _auth_signer):
    """`?after=<id>` returns only messages strictly newer than the cursor.

    Used by the WS-reconnect gap-fill path (web/src/lib/ws/connection.ts):
    on reconnect the client fetches `after=<lastSeenId>` to backfill any
    messages it missed during the disconnect, instead of wiping + reloading
    the whole channel.
    """
    t1, _ = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t1))).json()
    c = (await client.post(
        f"/guilds/{g['id']}/channels",
        json={"name": "general"},
        headers=auth(t1),
    )).json()
    ids = []
    for i in range(4):
        r = await client.post(
            f"/channels/{c['id']}/messages",
            json={"content": f"m{i}"},
            headers=auth(t1),
        )
        ids.append(r.json()["id"])

    # after=<id of m1> → expect m2 + m3 only (newest first).
    r = await client.get(
        f"/channels/{c['id']}/messages?after={ids[1]}",
        headers=auth(t1),
    )
    assert r.status_code == 200
    page = r.json()
    assert [m["id"] for m in page] == [ids[3], ids[2]]

    # after=<latest> → empty (no gap).
    r = await client.get(
        f"/channels/{c['id']}/messages?after={ids[-1]}",
        headers=auth(t1),
    )
    assert r.status_code == 200
    assert r.json() == []

    # before + after compose: half-open (after, before).
    r = await client.get(
        f"/channels/{c['id']}/messages?after={ids[0]}&before={ids[3]}",
        headers=auth(t1),
    )
    assert r.status_code == 200
    assert [m["id"] for m in r.json()] == [ids[2], ids[1]]


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
    # Empty content was a Pydantic 422 before attachments; now the rule is
    # "either text or attachments" so a route-level 400 covers both knobs.
    assert r.status_code == 400


# ---- Permission gates on message routes -----------------------------------
#
# These pin the SEND_MESSAGES / READ_HISTORY / MENTION_EVERYONE bits at the
# REST layer. Pattern: owner creates guild + channel + adds a second member,
# then applies a user-targeted channel overwrite that denies the bit under
# test. The second member then hits the endpoint and must get 403.


async def _make_owner_member_channel(client, _auth_signer):
    """Helper: owner + plain member + guild + text channel."""
    t_owner, _ = await _register_user(_auth_signer)
    t_member, uid_member = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t_owner))).json()
    c = (await client.post(
        f"/guilds/{g['id']}/channels",
        json={"name": "general"},
        headers=auth(t_owner),
    )).json()
    await client.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": str(uid_member)},
        headers=auth(t_owner),
    )
    return t_owner, t_member, uid_member, g, c


@pytest.mark.asyncio
async def test_send_message_blocked_without_send_messages(client, _auth_signer):
    """Member with a user-overwrite denying SEND_MESSAGES gets 403 on POST."""
    from dcc_shared.permission_resolver import OVERWRITE_TARGET_USER
    from dcc_shared.permissions import Permissions

    t_owner, t_member, uid_member, _, c = await _make_owner_member_channel(
        client, _auth_signer
    )
    r = await client.put(
        f"/channels/{c['id']}/permissions/{OVERWRITE_TARGET_USER}/{uid_member}",
        json={"allow": "0", "deny": str(int(Permissions.SEND_MESSAGES))},
        headers=auth(t_owner),
    )
    assert r.status_code == 200, r.text
    r = await client.post(
        f"/channels/{c['id']}/messages",
        json={"content": "hi"},
        headers=auth(t_member),
    )
    assert r.status_code == 403
    assert "SEND_MESSAGES" in r.json()["detail"]


@pytest.mark.asyncio
async def test_list_messages_blocked_without_read_history(client, _auth_signer):
    """Member with READ_HISTORY denied gets 403 on GET /channels/{}/messages."""
    from dcc_shared.permission_resolver import OVERWRITE_TARGET_USER
    from dcc_shared.permissions import Permissions

    t_owner, t_member, uid_member, _, c = await _make_owner_member_channel(
        client, _auth_signer
    )
    r = await client.put(
        f"/channels/{c['id']}/permissions/{OVERWRITE_TARGET_USER}/{uid_member}",
        json={"allow": "0", "deny": str(int(Permissions.READ_HISTORY))},
        headers=auth(t_owner),
    )
    assert r.status_code == 200, r.text
    r = await client.get(f"/channels/{c['id']}/messages", headers=auth(t_member))
    assert r.status_code == 403
    assert "READ_HISTORY" in r.json()["detail"]


@pytest.mark.asyncio
async def test_mention_everyone_blocked_without_perm(client, _auth_signer):
    """A member can SEND_MESSAGES but cannot smuggle @everyone without the
    explicit MENTION_EVERYONE bit. Owner has GRANT_ALL_SAFE so any @everyone
    by the owner is fine. We test the non-owner path."""
    t_owner, t_member, _, _, c = await _make_owner_member_channel(
        client, _auth_signer
    )
    # Plain "hi" is fine.
    r = await client.post(
        f"/channels/{c['id']}/messages",
        json={"content": "hi"},
        headers=auth(t_member),
    )
    assert r.status_code == 201, r.text
    # @everyone is blocked — default @everyone-perms don't include MENTION_EVERYONE.
    r = await client.post(
        f"/channels/{c['id']}/messages",
        json={"content": "hey @everyone wake up"},
        headers=auth(t_member),
    )
    assert r.status_code == 403
    assert "MENTION_EVERYONE" in r.json()["detail"]
    # @here is treated the same.
    r = await client.post(
        f"/channels/{c['id']}/messages",
        json={"content": "@here hi"},
        headers=auth(t_member),
    )
    assert r.status_code == 403
    # @everyonething (no word boundary) does NOT trigger the gate.
    r = await client.post(
        f"/channels/{c['id']}/messages",
        json={"content": "@everyonething"},
        headers=auth(t_member),
    )
    assert r.status_code == 201, r.text


# ---- Channel DELETE/PATCH ---------------------------------------------------


async def _setup_guild_and_channel(client, _auth_signer):
    """Helper: creates owner+guild+channel, returns (owner_token, other_token, guild, channel)."""
    t_owner, _ = await _register_user(_auth_signer)
    t_other, uid_other = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t_owner))).json()
    c = (await client.post(
        f"/guilds/{g['id']}/channels",
        json={"name": "general"},
        headers=auth(t_owner),
    )).json()
    # Add other user as member so they have access (but not ownership)
    await client.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": str(uid_other)},
        headers=auth(t_owner),
    )
    return t_owner, t_other, g, c


@pytest.mark.asyncio
async def test_delete_channel_as_owner(client, _auth_signer):
    t_owner, _, g, c = await _setup_guild_and_channel(client, _auth_signer)
    r = await client.delete(f"/channels/{c['id']}", headers=auth(t_owner))
    assert r.status_code == 204
    # Channel no longer accessible
    r2 = await client.get(f"/channels/{c['id']}", headers=auth(t_owner))
    assert r2.status_code == 404


@pytest.mark.asyncio
async def test_delete_channel_cascades_messages(client, _auth_signer, session_factory):
    """The messages.channel_id FK was dropped in 0005_direct_messages,
    so delete_channel is responsible for removing messages explicitly.
    Pin that behavior by querying the DB directly after delete."""
    from sqlalchemy import select

    from dcc_chat_gateway.models import Message

    t_owner, _, g, c = await _setup_guild_and_channel(client, _auth_signer)
    await client.post(
        f"/channels/{c['id']}/messages",
        json={"content": "bye"},
        headers=auth(t_owner),
    )
    # Sanity: the message is in the DB.
    async with session_factory() as s:
        before = (
            await s.execute(select(Message).where(Message.channel_id == int(c["id"])))
        ).scalars().all()
        assert len(before) == 1

    r = await client.delete(f"/channels/{c['id']}", headers=auth(t_owner))
    assert r.status_code == 204
    r2 = await client.get(f"/channels/{c['id']}", headers=auth(t_owner))
    assert r2.status_code == 404
    # No orphaned messages left.
    async with session_factory() as s:
        after = (
            await s.execute(select(Message).where(Message.channel_id == int(c["id"])))
        ).scalars().all()
        assert after == []


@pytest.mark.asyncio
async def test_delete_channel_non_owner_forbidden(client, _auth_signer):
    _, t_other, _, c = await _setup_guild_and_channel(client, _auth_signer)
    r = await client.delete(f"/channels/{c['id']}", headers=auth(t_other))
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_delete_channel_not_found(client, _auth_signer):
    t_owner, _, _, _ = await _setup_guild_and_channel(client, _auth_signer)
    r = await client.delete("/channels/999999999", headers=auth(t_owner))
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_patch_channel_rename(client, _auth_signer):
    t_owner, _, g, c = await _setup_guild_and_channel(client, _auth_signer)
    r = await client.patch(
        f"/channels/{c['id']}",
        json={"name": "renamed"},
        headers=auth(t_owner),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name"] == "renamed"
    assert body["id"] == c["id"]


@pytest.mark.asyncio
async def test_patch_channel_non_owner_forbidden(client, _auth_signer):
    _, t_other, _, c = await _setup_guild_and_channel(client, _auth_signer)
    r = await client.patch(
        f"/channels/{c['id']}",
        json={"name": "hacked"},
        headers=auth(t_other),
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_patch_channel_name_too_long(client, _auth_signer):
    t_owner, _, _, c = await _setup_guild_and_channel(client, _auth_signer)
    r = await client.patch(
        f"/channels/{c['id']}",
        json={"name": "x" * 65},
        headers=auth(t_owner),
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_patch_channel_topic(client, _auth_signer):
    t_owner, _, _, c = await _setup_guild_and_channel(client, _auth_signer)
    r = await client.patch(
        f"/channels/{c['id']}",
        json={"topic": "welcome channel"},
        headers=auth(t_owner),
    )
    assert r.status_code == 200
    assert r.json()["topic"] == "welcome channel"
    # name must be unchanged
    assert r.json()["name"] == "general"


# ---- Guild PATCH/DELETE ----------------------------------------------------


@pytest.mark.asyncio
async def test_patch_guild_rename(client, _auth_signer):
    t_owner, _, g, _ = await _setup_guild_and_channel(client, _auth_signer)
    r = await client.patch(f"/guilds/{g['id']}", json={"name": "Renamed"}, headers=auth(t_owner))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name"] == "Renamed"
    assert body["id"] == g["id"]


@pytest.mark.asyncio
async def test_patch_guild_attachment_limits(client, _auth_signer):
    t_owner, _, g, _ = await _setup_guild_and_channel(client, _auth_signer)
    r = await client.patch(
        f"/guilds/{g['id']}",
        json={"attachment_max_size_bytes": 5_242_880, "attachment_max_count_per_message": 3},
        headers=auth(t_owner),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["attachment_max_size_bytes"] == 5_242_880
    assert body["attachment_max_count_per_message"] == 3
    # Out-of-range values are rejected by the schema bounds.
    r2 = await client.patch(
        f"/guilds/{g['id']}",
        json={"attachment_max_count_per_message": 999},
        headers=auth(t_owner),
    )
    assert r2.status_code == 422


@pytest.mark.asyncio
async def test_patch_guild_non_owner_forbidden(client, _auth_signer):
    _, t_other, g, _ = await _setup_guild_and_channel(client, _auth_signer)
    r = await client.patch(f"/guilds/{g['id']}", json={"name": "hacked"}, headers=auth(t_other))
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_patch_guild_name_too_long(client, _auth_signer):
    t_owner, _, g, _ = await _setup_guild_and_channel(client, _auth_signer)
    r = await client.patch(f"/guilds/{g['id']}", json={"name": "x" * 65}, headers=auth(t_owner))
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_patch_guild_not_found(client, _auth_signer):
    t_owner, _, _, _ = await _setup_guild_and_channel(client, _auth_signer)
    r = await client.patch("/guilds/999999999", json={"name": "x"}, headers=auth(t_owner))
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_delete_guild_as_owner(client, _auth_signer, session_factory):
    """Owner can delete the guild. Channel cascade (ON DELETE CASCADE) is
    asserted only indirectly via getGuild; SQLite in tests doesn't enforce
    FKs by default — Postgres in prod does. Messages have NO channel_id FK
    (Migration 0005) so they must be deleted explicitly — assert that here."""
    from sqlalchemy import select

    from dcc_chat_gateway.models import Message

    t_owner, _, g, c = await _setup_guild_and_channel(client, _auth_signer)
    await client.post(
        f"/channels/{c['id']}/messages", json={"content": "bye"}, headers=auth(t_owner)
    )
    r = await client.delete(f"/guilds/{g['id']}", headers=auth(t_owner))
    assert r.status_code == 204
    # Guild gone — listGuilds no longer returns it for the owner, and getGuild
    # 403s because the member row is also gone.
    r2 = await client.get("/guilds", headers=auth(t_owner))
    assert all(gg["id"] != g["id"] for gg in r2.json())
    r3 = await client.get(f"/guilds/{g['id']}", headers=auth(t_owner))
    assert r3.status_code in (403, 404)
    # Message rows for the guild's channel are gone, not orphaned.
    async with session_factory() as s:
        remaining = (
            await s.execute(select(Message).where(Message.channel_id == int(c["id"])))
        ).scalars().all()
    assert remaining == []


@pytest.mark.asyncio
async def test_delete_guild_non_owner_forbidden(client, _auth_signer):
    _, t_other, g, _ = await _setup_guild_and_channel(client, _auth_signer)
    r = await client.delete(f"/guilds/{g['id']}", headers=auth(t_other))
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_delete_guild_not_found(client, _auth_signer):
    t_owner, _, _, _ = await _setup_guild_and_channel(client, _auth_signer)
    r = await client.delete("/guilds/999999999", headers=auth(t_owner))
    assert r.status_code == 404
