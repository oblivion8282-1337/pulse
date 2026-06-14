"""Ephemeral watch-party chat reaction tests.

Covers ``PUT /channels/{cid}/watch-party/{pid}/chat/{mid}/reactions/{emoji}/@me``:
  * toggle adds then removes the caller's reaction (idempotent per call);
  * aggregate count + ``me`` flag are correct via the GET backfill;
  * a second user's reaction stacks the count without flipping the first
    user's ``me``;
  * 403 (non-member), 410 (no active party), 400 (empty emoji) error paths;
  * fan-out carries the ``watch_chat_reaction`` envelope over the per-channel
    pubsub to a subscribed WS client.
"""

from __future__ import annotations

import asyncio
import json
import os
import random

import pytest
import pytest_asyncio
from redis.asyncio import Redis
from starlette.testclient import TestClient

from .conftest import receive_skipping

_REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6380/0")


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register(_auth_signer, uid: int | None = None) -> tuple[str, int]:
    uid = uid or random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


@pytest_asyncio.fixture
async def redis() -> Redis:
    r = Redis.from_url(_REDIS_URL, decode_responses=False)
    yield r
    await r.aclose()


async def _setup_voice_channel(client, token: str) -> tuple[str, str]:
    g = (await client.post("/guilds", json={"name": "g"}, headers=_auth(token))).json()
    vc = (
        await client.post(
            f"/guilds/{g['id']}/channels",
            json={"name": "Voice", "type": 1},
            headers=_auth(token),
        )
    ).json()
    return g["id"], vc["id"]


# Fixed party id used by the seed helper. The per-channel watch key is now a
# Hash (field = party_id), and the chat / reaction keys carry the party id.
_PID = "9001"


async def _start_party(redis: Redis, channel_id: str, host_uid: int, party_id: str = _PID) -> str:
    """Seed an active watch-party state into the channel Hash so the gate
    passes. Returns the party id."""
    await redis.hset(
        f"watch:channel-{channel_id}",
        party_id,
        json.dumps(
            {
                "party_id": party_id,
                "host_user_id": str(host_uid),
                "position": 0.0,
                "is_playing": True,
            }
        ),
    )
    return party_id


async def _post_msg(client, channel_id: str, party_id: str, token: str, content: str) -> str:
    r = await client.post(
        f"/channels/{channel_id}/watch-party/{party_id}/chat",
        json={"content": content},
        headers=_auth(token),
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _react_url(cid: str, pid: str, mid: str, emoji: str) -> str:
    return f"/channels/{cid}/watch-party/{pid}/chat/{mid}/reactions/{emoji}/@me"


async def _cleanup(redis: Redis, channel_id: str, party_id: str = _PID) -> None:
    await redis.delete(
        f"watch:channel-{channel_id}",
        f"watch:chat:channel-{channel_id}-{party_id}",
        f"watch:chat:react:channel-{channel_id}-{party_id}",
    )


# --- toggle happy path -----------------------------------------------------


@pytest.mark.asyncio
async def test_toggle_adds_then_removes(client, _auth_signer, redis):
    token, uid = await _register(_auth_signer)
    _, cid = await _setup_voice_channel(client, token)
    pid = await _start_party(redis, cid, uid)
    try:
        mid = await _post_msg(client, cid, pid, token, "hi")

        # First toggle → added, count 1, me True.
        r = await client.put(_react_url(cid, pid, mid, "🔥"), headers=_auth(token))
        assert r.status_code == 200, r.text
        body = r.json()
        assert body == {"emoji": "🔥", "count": 1, "me": True}

        # Stored in the hash.
        raw = await redis.hget(f"watch:chat:react:channel-{cid}-{pid}", mid)
        assert json.loads(raw) == {"🔥": [str(uid)]}

        # Second toggle → removed, count 0, me False.
        r = await client.put(_react_url(cid, pid, mid, "🔥"), headers=_auth(token))
        assert r.status_code == 200, r.text
        assert r.json() == {"emoji": "🔥", "count": 0, "me": False}

        # Hash field pruned once empty.
        assert await redis.hget(f"watch:chat:react:channel-{cid}-{pid}", mid) is None
    finally:
        await _cleanup(redis, cid)


@pytest.mark.asyncio
async def test_get_backfill_includes_reactions(client, _auth_signer, redis):
    token, uid = await _register(_auth_signer)
    _, cid = await _setup_voice_channel(client, token)
    pid = await _start_party(redis, cid, uid)
    try:
        mid = await _post_msg(client, cid, pid, token, "react to me")
        await client.put(_react_url(cid, pid, mid, "👍"), headers=_auth(token))

        r = await client.get(
            f"/channels/{cid}/watch-party/{pid}/chat", headers=_auth(token)
        )
        assert r.status_code == 200, r.text
        msgs = r.json()
        assert len(msgs) == 1
        assert msgs[0]["id"] == mid
        assert msgs[0]["reactions"] == [{"emoji": "👍", "count": 1, "me": True}]
    finally:
        await _cleanup(redis, cid)


@pytest.mark.asyncio
async def test_two_users_stack_and_me_flag_per_user(client, _auth_signer, redis):
    owner_token, owner_uid = await _register(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=_auth(owner_token))).json()
    vc = (
        await client.post(
            f"/guilds/{g['id']}/channels",
            json={"name": "Voice", "type": 1},
            headers=_auth(owner_token),
        )
    ).json()
    cid = vc["id"]
    # Second member joins the guild.
    member_token, member_uid = await _register(_auth_signer)
    invite = (
        await client.post(
            f"/guilds/{g['id']}/invites",
            json={"channel_id": cid},
            headers=_auth(owner_token),
        )
    ).json()
    join = await client.post(
        f"/invites/{invite['code']}/accept", headers=_auth(member_token)
    )
    assert join.status_code == 200, join.text

    pid = await _start_party(redis, cid, owner_uid)
    try:
        mid = await _post_msg(client, cid, pid, owner_token, "double react")
        await client.put(_react_url(cid, pid, mid, "🎉"), headers=_auth(owner_token))
        r = await client.put(_react_url(cid, pid, mid, "🎉"), headers=_auth(member_token))
        assert r.status_code == 200, r.text
        assert r.json() == {"emoji": "🎉", "count": 2, "me": True}

        # Owner sees count 2 with me=True; member also me=True.
        owner_view = (
            await client.get(
                f"/channels/{cid}/watch-party/{pid}/chat", headers=_auth(owner_token)
            )
        ).json()
        assert owner_view[0]["reactions"] == [{"emoji": "🎉", "count": 2, "me": True}]
        member_view = (
            await client.get(
                f"/channels/{cid}/watch-party/{pid}/chat", headers=_auth(member_token)
            )
        ).json()
        assert member_view[0]["reactions"] == [{"emoji": "🎉", "count": 2, "me": True}]
    finally:
        await _cleanup(redis, cid)


# --- error paths -----------------------------------------------------------


@pytest.mark.asyncio
async def test_toggle_410_without_active_party(client, _auth_signer, redis):
    token, uid = await _register(_auth_signer)
    _, cid = await _setup_voice_channel(client, token)
    # No party seeded → 410.
    r = await client.put(_react_url(cid, _PID, "123", "🔥"), headers=_auth(token))
    assert r.status_code == 410


@pytest.mark.asyncio
async def test_toggle_403_non_member(client, _auth_signer, redis):
    owner_token, owner_uid = await _register(_auth_signer)
    outsider_token, _ = await _register(_auth_signer)
    _, cid = await _setup_voice_channel(client, owner_token)
    pid = await _start_party(redis, cid, owner_uid)
    try:
        r = await client.put(
            _react_url(cid, pid, "123", "🔥"), headers=_auth(outsider_token)
        )
        assert r.status_code == 403
    finally:
        await _cleanup(redis, cid)


@pytest.mark.asyncio
async def test_toggle_400_empty_emoji(client, _auth_signer, redis):
    token, uid = await _register(_auth_signer)
    _, cid = await _setup_voice_channel(client, token)
    pid = await _start_party(redis, cid, uid)
    try:
        # A whitespace-only emoji normalises to empty → 400.
        r = await client.put(_react_url(cid, pid, "123", "%20"), headers=_auth(token))
        assert r.status_code == 400
    finally:
        await _cleanup(redis, cid)


# --- WebSocket fan-out -----------------------------------------------------


@pytest.mark.asyncio
async def test_reaction_pushed_to_subscribed_ws(ws_app, _auth_signer):
    """POST react → chat:channel:<cid> pubsub → subscribed WS gets the
    ``watch_chat_reaction`` envelope."""

    def _run():
        with TestClient(ws_app) as tc:
            uid = random.randint(1, 1_000_000)
            token = _auth_signer.issue_access(uid, f"u{uid}")
            g = tc.post("/guilds", json={"name": "g"}, headers=_auth(token)).json()
            vc = tc.post(
                f"/guilds/{g['id']}/channels",
                json={"name": "Voice", "type": 1},
                headers=_auth(token),
            ).json()
            cid = vc["id"]
            import redis as sync_redis

            r = sync_redis.Redis.from_url(_REDIS_URL)
            pid = _PID
            try:
                r.hset(
                    f"watch:channel-{cid}",
                    pid,
                    json.dumps(
                        {"party_id": pid, "host_user_id": str(uid), "is_playing": True}
                    ),
                )
                # Seed a message to react to.
                posted = tc.post(
                    f"/channels/{cid}/watch-party/{pid}/chat",
                    json={"content": "react me"},
                    headers=_auth(token),
                )
                assert posted.status_code == 201, posted.text
                mid = posted.json()["id"]

                with tc.websocket_connect(f"/ws?token={token}") as ws:
                    receive_skipping(ws)  # skip hello + ready
                    ws.send_json({"op": "subscribe", "channel_id": cid})
                    reacted = tc.put(
                        _react_url(cid, pid, mid, "🔥"),
                        headers=_auth(token),
                    )
                    assert reacted.status_code == 200, reacted.text
                    got = ws.receive_json()
                    assert got["op"] == "watch_chat_reaction"
                    assert got["data"]["channel_id"] == cid
                    assert got["data"]["party_id"] == pid
                    assert got["data"]["message_id"] == mid
                    assert got["data"]["user_id"] == str(uid)
                    assert got["data"]["emoji"] == "🔥"
                    assert got["data"]["added"] is True
            finally:
                r.delete(
                    f"watch:channel-{cid}",
                    f"watch:chat:channel-{cid}-{pid}",
                    f"watch:chat:react:channel-{cid}-{pid}",
                )
                r.close()

    await asyncio.to_thread(_run)
