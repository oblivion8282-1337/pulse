"""Mentions: parser + persistence + serialization + per-user WS event.

Covers:
  * ``<@uid>`` user mention persistence + serialization (REST round-trip)
  * ``<@&rid>`` role mention, gated by ``mentionable`` and the author's
    ``MENTION_EVERYONE`` override
  * ``@everyone`` keeps the existing reject-if-not-permitted semantics
    from routes/messages.py (Z.177-182 — gate is upstream of the parser)
  * Edit replaces the row set + only newly-pinged users get a fresh
    ``mention_added`` envelope
  * Per-user WS fan-out: bob (member, separate connection, channel NOT
    subscribed) sees ``mention_added`` when alice pings him.
"""

from __future__ import annotations

import asyncio
import random

import pytest
from starlette.testclient import TestClient
from .conftest import receive_skipping


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register_user(_auth_signer, uid: int | None = None) -> tuple[str, int]:
    uid = uid or random.randint(1, 1_000_000)
    token = _auth_signer.issue_access(uid, f"user{uid}")
    return token, uid


async def _make_two_member_guild(client, _auth_signer):
    """Create a guild with owner + extra member + one text channel.

    Returns ``(t_owner, uid_owner, t_member, uid_member, guild_id, channel_id)``.
    """
    t_owner, uid_owner = await _register_user(_auth_signer)
    t_member, uid_member = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=_auth(t_owner))).json()
    await client.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": str(uid_member)},
        headers=_auth(t_owner),
    )
    c = (
        await client.post(
            f"/guilds/{g['id']}/channels",
            json={"name": "general"},
            headers=_auth(t_owner),
        )
    ).json()
    return t_owner, uid_owner, t_member, uid_member, g["id"], c["id"]


# ---- Parser unit tests (pure-function) -------------------------------------


def test_parse_markers_extracts_all_kinds():
    from dcc_chat_gateway.mentions import parse_markers
    from dcc_chat_gateway.models import (
        MENTION_EVERYONE_TARGET_ID,
        MENTION_TYPE_EVERYONE,
        MENTION_TYPE_ROLE,
        MENTION_TYPE_USER,
    )

    text = "hi <@123> and <@&456> and @everyone — also <@789>"
    out = parse_markers(text)
    assert (MENTION_TYPE_USER, 123) in out
    assert (MENTION_TYPE_USER, 789) in out
    assert (MENTION_TYPE_ROLE, 456) in out
    assert (MENTION_TYPE_EVERYONE, MENTION_EVERYONE_TARGET_ID) in out


def test_parse_markers_dedupes_and_handles_here():
    from dcc_chat_gateway.mentions import parse_markers
    from dcc_chat_gateway.models import MENTION_TYPE_EVERYONE, MENTION_TYPE_USER

    # @here folds into the same MENTION_TYPE_EVERYONE row.
    out = parse_markers("<@1> <@1> <@1> @here @everyone")
    assert sum(1 for (t, _) in out if t == MENTION_TYPE_USER) == 1
    assert sum(1 for (t, _) in out if t == MENTION_TYPE_EVERYONE) == 1


# ---- REST round-trip ------------------------------------------------------


@pytest.mark.asyncio
async def test_post_message_with_user_mention(client, _auth_signer):
    t_owner, uid_owner, _, uid_member, _, cid = await _make_two_member_guild(
        client, _auth_signer
    )
    content = f"hey <@{uid_member}> look at this"
    r = await client.post(
        f"/channels/{cid}/messages", json={"content": content}, headers=_auth(t_owner)
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert any(m["type"] == 0 and m["id"] == str(uid_member) for m in body["mentions"])
    # ids are strings over the API boundary.
    assert all(isinstance(m["id"], str) for m in body["mentions"])

    # GET /channels/{}/messages also surfaces mentions.
    listing = (await client.get(f"/channels/{cid}/messages", headers=_auth(t_owner))).json()
    fetched = next(m for m in listing if m["id"] == body["id"])
    assert any(m["type"] == 0 and m["id"] == str(uid_member) for m in fetched["mentions"])


@pytest.mark.asyncio
async def test_post_message_user_mention_drops_non_members(client, _auth_signer):
    """A <@uid> that isn't a member of this guild is silently dropped."""
    t_owner, _, _, _, _, cid = await _make_two_member_guild(client, _auth_signer)
    stranger_uid = random.randint(900_000, 999_999)
    r = await client.post(
        f"/channels/{cid}/messages",
        json={"content": f"hi <@{stranger_uid}>"},
        headers=_auth(t_owner),
    )
    assert r.status_code == 201, r.text
    assert r.json()["mentions"] == []


@pytest.mark.asyncio
async def test_post_message_with_role_mention(client, _auth_signer):
    """A mentionable role pings; a locked role only pings when the author
    holds MENTION_EVERYONE."""
    t_owner, _, t_member, uid_member, gid, cid = await _make_two_member_guild(
        client, _auth_signer
    )
    # Owner creates a mentionable role.
    role = (
        await client.post(
            f"/guilds/{gid}/roles",
            json={"name": "Friends", "mentionable": True},
            headers=_auth(t_owner),
        )
    ).json()
    # Locked role too.
    locked = (
        await client.post(
            f"/guilds/{gid}/roles",
            json={"name": "Mods", "mentionable": False},
            headers=_auth(t_owner),
        )
    ).json()

    # A regular member can ping the mentionable role.
    r = await client.post(
        f"/channels/{cid}/messages",
        json={"content": f"hi <@&{role['id']}>"},
        headers=_auth(t_member),
    )
    assert r.status_code == 201, r.text
    assert any(m["type"] == 1 and m["id"] == role["id"] for m in r.json()["mentions"])

    # The same member can NOT ping the locked role — silently dropped.
    r = await client.post(
        f"/channels/{cid}/messages",
        json={"content": f"hey <@&{locked['id']}>"},
        headers=_auth(t_member),
    )
    assert r.status_code == 201, r.text
    assert all(m["id"] != locked["id"] for m in r.json()["mentions"])

    # The owner (GRANT_ALL_SAFE incl. MENTION_EVERYONE) bypasses the
    # locked-role gate.
    r = await client.post(
        f"/channels/{cid}/messages",
        json={"content": f"hey <@&{locked['id']}>"},
        headers=_auth(t_owner),
    )
    assert r.status_code == 201, r.text
    assert any(m["type"] == 1 and m["id"] == locked["id"] for m in r.json()["mentions"])


@pytest.mark.asyncio
async def test_post_message_everyone_requires_permission(client, _auth_signer):
    """``@everyone`` without ``MENTION_EVERYONE`` is rejected with 403 by
    routes/messages.py (the existing behavior at Z.177-182). Owner has
    GRANT_ALL_SAFE so their @everyone goes through and persists."""
    t_owner, _, t_member, _, _, cid = await _make_two_member_guild(
        client, _auth_signer
    )
    # Plain member can NOT mention @everyone.
    r = await client.post(
        f"/channels/{cid}/messages",
        json={"content": "hey @everyone wake up"},
        headers=_auth(t_member),
    )
    assert r.status_code == 403, r.text
    assert "MENTION_EVERYONE" in r.json()["detail"]

    # Owner can — and the mentions array carries the everyone row (type=2).
    r = await client.post(
        f"/channels/{cid}/messages",
        json={"content": "ping @everyone"},
        headers=_auth(t_owner),
    )
    assert r.status_code == 201, r.text
    assert any(m["type"] == 2 for m in r.json()["mentions"])


@pytest.mark.asyncio
async def test_edit_message_replaces_mentions(client, _auth_signer):
    t_owner, _, _, uid_member, _, cid = await _make_two_member_guild(
        client, _auth_signer
    )
    msg = (
        await client.post(
            f"/channels/{cid}/messages",
            json={"content": f"first <@{uid_member}>"},
            headers=_auth(t_owner),
        )
    ).json()
    assert any(m["id"] == str(uid_member) for m in msg["mentions"])

    # Edit drops the mention — final array must be empty.
    r = await client.patch(
        f"/messages/{msg['id']}",
        json={"content": "edited without mention"},
        headers=_auth(t_owner),
    )
    assert r.status_code == 200, r.text
    assert r.json()["mentions"] == []


# ---- WS event tests -------------------------------------------------------


def _bootstrap_two_users(tc: TestClient, signer) -> tuple[str, int, str, int, str, str]:
    """Like the helper in test_ws.py but returns *both* tokens + uids."""
    owner_uid = random.randint(1, 1_000_000)
    member_uid = random.randint(1, 1_000_000)
    owner_token = signer.issue_access(owner_uid, f"o{owner_uid}")
    member_token = signer.issue_access(member_uid, f"m{member_uid}")
    g = tc.post("/guilds", json={"name": "g"}, headers=_auth(owner_token)).json()
    tc.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": member_uid},
        headers=_auth(owner_token),
    )
    c = tc.post(
        f"/guilds/{g['id']}/channels",
        json={"name": "general"},
        headers=_auth(owner_token),
    ).json()
    return owner_token, owner_uid, member_token, member_uid, g["id"], c["id"]


def _drain_until(ws, predicate, *, max_frames: int = 12):
    """Drain frames until ``predicate(frame)`` matches or we exceed the budget.
    Returns the matching frame or raises ``AssertionError`` if none arrived."""
    for _ in range(max_frames):
        frame = ws.receive_json()
        if predicate(frame):
            return frame
    raise AssertionError("predicate never matched")


@pytest.mark.asyncio
async def test_mention_added_ws_event(ws_app, _auth_signer):
    """Bob (member, NOT subscribed to the channel) still gets a per-user
    ``mention_added`` envelope when Alice (owner) pings him via REST."""

    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, member_token, member_uid, _, cid = _bootstrap_two_users(
                tc, _auth_signer
            )
            # Bob connects; intentionally does NOT subscribe to ``cid``.
            with tc.websocket_connect(f"/ws?token={member_token}") as ws_bob:
                ws_bob.receive_json()  # hello
                ready = ws_bob.receive_json()  # ready
                assert ready["op"] == "ready"
                # Alice POSTs a message that mentions Bob (via REST, no WS subscribe).
                r = tc.post(
                    f"/channels/{cid}/messages",
                    json={"content": f"yo <@{member_uid}>"},
                    headers=_auth(owner_token),
                )
                assert r.status_code == 201, r.text
                hit = _drain_until(ws_bob, lambda f: f.get("op") == "mention_added")
                d = hit["data"]
                assert d["channel_id"] == cid
                assert d["message_id"] == r.json()["id"]

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_mention_added_skips_self_ping(ws_app, _auth_signer):
    """Author mentioning themselves does NOT trigger a self-fired
    ``mention_added`` envelope (would double-count the counter).

    We use a two-step sequencing trick: after the self-ping POST we send
    a *second* POST that does NOT mention anyone. The author's socket
    receives one ``channel_bump`` per POST (guild:events fan-out). If a
    spurious ``mention_added`` had been emitted by the first POST it
    would arrive *before* the second POST's bump — so seeing two
    consecutive non-mention frames proves the absence.
    """

    def _run():
        with TestClient(ws_app) as tc:
            owner_token, owner_uid, _, _, _, cid = _bootstrap_two_users(
                tc, _auth_signer
            )
            with tc.websocket_connect(f"/ws?token={owner_token}") as ws_o:
                receive_skipping(ws_o)  # skip hello + ready
                r1 = tc.post(
                    f"/channels/{cid}/messages",
                    json={"content": f"self <@{owner_uid}>"},
                    headers=_auth(owner_token),
                )
                assert r1.status_code == 201
                r2 = tc.post(
                    f"/channels/{cid}/messages",
                    json={"content": "plain follow-up"},
                    headers=_auth(owner_token),
                )
                assert r2.status_code == 201
                # Expect exactly two `channel_bump` frames in order — and
                # NO `mention_added` between them.
                f1 = ws_o.receive_json()
                f2 = ws_o.receive_json()
                ops = {f1["op"], f2["op"]}
                assert "mention_added" not in ops
                assert "channel_bump" in ops

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_edit_message_only_pings_new_user(ws_app, _auth_signer):
    """An edit that adds a *new* user mention fires ``mention_added`` for
    only the new user. The original mention's user does NOT get a second
    envelope from the same edit."""

    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, member_token, member_uid, gid, cid = _bootstrap_two_users(
                tc, _auth_signer
            )
            # Add a third user; alice mentions Bob first, then edits to
            # mention Carol (Bob stays mentioned). Bob should NOT get a
            # second ``mention_added``.
            carol_uid = random.randint(1, 1_000_000)
            carol_token = _auth_signer.issue_access(carol_uid, f"c{carol_uid}")
            tc.post(
                f"/guilds/{gid}/members",
                json={"user_id": carol_uid},
                headers=_auth(owner_token),
            )
            # Pre-create the message that mentions Bob.
            first = tc.post(
                f"/channels/{cid}/messages",
                json={"content": f"yo <@{member_uid}>"},
                headers=_auth(owner_token),
            )
            assert first.status_code == 201
            msg_id = first.json()["id"]

            # Now Bob + Carol connect (after the first POST so we don't have
            # to drain Bob's initial ``mention_added``).
            with (
                tc.websocket_connect(f"/ws?token={member_token}") as ws_bob,
                tc.websocket_connect(f"/ws?token={carol_token}") as ws_carol,
            ):
                ws_bob.receive_json()
                ws_carol.receive_json()
                # Edit to ALSO mention Carol — Bob stays mentioned, so only
                # Carol should receive the per-user envelope.
                edit = tc.patch(
                    f"/messages/{msg_id}",
                    json={"content": f"yo <@{member_uid}> and <@{carol_uid}>"},
                    headers=_auth(owner_token),
                )
                assert edit.status_code == 200, edit.text

                # Carol must see a mention_added.
                hit = _drain_until(
                    ws_carol, lambda f: f.get("op") == "mention_added"
                )
                assert hit["data"]["message_id"] == msg_id

                # Bob must NOT see a fresh mention_added (he's still in the
                # set so he's not "newly" mentioned). Sequencing trick:
                # send a non-mentioning POST and assert Bob's *next* frame
                # is the bump, not a stale mention_added.
                tc.post(
                    f"/channels/{cid}/messages",
                    json={"content": "follow-up no mention"},
                    headers=_auth(owner_token),
                )
                f = ws_bob.receive_json()
                assert f["op"] != "mention_added"

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_ws_sent_message_carries_mentions(ws_app, _auth_signer):
    """A message sent over the WS ``send`` op (the default text path —
    REST POST is attachment-only) must parse + persist + serialize its
    @-mentions exactly like the REST endpoint. Regression: the WS handler
    used to skip mention parsing entirely, so ``<@uid>`` reached the
    client as a raw marker instead of a resolvable mention."""

    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, member_token, member_uid, _, cid = _bootstrap_two_users(
                tc, _auth_signer
            )
            with tc.websocket_connect(f"/ws?token={owner_token}") as ws_o:
                receive_skipping(ws_o)  # skip hello + ready
                ws_o.send_json({"op": "subscribe", "channel_id": cid})
                ws_o.send_json(
                    {
                        "op": "send",
                        "channel_id": cid,
                        "content": f"hey <@{member_uid}>",
                        "nonce": "n-mention",
                    }
                )
                # The channel broadcast carries the parsed mention array.
                frame = _drain_until(ws_o, lambda f: f.get("op") == "message")
                msg = frame["data"]
                assert {"type": 0, "id": str(member_uid)} in msg["mentions"]

                # And it was persisted — a fresh REST read re-derives the
                # same mention list from the message_mentions table.
                listing = tc.get(
                    f"/channels/{cid}/messages", headers=_auth(owner_token)
                ).json()
                hit = next(m for m in listing if m["id"] == msg["id"])
                assert {"type": 0, "id": str(member_uid)} in hit["mentions"]

    await asyncio.to_thread(_run)
