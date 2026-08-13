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
async def test_mod_cannot_ban_peer_mod_same_role(client, _auth_signer):
    """Discord-style hierarchy: a mod with BAN_MEMBERS cannot ban a peer
    mod with the same top role position."""
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
    r = await client.put(
        f"/guilds/{s['g']['id']}/bans/{s['uid_b']}",
        json={"reason": "mod-vs-mod"},
        headers=auth(s["t_a"]),
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_higher_mod_can_ban_roleless_member(client, _auth_signer):
    """Strictly higher top role → ban passes (target sits at the implicit
    @everyone baseline, position 0)."""
    s = await _setup(client, _auth_signer)
    mod_role = (
        await client.post(
            f"/guilds/{s['g']['id']}/roles",
            json={"name": "mod", "permissions": str(1 << 9)},  # BAN_MEMBERS
            headers=auth(s["t_owner"]),
        )
    ).json()
    await client.put(
        f"/guilds/{s['g']['id']}/members/{s['uid_a']}/roles/{mod_role['id']}",
        headers=auth(s["t_owner"]),
    )
    r = await client.put(
        f"/guilds/{s['g']['id']}/bans/{s['uid_b']}",
        json={"reason": "hierarchy-ok"},
        headers=auth(s["t_a"]),
    )
    assert r.status_code == 200


# ---------------------------------------------------------------------------
# Direct-to-user notices on ban / kick / unban (+ rejoin invite)
# ---------------------------------------------------------------------------


def _capture_user_events(app):
    """Patch the manager's publish_user_event to record (target_id, envelope)."""
    captured: list[tuple[str, object]] = []
    mgr = app.state.connection_manager

    async def _fake(target_user_id, envelope):
        captured.append((str(target_user_id), envelope))

    mgr.publish_user_event = _fake  # type: ignore[method-assign]
    return captured


@pytest.mark.asyncio
async def test_ban_notifies_banned_user_with_reason(client, app, _auth_signer):
    s = await _setup(client, _auth_signer)
    captured = _capture_user_events(app)

    r = await client.put(
        f"/guilds/{s['g']['id']}/bans/{s['uid_a']}",
        json={"reason": "spam im voice"},
        headers=auth(s["t_owner"]),
    )
    assert r.status_code == 200

    notices = [
        (t, e) for (t, e) in captured if getattr(e, "op", None) == "guild_membership_revoked"
    ]
    assert len(notices) == 1
    target, evt = notices[0]
    assert target == str(s["uid_a"])
    assert evt.kind == "ban"
    assert evt.reason == "spam im voice"
    assert evt.guild_name == "bantown"


@pytest.mark.asyncio
async def test_kick_notifies_kicked_user_without_reason(client, app, _auth_signer):
    s = await _setup(client, _auth_signer)
    captured = _capture_user_events(app)

    r = await client.request(
        "DELETE",
        f"/guilds/{s['g']['id']}/members/{s['uid_a']}",
        headers=auth(s["t_owner"]),
    )
    assert r.status_code == 204

    notices = [
        e for (t, e) in captured if getattr(e, "op", None) == "guild_membership_revoked"
    ]
    assert len(notices) == 1
    assert notices[0].kind == "kick"
    assert notices[0].reason is None


@pytest.mark.asyncio
async def test_unban_mints_rejoin_invite_and_notifies(client, app, _auth_signer):
    s = await _setup(client, _auth_signer)
    await client.put(
        f"/guilds/{s['g']['id']}/bans/{s['uid_a']}",
        json={"reason": None},
        headers=auth(s["t_owner"]),
    )
    captured = _capture_user_events(app)

    r = await client.request(
        "DELETE",
        f"/guilds/{s['g']['id']}/bans/{s['uid_a']}",
        headers=auth(s["t_owner"]),
    )
    assert r.status_code == 204

    lifted = [
        e for (t, e) in captured if getattr(e, "op", None) == "guild_ban_lifted"
    ]
    assert len(lifted) == 1
    code = lifted[0].invite_code
    assert code

    # The minted invite actually works: the unbanned user rejoins with it.
    accept = await client.post(f"/invites/{code}/accept", headers=auth(s["t_a"]))
    assert accept.status_code in (200, 201), accept.text
    members = (
        await client.get(
            f"/guilds/{s['g']['id']}/members", headers=auth(s["t_owner"])
        )
    ).json()
    assert any(m["user_id"] == str(s["uid_a"]) for m in members)


# ---------------------------------------------------------------------------
# Ban/kick send a durable PM from the acting admin (bypassing the friend-gate)
# ---------------------------------------------------------------------------


async def _dm_messages(session_factory, uid_a: int, uid_b: int):
    from dcc_chat_gateway.models import DirectMessageChannel, Message
    from sqlalchemy import select

    a, b = sorted((uid_a, uid_b))
    async with session_factory() as sess:
        dm = (
            await sess.execute(
                select(DirectMessageChannel).where(
                    DirectMessageChannel.user_a_id == a,
                    DirectMessageChannel.user_b_id == b,
                )
            )
        ).scalars().first()
        if dm is None:
            return None, []
        msgs = (
            await sess.execute(
                select(Message).where(Message.channel_id == dm.id)
            )
        ).scalars().all()
        return dm, list(msgs)


@pytest.mark.asyncio
async def test_ban_sends_dm_from_admin_without_friendship(
    client, _auth_signer, session_factory
):
    """The banned (non-friend) user gets a durable DM authored by the mod."""
    s = await _setup(client, _auth_signer)
    r = await client.put(
        f"/guilds/{s['g']['id']}/bans/{s['uid_a']}",
        json={"reason": "spam im voice"},
        headers=auth(s["t_owner"]),
    )
    assert r.status_code == 200

    _dm, msgs = await _dm_messages(session_factory, s["uid_owner"], s["uid_a"])
    assert len(msgs) == 1
    assert msgs[0].author_id == s["uid_owner"]
    assert "ausgeschlossen" in msgs[0].content
    assert "spam im voice" in msgs[0].content


@pytest.mark.asyncio
async def test_kick_sends_dm_from_admin(client, _auth_signer, session_factory):
    s = await _setup(client, _auth_signer)
    r = await client.request(
        "DELETE",
        f"/guilds/{s['g']['id']}/members/{s['uid_a']}",
        headers=auth(s["t_owner"]),
    )
    assert r.status_code == 204

    _dm, msgs = await _dm_messages(session_factory, s["uid_owner"], s["uid_a"])
    assert len(msgs) == 1
    assert msgs[0].author_id == s["uid_owner"]
    assert "entfernt" in msgs[0].content


@pytest.mark.asyncio
async def test_unban_sends_dm_with_rejoin_invite_link(
    client, _auth_signer, session_factory
):
    """The unbanned user gets a durable PM containing a /invite/<code> link
    (the client renders it as a one-click join card)."""
    s = await _setup(client, _auth_signer)
    await client.put(
        f"/guilds/{s['g']['id']}/bans/{s['uid_a']}",
        json={"reason": None},
        headers=auth(s["t_owner"]),
    )
    r = await client.request(
        "DELETE",
        f"/guilds/{s['g']['id']}/bans/{s['uid_a']}",
        headers=auth(s["t_owner"]),
    )
    assert r.status_code == 204

    _dm, msgs = await _dm_messages(session_factory, s["uid_owner"], s["uid_a"])
    rejoin = [m for m in msgs if "/invite/" in m.content and "aufgehoben" in m.content]
    assert len(rejoin) == 1
    assert rejoin[0].author_id == s["uid_owner"]
    assert "http" in rejoin[0].content


@pytest.mark.asyncio
async def test_ban_zieht_lese_token_des_streams_zurueck(client, app, _auth_signer):
    """Ende-zu-Ende: nach dem Bann darf das WHEP-Lese-Token nicht mehr gelten.

    Es ist an Kanal und Streamer gebunden, nicht an den Zuschauer, und wird
    nicht verbraucht — ohne aktives Zuruecknehmen schaut der Gebannte bis zu
    eine Stunde weiter (Bughunt 2026-08-13)."""
    from dcc_shared.streaming import read_cache_key

    s = await _setup(client, _auth_signer)
    gid = s["g"]["id"]
    kanal = (
        await client.post(
            f"/guilds/{gid}/channels",
            json={"name": "buehne", "type": 1},
            headers=auth(s["t_owner"]),
        )
    ).json()

    redis = app.state.redis
    cache = read_cache_key(str(s["uid_a"]), str(kanal["id"]), str(s["uid_owner"]), 0)
    fremd = read_cache_key(str(s["uid_b"]), str(kanal["id"]), str(s["uid_owner"]), 0)
    await redis.set(cache, "token-a")
    await redis.set("stream:token:token-a", "{}")
    await redis.set(fremd, "token-b")
    await redis.set("stream:token:token-b", "{}")
    try:
        r = await client.put(
            f"/guilds/{gid}/bans/{s['uid_a']}",
            json={"reason": "spam"},
            headers=auth(s["t_owner"]),
        )
        assert r.status_code in (200, 201, 204), r.text

        assert await redis.get(cache) is None
        assert await redis.get("stream:token:token-a") is None
        # Der andere Zuschauer schaut unveraendert weiter.
        assert await redis.get(fremd) is not None
        assert await redis.get("stream:token:token-b") is not None
    finally:
        await redis.delete(cache, fremd, "stream:token:token-a", "stream:token:token-b")
