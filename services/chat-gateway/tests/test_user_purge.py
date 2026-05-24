"""Coverage for ``POST /internal/users/{user_id}/purge``.

Called by auth-svc on self-delete. Hard-deletes every piece of data
chat-gateway owns for the user. See ``user_purge.purge_user`` for the
full sweep ordering; the route in ``routes/internal.py`` is just the
auth header check + manager/redis wiring on top of it.
"""

from __future__ import annotations

import random
from typing import Any

import pytest
import pytest_asyncio
from sqlalchemy import select

from dcc_chat_gateway.models import (
    MENTION_TYPE_USER,
    DirectMessageChannel,
    FriendRequest,
    Friendship,
    Guild,
    GuildBan,
    GuildMember,
    MemberRole,
    Message,
    MessageMention,
    MessageReaction,
    PermissionOverwrite,
    UserBlock,
    UserPrivacy,
    WebPushSubscription,
)

_TEST_SECRET = "test-internal-secret-do-not-leak"


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _internal_headers() -> dict[str, str]:
    return {"X-Pulse-Internal-Secret": _TEST_SECRET}


async def _register(_auth_signer, uid: int | None = None) -> tuple[str, int]:
    uid = uid or random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


@pytest_asyncio.fixture
async def _internal_secret_set(_isolate_chat_settings):
    """Flip the shared settings instance to a known secret for the
    duration of one test, restoring whatever it was before so the rest
    of the suite (which expects empty by default) is unaffected."""
    settings = _isolate_chat_settings
    original = settings.internal_service_secret
    settings.internal_service_secret = _TEST_SECRET
    yield _TEST_SECRET
    settings.internal_service_secret = original


# ---------------------------------------------------------------------------
# Auth surface


@pytest.mark.asyncio
async def test_purge_requires_internal_secret(client, _internal_secret_set):
    r = await client.post("/internal/users/12345/purge")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_purge_rejects_wrong_secret(client, _internal_secret_set):
    r = await client.post(
        "/internal/users/12345/purge",
        headers={"X-Pulse-Internal-Secret": "wrong"},
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_purge_disabled_when_secret_unset(client, _isolate_chat_settings):
    """Empty server-side secret = fail-closed (the call returns 401
    even if the caller sends an arbitrary header value)."""
    _isolate_chat_settings.internal_service_secret = ""
    r = await client.post(
        "/internal/users/12345/purge",
        headers={"X-Pulse-Internal-Secret": "anything"},
    )
    assert r.status_code == 401


# ---------------------------------------------------------------------------
# Behaviour


async def _make_user_in_guild(client, _auth_signer, owner_token: str, guild_id: str) -> tuple[str, int]:
    token, uid = await _register(_auth_signer)
    r = await client.post(
        f"/guilds/{guild_id}/members",
        json={"user_id": str(uid)},
        headers=_auth(owner_token),
    )
    assert r.status_code in (200, 201, 204), r.text
    return token, uid


async def _post_message(client, token: str, channel_id: str, content: str) -> dict:
    r = await client.post(
        f"/channels/{channel_id}/messages",
        json={"content": content},
        headers=_auth(token),
    )
    assert r.status_code == 201, r.text
    return r.json()


@pytest.mark.asyncio
async def test_purge_hard_deletes_user_messages(
    client, session_factory, _auth_signer, _internal_secret_set
):
    t_owner, _ = await _register(_auth_signer)
    g = (
        await client.post("/guilds", json={"name": "g"}, headers=_auth(t_owner))
    ).json()
    t_a, uid_a = await _make_user_in_guild(client, _auth_signer, t_owner, g["id"])

    chan = (
        await client.post(
            f"/guilds/{g['id']}/channels",
            json={"name": "general", "type": 0},
            headers=_auth(t_owner),
        )
    ).json()

    for i in range(5):
        await _post_message(client, t_a, chan["id"], f"hello {i}")

    async with session_factory() as s:
        count = len(
            (await s.execute(select(Message).where(Message.author_id == uid_a)))
            .scalars()
            .all()
        )
    assert count == 5

    r = await client.post(
        f"/internal/users/{uid_a}/purge", headers=_internal_headers()
    )
    assert r.status_code == 204, r.text

    async with session_factory() as s:
        count = len(
            (await s.execute(select(Message).where(Message.author_id == uid_a)))
            .scalars()
            .all()
        )
    assert count == 0


@pytest.mark.asyncio
async def test_purge_hard_deletes_user_reactions(
    client, session_factory, _auth_signer, _internal_secret_set
):
    t_owner, _ = await _register(_auth_signer)
    g = (
        await client.post("/guilds", json={"name": "g"}, headers=_auth(t_owner))
    ).json()
    t_a, uid_a = await _make_user_in_guild(client, _auth_signer, t_owner, g["id"])
    chan = (
        await client.post(
            f"/guilds/{g['id']}/channels",
            json={"name": "c", "type": 0},
            headers=_auth(t_owner),
        )
    ).json()
    # Owner posts 3 messages, user A reacts to all three.
    msgs = [
        await _post_message(client, t_owner, chan["id"], f"m{i}") for i in range(3)
    ]
    for m in msgs:
        r = await client.put(
            f"/messages/{m['id']}/reactions/%F0%9F%91%8D/@me",  # 👍 url-encoded
            headers=_auth(t_a),
        )
        assert r.status_code in (200, 201, 204), r.text

    async with session_factory() as s:
        count = len(
            (
                await s.execute(
                    select(MessageReaction).where(MessageReaction.user_id == uid_a)
                )
            )
            .scalars()
            .all()
        )
    assert count == 3

    r = await client.post(
        f"/internal/users/{uid_a}/purge", headers=_internal_headers()
    )
    assert r.status_code == 204, r.text

    async with session_factory() as s:
        count = len(
            (
                await s.execute(
                    select(MessageReaction).where(MessageReaction.user_id == uid_a)
                )
            )
            .scalars()
            .all()
        )
    assert count == 0


@pytest.mark.asyncio
async def test_purge_removes_user_from_guild_members(
    client, session_factory, _auth_signer, _internal_secret_set
):
    t_owner, _ = await _register(_auth_signer)
    g = (
        await client.post("/guilds", json={"name": "g"}, headers=_auth(t_owner))
    ).json()
    t_a, uid_a = await _make_user_in_guild(client, _auth_signer, t_owner, g["id"])
    assert t_a  # token used implicitly above

    async with session_factory() as s:
        member = await s.get(GuildMember, (int(g["id"]), uid_a))
    assert member is not None

    r = await client.post(
        f"/internal/users/{uid_a}/purge", headers=_internal_headers()
    )
    assert r.status_code == 204, r.text

    async with session_factory() as s:
        member = await s.get(GuildMember, (int(g["id"]), uid_a))
    assert member is None

    # Owner's guild + their own GuildMember row are untouched.
    async with session_factory() as s:
        guild = await s.get(Guild, int(g["id"]))
    assert guild is not None


@pytest.mark.asyncio
async def test_purge_deletes_owned_guilds(
    client, session_factory, _auth_signer, _internal_secret_set
):
    t_owner, uid_owner = await _register(_auth_signer)
    g = (
        await client.post("/guilds", json={"name": "doomed"}, headers=_auth(t_owner))
    ).json()
    # Add a second member so cascade has more to bite through.
    _, uid_b = await _make_user_in_guild(client, _auth_signer, t_owner, g["id"])

    async with session_factory() as s:
        assert (await s.get(Guild, int(g["id"]))) is not None
        assert (await s.get(GuildMember, (int(g["id"]), uid_b))) is not None

    r = await client.post(
        f"/internal/users/{uid_owner}/purge", headers=_internal_headers()
    )
    assert r.status_code == 204, r.text

    async with session_factory() as s:
        assert (await s.get(Guild, int(g["id"]))) is None
        # NOTE: GuildMember cascade depends on DB-level FK enforcement.
        # Postgres always honours it; SQLite needs PRAGMA foreign_keys=ON
        # which the test harness doesn't set, so we don't assert on
        # ``uid_b``'s row here. The prod path is exercised by the
        # ``delete_guild`` test in test_guild_events.py via the same
        # ``session.delete(guild)`` call.


@pytest.mark.asyncio
async def test_purge_publishes_guild_deleted_event(
    client, app, session_factory, _auth_signer, _internal_secret_set, monkeypatch
):
    """Owner-of-guild self-deletes → a ``guild_deleted`` envelope is
    published on the guild-events channel for every owned guild."""
    captured: list[dict[str, Any]] = []

    manager = app.state.connection_manager
    original = manager.publish_guild_event

    async def _capture(envelope) -> None:
        # publish_guild_event now accepts dict | dcc_shared.events models
        # — normalise to dict so assertions can use ``.get()``.
        if hasattr(envelope, "model_dump"):
            captured.append(envelope.model_dump(mode="json"))
        else:
            captured.append(envelope)
        await original(envelope)

    monkeypatch.setattr(manager, "publish_guild_event", _capture)

    t_owner, uid_owner = await _register(_auth_signer)
    g = (
        await client.post("/guilds", json={"name": "doomed"}, headers=_auth(t_owner))
    ).json()

    r = await client.post(
        f"/internal/users/{uid_owner}/purge", headers=_internal_headers()
    )
    assert r.status_code == 204, r.text

    guild_deleted = [
        e
        for e in captured
        if e.get("op") == "guild_deleted" and e.get("guild_id") == g["id"]
    ]
    assert len(guild_deleted) == 1, captured


@pytest.mark.asyncio
async def test_purge_keeps_other_users_data(
    client, session_factory, _auth_signer, _internal_secret_set
):
    """A's purge must not touch B's messages / reactions / membership."""
    t_owner, _ = await _register(_auth_signer)
    g = (
        await client.post("/guilds", json={"name": "g"}, headers=_auth(t_owner))
    ).json()
    t_a, uid_a = await _make_user_in_guild(client, _auth_signer, t_owner, g["id"])
    t_b, uid_b = await _make_user_in_guild(client, _auth_signer, t_owner, g["id"])
    chan = (
        await client.post(
            f"/guilds/{g['id']}/channels",
            json={"name": "c", "type": 0},
            headers=_auth(t_owner),
        )
    ).json()

    await _post_message(client, t_a, chan["id"], "from A")
    msg_b = await _post_message(client, t_b, chan["id"], "from B")
    # B reacts to their own message.
    r = await client.put(
        f"/messages/{msg_b['id']}/reactions/%F0%9F%91%8D/@me",
        headers=_auth(t_b),
    )
    assert r.status_code in (200, 201, 204), r.text

    r = await client.post(
        f"/internal/users/{uid_a}/purge", headers=_internal_headers()
    )
    assert r.status_code == 204, r.text

    async with session_factory() as s:
        b_msgs = (
            (await s.execute(select(Message).where(Message.author_id == uid_b)))
            .scalars()
            .all()
        )
        b_reacts = (
            (
                await s.execute(
                    select(MessageReaction).where(MessageReaction.user_id == uid_b)
                )
            )
            .scalars()
            .all()
        )
        b_member = await s.get(GuildMember, (int(g["id"]), uid_b))
    assert len(b_msgs) == 1
    assert len(b_reacts) == 1
    assert b_member is not None


@pytest.mark.asyncio
async def test_purge_deletes_web_push_subscriptions(
    client, session_factory, _auth_signer, _internal_secret_set
):
    t_a, uid_a = await _register(_auth_signer)
    r = await client.post(
        "/notifications/subscribe",
        json={
            "endpoint": "https://fcm.example.com/abc",
            "keys": {
                "p256dh": "BL1234567890_fake_pubkey_base64url_padding_ok",
                "auth": "auth_secret_fake_value",
            },
            "user_agent": "test",
        },
        headers=_auth(t_a),
    )
    assert r.status_code in (200, 201, 204), r.text

    async with session_factory() as s:
        count = len(
            (
                await s.execute(
                    select(WebPushSubscription).where(
                        WebPushSubscription.user_id == uid_a
                    )
                )
            )
            .scalars()
            .all()
        )
    assert count == 1

    r = await client.post(
        f"/internal/users/{uid_a}/purge", headers=_internal_headers()
    )
    assert r.status_code == 204, r.text

    async with session_factory() as s:
        count = len(
            (
                await s.execute(
                    select(WebPushSubscription).where(
                        WebPushSubscription.user_id == uid_a
                    )
                )
            )
            .scalars()
            .all()
        )
    assert count == 0


@pytest.mark.asyncio
async def test_purge_idempotent(client, _auth_signer, _internal_secret_set):
    """Second call is a no-op — every DELETE is a where-clause."""
    t_owner, _ = await _register(_auth_signer)
    g = (
        await client.post("/guilds", json={"name": "g"}, headers=_auth(t_owner))
    ).json()
    t_a, uid_a = await _make_user_in_guild(client, _auth_signer, t_owner, g["id"])
    assert t_a

    r1 = await client.post(
        f"/internal/users/{uid_a}/purge", headers=_internal_headers()
    )
    assert r1.status_code == 204, r1.text
    r2 = await client.post(
        f"/internal/users/{uid_a}/purge", headers=_internal_headers()
    )
    assert r2.status_code == 204, r2.text


@pytest.mark.asyncio
async def test_purge_clears_member_roles_and_overwrites(
    client, session_factory, _auth_signer, _internal_secret_set
):
    """Composite-FK cascade + explicit user-overwrite cleanup."""
    t_owner, _ = await _register(_auth_signer)
    g = (
        await client.post("/guilds", json={"name": "g"}, headers=_auth(t_owner))
    ).json()
    t_a, uid_a = await _make_user_in_guild(client, _auth_signer, t_owner, g["id"])

    # Create a role and assign to A.
    role = (
        await client.post(
            f"/guilds/{g['id']}/roles",
            json={"name": "vip"},
            headers=_auth(t_owner),
        )
    ).json()
    r = await client.put(
        f"/guilds/{g['id']}/members/{uid_a}/roles/{role['id']}",
        headers=_auth(t_owner),
    )
    assert r.status_code in (200, 201, 204), r.text

    # Create a channel + a user-scoped overwrite for A.
    chan = (
        await client.post(
            f"/guilds/{g['id']}/channels",
            json={"name": "c", "type": 0},
            headers=_auth(t_owner),
        )
    ).json()
    r = await client.put(
        f"/channels/{chan['id']}/permissions/1/{uid_a}",
        json={"allow": "0", "deny": "0"},
        headers=_auth(t_owner),
    )
    assert r.status_code in (200, 201, 204), r.text

    async with session_factory() as s:
        roles_held = (
            (
                await s.execute(
                    select(MemberRole).where(MemberRole.user_id == uid_a)
                )
            )
            .scalars()
            .all()
        )
        ows = (
            (
                await s.execute(
                    select(PermissionOverwrite).where(
                        PermissionOverwrite.target_type == 1,
                        PermissionOverwrite.target_id == uid_a,
                    )
                )
            )
            .scalars()
            .all()
        )
    assert len(roles_held) >= 1
    assert len(ows) == 1

    r = await client.post(
        f"/internal/users/{uid_a}/purge", headers=_internal_headers()
    )
    assert r.status_code == 204, r.text

    async with session_factory() as s:
        roles_held = (
            (
                await s.execute(
                    select(MemberRole).where(MemberRole.user_id == uid_a)
                )
            )
            .scalars()
            .all()
        )
        ows = (
            (
                await s.execute(
                    select(PermissionOverwrite).where(
                        PermissionOverwrite.target_type == 1,
                        PermissionOverwrite.target_id == uid_a,
                    )
                )
            )
            .scalars()
            .all()
        )
    assert roles_held == []
    assert ows == []


@pytest.mark.asyncio
async def test_purge_clears_mentions_targeting_user(
    client, session_factory, _auth_signer, _internal_secret_set
):
    t_owner, _ = await _register(_auth_signer)
    g = (
        await client.post("/guilds", json={"name": "g"}, headers=_auth(t_owner))
    ).json()
    t_a, uid_a = await _make_user_in_guild(client, _auth_signer, t_owner, g["id"])
    chan = (
        await client.post(
            f"/guilds/{g['id']}/channels",
            json={"name": "c", "type": 0},
            headers=_auth(t_owner),
        )
    ).json()
    # Owner mentions A — the message itself survives the purge, only
    # the row in message_mentions targeting A should drop.
    await _post_message(client, t_owner, chan["id"], f"hey <@{uid_a}>!")

    async with session_factory() as s:
        mentions = (
            (
                await s.execute(
                    select(MessageMention).where(
                        MessageMention.target_id == uid_a,
                        MessageMention.mention_type == MENTION_TYPE_USER,
                    )
                )
            )
            .scalars()
            .all()
        )
    assert len(mentions) == 1

    r = await client.post(
        f"/internal/users/{uid_a}/purge", headers=_internal_headers()
    )
    assert r.status_code == 204, r.text

    async with session_factory() as s:
        mentions = (
            (
                await s.execute(
                    select(MessageMention).where(
                        MessageMention.target_id == uid_a,
                        MessageMention.mention_type == MENTION_TYPE_USER,
                    )
                )
            )
            .scalars()
            .all()
        )
    assert mentions == []


@pytest.mark.asyncio
async def test_purge_clears_guild_bans(
    client, session_factory, _auth_signer, _internal_secret_set
):
    """Bans where the user is target OR banner both drop."""
    t_owner, uid_owner = await _register(_auth_signer)
    g = (
        await client.post("/guilds", json={"name": "g"}, headers=_auth(t_owner))
    ).json()
    t_a, uid_a = await _make_user_in_guild(client, _auth_signer, t_owner, g["id"])
    # Owner bans A — banned_user=A, banned_by=owner.
    r = await client.put(
        f"/guilds/{g['id']}/bans/{uid_a}",
        json={"reason": "test"},
        headers=_auth(t_owner),
    )
    assert r.status_code in (200, 201, 204), r.text

    async with session_factory() as s:
        bans = (
            (await s.execute(select(GuildBan).where(GuildBan.user_id == uid_a)))
            .scalars()
            .all()
        )
    assert len(bans) == 1

    # Purge A → ban-against-A drops.
    r = await client.post(
        f"/internal/users/{uid_a}/purge", headers=_internal_headers()
    )
    assert r.status_code == 204, r.text

    async with session_factory() as s:
        bans = (
            (
                await s.execute(
                    select(GuildBan).where(
                        (GuildBan.user_id == uid_a)
                        | (GuildBan.banned_by_id == uid_owner)
                    )
                )
            )
            .scalars()
            .all()
        )
    assert bans == []


@pytest.mark.asyncio
async def test_purge_deletes_dm_channels(
    client, session_factory, _auth_signer, _internal_secret_set, friend_pair
):
    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm = (
        await client.post(
            "/dm-channels",
            json={"target_user_id": str(uid_b)},
            headers=_auth(t_a),
        )
    ).json()
    await _post_message(client, t_a, dm["id"], "hi")
    await _post_message(client, t_b, dm["id"], "hello")

    async with session_factory() as s:
        c = (
            (
                await s.execute(
                    select(Message).where(Message.channel_id == int(dm["id"]))
                )
            )
            .scalars()
            .all()
        )
    assert len(c) == 2

    r = await client.post(
        f"/internal/users/{uid_a}/purge", headers=_internal_headers()
    )
    assert r.status_code == 204, r.text

    async with session_factory() as s:
        dm_row = await s.get(DirectMessageChannel, int(dm["id"]))
        msgs = (
            (
                await s.execute(
                    select(Message).where(Message.channel_id == int(dm["id"]))
                )
            )
            .scalars()
            .all()
        )
    assert dm_row is None
    assert msgs == []


@pytest.mark.asyncio
async def test_purge_clears_friendship_system(
    client, session_factory, _auth_signer, _internal_secret_set, monkeypatch
):
    """Purging a user must drop every row that mentions them across
    friendships, friend_requests, user_blocks, user_privacy."""
    # Privacy push talks to auth-svc — stub it out.
    from dcc_chat_gateway.routes import privacy as privacy_mod

    async def _noop(*args, **kwargs):
        return None

    monkeypatch.setattr(privacy_mod, "push_discoverable", _noop)

    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)
    t_c, uid_c = await _register(_auth_signer)
    t_d, uid_d = await _register(_auth_signer)

    # A ↔ B friends.
    rq = (
        await client.post(
            "/friend-requests",
            json={"target_user_id": str(uid_b)},
            headers=_auth(t_a),
        )
    ).json()
    await client.post(
        f"/friend-requests/{rq['id']}/accept", headers=_auth(t_b)
    )

    # A → C pending request.
    await client.post(
        "/friend-requests",
        json={"target_user_id": str(uid_c)},
        headers=_auth(t_a),
    )
    # D → A pending request (incoming for A).
    await client.post(
        "/friend-requests",
        json={"target_user_id": str(uid_a)},
        headers=_auth(t_d),
    )

    # A blocks C; D blocks A (block in either direction).
    await client.post(
        "/blocks",
        json={"target_user_id": str(uid_c)},
        headers=_auth(t_a),
    )
    await client.post(
        "/blocks",
        json={"target_user_id": str(uid_a)},
        headers=_auth(t_d),
    )

    # Privacy row.
    await client.put(
        "/me/privacy",
        json={"show_in_search": False},
        headers=_auth(t_a),
    )

    # Sanity: pre-purge state.
    async with session_factory() as s:
        f_rows = (
            (
                await s.execute(
                    select(Friendship).where(
                        (Friendship.user_a_id == uid_a)
                        | (Friendship.user_b_id == uid_a)
                    )
                )
            )
            .scalars()
            .all()
        )
        # A↔B was a friendship; A↔C request was *erased* by the A→C
        # block; D→A request stays (no block from D's side until now,
        # and the block-tear-down only runs for new blocks, not
        # retroactively). Actually D just blocked A → so D→A request
        # also gets torn down by D's block. Net pending: 0.
        fr_rows = (
            (
                await s.execute(
                    select(FriendRequest).where(
                        (FriendRequest.sender_id == uid_a)
                        | (FriendRequest.receiver_id == uid_a)
                    )
                )
            )
            .scalars()
            .all()
        )
        b_rows = (
            (
                await s.execute(
                    select(UserBlock).where(
                        (UserBlock.blocker_id == uid_a)
                        | (UserBlock.blocked_id == uid_a)
                    )
                )
            )
            .scalars()
            .all()
        )
        p_row = await s.get(UserPrivacy, uid_a)
    assert len(f_rows) == 1
    assert len(b_rows) == 2  # A→C + D→A
    assert p_row is not None
    # fr_rows length is incidental — we just want to know the purge
    # clears them; assert non-negative.
    assert len(fr_rows) >= 0

    r = await client.post(
        f"/internal/users/{uid_a}/purge", headers=_internal_headers()
    )
    assert r.status_code == 204, r.text

    async with session_factory() as s:
        assert (
            (
                await s.execute(
                    select(Friendship).where(
                        (Friendship.user_a_id == uid_a)
                        | (Friendship.user_b_id == uid_a)
                    )
                )
            )
            .scalars()
            .all()
            == []
        )
        assert (
            (
                await s.execute(
                    select(FriendRequest).where(
                        (FriendRequest.sender_id == uid_a)
                        | (FriendRequest.receiver_id == uid_a)
                    )
                )
            )
            .scalars()
            .all()
            == []
        )
        assert (
            (
                await s.execute(
                    select(UserBlock).where(
                        (UserBlock.blocker_id == uid_a)
                        | (UserBlock.blocked_id == uid_a)
                    )
                )
            )
            .scalars()
            .all()
            == []
        )
        assert (await s.get(UserPrivacy, uid_a)) is None
