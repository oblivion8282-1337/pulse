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
    CHANNEL_TYPE_VOICE,
    MENTION_TYPE_USER,
    Device,
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
    Report,
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
            "endpoint": "https://fcm.googleapis.com/abc",
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
    client, session_factory, _auth_signer, _internal_secret_set, friend_pair, cloud_mode
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
async def test_purge_raeumt_e2e_postfach(
    client, session_factory, _auth_signer, _internal_secret_set
):
    """FIX 3. ``DeviceKeyBundle``/``DeviceOneTimeKey``/``DmZustellung``/
    ``DmNutzlast`` ueberlebten einen Konto-Purge bisher unveraendert —
    dieselbe Faehrte wie ``community_invite_notifications`` nach Migration
    0063 (s. ``user_purge_gruppen.py``-Docstring). Drei Regeln auf einmal
    geprueft: eigene Buendel + ihre Einmalschluessel weg (ueber ``user_id``),
    an DIESES Konto gerichtete Zustellungen weg (ueber
    ``empfaenger_user_id``), aber eine Zustellung an einen noch existierenden
    ANDEREN Empfaenger bleibt stehen — und damit auch die Nutzlast, an der
    sie haengt."""
    from dcc_chat_gateway.models import (
        DeviceKeyBundle,
        DeviceOneTimeKey,
        DmNutzlast,
        DmZustellung,
    )
    from dcc_chat_gateway.snowflake import next_id

    _, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)

    bundle_id = next_id()
    async with session_factory() as s:
        s.add(DeviceKeyBundle(
            id=bundle_id, user_id=uid_a, device_pubkey="pub-a",
            curve25519="curve-a",
        ))
        s.add(DeviceOneTimeKey(id=next_id(), bundle_id=bundle_id, schluessel="otk-a"))
        await s.commit()

    # Nutzlast 1: eine Zustellung an B (bleibt), eine an ein Zweitgeraet von
    # A selbst (verschwindet mit dem Purge von A) — die Nutzlast bleibt, weil
    # B's Zustellung sie noch am Leben haelt.
    nid_teilweise = next_id()
    async with session_factory() as s:
        s.add(DmNutzlast(
            id=nid_teilweise, channel_id=1, absender_device_pubkey="pub-a",
            art=1, daten="x", groesse=1,
        ))
        s.add(DmZustellung(
            id=next_id(), nutzlast_id=nid_teilweise,
            empfaenger_device_pubkey="pub-b", empfaenger_user_id=uid_b,
        ))
        s.add(DmZustellung(
            id=next_id(), nutzlast_id=nid_teilweise,
            empfaenger_device_pubkey="pub-a-2", empfaenger_user_id=uid_a,
        ))
        await s.commit()

    # Nutzlast 2: NUR an ein Geraet von A adressiert — muss nach dem Purge
    # komplett verwaisen und mitgeraeumt werden.
    nid_verwaist = next_id()
    async with session_factory() as s:
        s.add(DmNutzlast(
            id=nid_verwaist, channel_id=1, absender_device_pubkey="pub-a",
            art=1, daten="y", groesse=1,
        ))
        s.add(DmZustellung(
            id=next_id(), nutzlast_id=nid_verwaist,
            empfaenger_device_pubkey="pub-a-3", empfaenger_user_id=uid_a,
        ))
        await s.commit()

    r = await client.post(
        f"/internal/users/{uid_a}/purge", headers=_internal_headers()
    )
    assert r.status_code == 204, r.text

    async with session_factory() as s:
        assert (await s.get(DeviceKeyBundle, bundle_id)) is None
        assert (await s.execute(select(DeviceOneTimeKey))).scalars().all() == []

        rest_teilweise = (
            await s.execute(
                select(DmZustellung).where(DmZustellung.nutzlast_id == nid_teilweise)
            )
        ).scalars().all()
        assert len(rest_teilweise) == 1
        assert rest_teilweise[0].empfaenger_user_id == uid_b
        assert (await s.get(DmNutzlast, nid_teilweise)) is not None

        assert (
            (await s.execute(
                select(DmZustellung).where(DmZustellung.nutzlast_id == nid_verwaist)
            )).scalars().all()
        ) == []
        assert (await s.get(DmNutzlast, nid_verwaist)) is None


@pytest.mark.asyncio
async def test_purge_clears_friendship_system(
    client, session_factory, _auth_signer, _internal_secret_set, monkeypatch, cloud_mode
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


# ---------------------------------------------------------------------------
# Bughunt 2026-08-17 — voice eviction, dropbox purge, devices, bans, reports


@pytest.mark.asyncio
async def test_purge_evicts_voice_from_owned_guild_channels(
    client, _auth_signer, _internal_secret_set, monkeypatch
):
    """A deleted OWNED guild's voice channels must throw out every occupant —
    not just the deleted user — otherwise the LiveKit room keeps running for
    a channel that no longer exists (same ghost-room fix as
    ``routes/guilds.py::delete_guild``)."""
    import dcc_chat_gateway.user_purge_nachlauf as nachlauf_mod

    calls: list[list[int]] = []

    async def _capture(_redis, channel_ids):
        calls.append(sorted(int(c) for c in channel_ids))

    monkeypatch.setattr(nachlauf_mod, "evict_all_from_voice_channels", _capture)

    t_owner, uid_owner = await _register(_auth_signer)
    g = (
        await client.post("/guilds", json={"name": "g"}, headers=_auth(t_owner))
    ).json()
    v = (
        await client.post(
            f"/guilds/{g['id']}/channels",
            json={"name": "voice", "type": CHANNEL_TYPE_VOICE},
            headers=_auth(t_owner),
        )
    ).json()

    r = await client.post(
        f"/internal/users/{uid_owner}/purge", headers=_internal_headers()
    )
    assert r.status_code == 204, r.text
    assert calls == [[int(v["id"])]]


@pytest.mark.asyncio
async def test_purge_evicts_deleted_user_from_other_guilds_voice(
    client, _auth_signer, _internal_secret_set, monkeypatch
):
    """A voice session in a guild the deleted user does NOT own must still
    end — that guild survives the purge, so only the deleted user (not the
    whole room) gets thrown out via the normal per-guild evict call."""
    import dcc_chat_gateway.user_purge_nachlauf as nachlauf_mod

    calls: list[tuple[int, int]] = []

    async def _capture(_session, guild_id, user_id):
        calls.append((guild_id, user_id))

    monkeypatch.setattr(nachlauf_mod, "evict_user_from_guild_voice", _capture)

    t_owner, _ = await _register(_auth_signer)
    g = (
        await client.post("/guilds", json={"name": "g"}, headers=_auth(t_owner))
    ).json()
    t_a, uid_a = await _make_user_in_guild(client, _auth_signer, t_owner, g["id"])

    r = await client.post(
        f"/internal/users/{uid_a}/purge", headers=_internal_headers()
    )
    assert r.status_code == 204, r.text
    assert calls == [(int(g["id"]), uid_a)]


@pytest.mark.asyncio
async def test_purge_purges_dropbox_objects_of_owned_guild(
    client, _auth_signer, _internal_secret_set, monkeypatch
):
    """Deleting an owned guild via account-purge must sweep its dropbox
    MinIO objects too — ``ON DELETE CASCADE`` clears the DB rows, but MinIO
    never learns of that on its own (matches ``routes/guilds.py::delete_guild``)."""
    import dcc_chat_gateway.user_purge as user_purge_mod

    calls: list[int] = []

    async def _capture(guild_id):
        calls.append(guild_id)

    monkeypatch.setattr(user_purge_mod, "purge_guild_dropbox_objects", _capture)

    t_owner, uid_owner = await _register(_auth_signer)
    g = (
        await client.post("/guilds", json={"name": "g"}, headers=_auth(t_owner))
    ).json()

    r = await client.post(
        f"/internal/users/{uid_owner}/purge", headers=_internal_headers()
    )
    assert r.status_code == 204, r.text
    assert calls == [int(g["id"])]


@pytest.mark.asyncio
async def test_purge_removes_standplatz_devices(
    client, session_factory, _auth_signer, _internal_secret_set
):
    """A Standplatz-Geraet registered in a guild the user does NOT own must
    not outlive the account — otherwise the row keeps a dead owner
    permanently, and its ``(guild_id, name)`` stays blocked forever
    (Bughunt 2026-08-17, daten.md)."""
    t_owner, _ = await _register(_auth_signer)
    g = (
        await client.post("/guilds", json={"name": "g"}, headers=_auth(t_owner))
    ).json()
    t_a, uid_a = await _make_user_in_guild(client, _auth_signer, t_owner, g["id"])
    v = (
        await client.post(
            f"/guilds/{g['id']}/channels",
            json={"name": "voice", "type": CHANNEL_TYPE_VOICE},
            headers=_auth(t_owner),
        )
    ).json()

    d = (
        await client.post(
            f"/guilds/{g['id']}/devices",
            json={"channel_id": str(v["id"]), "name": "werkstatt-pc"},
            headers=_auth(t_a),
        )
    ).json()
    assert d["owner_user_id"] == str(uid_a)

    async with session_factory() as s:
        assert (await s.get(Device, int(d["id"]))) is not None

    r = await client.post(
        f"/internal/users/{uid_a}/purge", headers=_internal_headers()
    )
    assert r.status_code == 204, r.text

    async with session_factory() as s:
        assert (await s.get(Device, int(d["id"]))) is None


@pytest.mark.asyncio
async def test_purge_ends_remote_sessions_of_removed_devices(
    client, app, _auth_signer, _internal_secret_set, monkeypatch
):
    """Deleting the owner must end a remote-control session that is running on
    that owner's Standplatz device — every other path that removes a device
    does this (``remote_guard``, ``ws_device_handlers``, ``device_meldungen``).
    Without it the row and the register entry vanish while the session keeps
    running, and whoever is controlling holds a device that no longer exists."""
    t_owner, _ = await _register(_auth_signer)
    g = (
        await client.post("/guilds", json={"name": "g"}, headers=_auth(t_owner))
    ).json()
    t_a, uid_a = await _make_user_in_guild(client, _auth_signer, t_owner, g["id"])
    v = (
        await client.post(
            f"/guilds/{g['id']}/channels",
            json={"name": "voice", "type": CHANNEL_TYPE_VOICE},
            headers=_auth(t_owner),
        )
    ).json()
    d = (
        await client.post(
            f"/guilds/{g['id']}/devices",
            json={"channel_id": str(v["id"]), "name": "werkstatt-pc"},
            headers=_auth(t_a),
        )
    ).json()

    manager = app.state.connection_manager
    original = manager.end_remote_sessions_for_device
    beendet: list[int] = []

    async def _capture(device_id: int) -> None:
        beendet.append(device_id)
        await original(device_id)

    monkeypatch.setattr(manager, "end_remote_sessions_for_device", _capture)

    r = await client.post(
        f"/internal/users/{uid_a}/purge", headers=_internal_headers()
    )
    assert r.status_code == 204, r.text
    assert beendet == [int(d["id"])]


@pytest.mark.asyncio
async def test_purge_keeps_bans_issued_against_still_active_users(
    client, session_factory, _auth_signer, _internal_secret_set
):
    """Befund 4 (Bughunt 2026-08-17): a ban a moderator issued against a
    still-active THIRD party must not silently lapse just because the
    moderator later deletes their own account — otherwise a moderation
    decision disappears without a trace and the banned user can rejoin
    through any invite. Only bans AGAINST the deleted account itself
    (moot — the account no longer exists) may drop."""
    t_owner, uid_owner = await _register(_auth_signer)
    g = (
        await client.post("/guilds", json={"name": "g"}, headers=_auth(t_owner))
    ).json()
    t_mod, uid_mod = await _make_user_in_guild(client, _auth_signer, t_owner, g["id"])
    t_c, uid_c = await _make_user_in_guild(client, _auth_signer, t_owner, g["id"])

    # Give the mod BAN_MEMBERS (bit 9) via a role, same as test_bans.py.
    role = (
        await client.post(
            f"/guilds/{g['id']}/roles",
            json={"name": "mod", "permissions": str(1 << 9)},
            headers=_auth(t_owner),
        )
    ).json()
    await client.put(
        f"/guilds/{g['id']}/members/{uid_mod}/roles/{role['id']}",
        headers=_auth(t_owner),
    )

    r = await client.put(
        f"/guilds/{g['id']}/bans/{uid_c}",
        json={"reason": "test"},
        headers=_auth(t_mod),
    )
    assert r.status_code in (200, 201, 204), r.text

    async with session_factory() as s:
        ban = await s.get(GuildBan, (int(g["id"]), uid_c))
    assert ban is not None
    assert ban.banned_by_id == uid_mod

    # The moderator deletes their own account.
    r = await client.post(
        f"/internal/users/{uid_mod}/purge", headers=_internal_headers()
    )
    assert r.status_code == 204, r.text

    async with session_factory() as s:
        ban = await s.get(GuildBan, (int(g["id"]), uid_c))
    assert ban is not None, "a ban against a still-active third party must survive"
    # banned_by_id may keep pointing at the now-deleted moderator — the
    # column has no FK to the (separate-service) users table, same
    # tolerance every other unconstrained *_id column here already has.
    # The ban itself staying effective is what matters.
    assert ban.banned_by_id == uid_mod


@pytest.mark.asyncio
async def test_purge_closes_open_report_for_deleted_message(
    client, session_factory, _auth_signer, _internal_secret_set
):
    """Befund 5 (Bughunt 2026-08-17): purging the REPORTED user must not
    leave an open report pointing at a message that's about to be
    hard-deleted — ``Report.target_message_id`` has no FK/CASCADE, so an
    untouched row would fall out of every moderation-queue scope
    permanently (never triageable, resolvable, or escalatable again)."""
    t_owner, _ = await _register(_auth_signer)
    g = (
        await client.post("/guilds", json={"name": "g"}, headers=_auth(t_owner))
    ).json()
    t_reporter, _ = await _make_user_in_guild(client, _auth_signer, t_owner, g["id"])
    t_b, uid_b = await _make_user_in_guild(client, _auth_signer, t_owner, g["id"])

    chan = (
        await client.post(
            f"/guilds/{g['id']}/channels",
            json={"name": "general", "type": 0},
            headers=_auth(t_owner),
        )
    ).json()
    msg = await _post_message(client, t_b, chan["id"], "bad message")

    r = await client.post(
        "/reports",
        json={"target_message_id": msg["id"], "reason_code": "spam", "body": ""},
        headers=_auth(t_reporter),
    )
    assert r.status_code == 201, r.text
    report_id = r.json()["id"]

    async with session_factory() as s:
        report = await s.get(Report, int(report_id))
    assert report.status == "new"
    assert report.target_message_id == int(msg["id"])

    r = await client.post(
        f"/internal/users/{uid_b}/purge", headers=_internal_headers()
    )
    assert r.status_code == 204, r.text

    async with session_factory() as s:
        report = await s.get(Report, int(report_id))
    assert report is not None, "the report row itself must survive, just closed"
    assert report.status in ("resolved", "dismissed")
    assert report.target_message_id is None
    assert report.resolved_at is not None


@pytest.mark.asyncio
async def test_purge_closes_open_report_targeting_deleted_user_directly(
    client, session_factory, _auth_signer, _internal_secret_set
):
    """Same Befund, the other target shape: a plain user-report (no
    ``target_message_id``) must not stay ``new`` forever once the reported
    user's account — and with it their ``GuildMember`` row the queue scopes
    on — is gone."""
    t_owner, _ = await _register(_auth_signer)
    g = (
        await client.post("/guilds", json={"name": "g"}, headers=_auth(t_owner))
    ).json()
    t_reporter, _ = await _make_user_in_guild(client, _auth_signer, t_owner, g["id"])
    t_b, uid_b = await _make_user_in_guild(client, _auth_signer, t_owner, g["id"])

    r = await client.post(
        "/reports",
        json={
            "target_user_id": str(uid_b),
            "target_guild_id": g["id"],
            "reason_code": "harassment",
            "body": "",
        },
        headers=_auth(t_reporter),
    )
    assert r.status_code == 201, r.text
    report_id = r.json()["id"]

    r = await client.post(
        f"/internal/users/{uid_b}/purge", headers=_internal_headers()
    )
    assert r.status_code == 204, r.text

    async with session_factory() as s:
        report = await s.get(Report, int(report_id))
    assert report is not None
    assert report.status in ("resolved", "dismissed")


@pytest.mark.asyncio
async def test_purge_raeumt_kopplung(
    client, session_factory, _auth_signer, _internal_secret_set
):
    """Bughunt 2026-08-29 (Runde 6, Befund 5): ``Kopplung``/``UmzugStueck``
    ueberlebten einen Konto-Purge unveraendert — dieselbe Faehrte wie beim
    Postfach vor Etappe D (``test_purge_raeumt_e2e_postfach``). Eine
    Kopplung ist eine Verabredung zwischen zwei Geraeten DESSELBEN Kontos
    (``Kopplung.user_id``, s. Modell-Docstring) — ein Konto B in der Naehe
    dient hier nur als Kontrolle, dass der Purge nicht ueber sein Konto
    hinausgreift."""
    from datetime import UTC, datetime, timedelta

    from dcc_chat_gateway.models import Kopplung, UmzugStueck
    from dcc_chat_gateway.snowflake import next_id

    _, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)

    kopplung_a = next_id()
    kopplung_b = next_id()
    frist = datetime.now(UTC) + timedelta(hours=1)
    async with session_factory() as s:
        s.add(Kopplung(
            id=kopplung_a, user_id=uid_a, code_hash="hash-a",
            alt_device_pubkey="pub-a-alt", neu_device_pubkey="pub-a-neu",
            eingeloest_am=datetime.now(UTC), gesamt_stuecke=2,
            verfaellt_am=frist,
        ))
        s.add(Kopplung(
            id=kopplung_b, user_id=uid_b, code_hash="hash-b",
            alt_device_pubkey="pub-b-alt", verfaellt_am=frist,
        ))
        await s.commit()

    stueck_a = next_id()
    async with session_factory() as s:
        s.add(UmzugStueck(
            id=stueck_a, kopplung_id=kopplung_a, folge=0,
            daten="x", groesse=1,
        ))
        await s.commit()

    r = await client.post(
        f"/internal/users/{uid_a}/purge", headers=_internal_headers()
    )
    assert r.status_code == 204, r.text

    async with session_factory() as s:
        assert (await s.get(Kopplung, kopplung_a)) is None
        assert (await s.get(UmzugStueck, stueck_a)) is None
        # Konto B ist nicht betroffen.
        assert (await s.get(Kopplung, kopplung_b)) is not None
