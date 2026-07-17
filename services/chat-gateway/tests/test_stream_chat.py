"""Per-stream live-chat tests.

Covers the new ``/channels/{cid}/streams/{uid}/chat`` POST/GET pair:
  * happy-path append + chronological backfill via REST;
  * 403 (non-member) / 400 (text channel) / 410 (no active stream) / 422
    (empty content) / 429 (rate-limit) error paths;
  * fan-out to ``chat:channel:<cid>`` carries the
    ``{"op":"stream_chat_message",...}`` envelope so subscribed WS clients
    receive it via the existing pubsub listener (no new channel).
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
from .conftest import ping_barrier, receive_skipping

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


async def _set_active(redis: Redis, channel_id: str, user_id: int) -> str:
    key = f"stream:active:channel-{channel_id}-{user_id}"
    await redis.set(key, json.dumps({"user_id": str(user_id), "path": "x"}))
    return key


async def _set_screen_share(redis: Redis, channel_id: str, user_id: int) -> str:
    """Mirror of voice-signaling's VOICE_STREAMING_KEY (browser screen-share)."""
    key = f"voice:room:channel-{channel_id}:streaming"
    await redis.sadd(key, str(user_id))
    return key


# --- POST happy path -------------------------------------------------------


@pytest.mark.asyncio
async def test_post_stream_chat_appends_and_returns_id(client, _auth_signer, redis):
    token, uid = await _register(_auth_signer)
    _, cid = await _setup_voice_channel(client, token)
    active_key = await _set_active(redis, cid, uid)
    try:
        r = await client.post(
            f"/channels/{cid}/streams/{uid}/chat",
            json={"content": "hello chat"},
            headers=_auth(token),
        )
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["id"].isdigit()
        assert body["created_at"]

        # Stored entry parses back and carries our author + content.
        raw = await redis.lrange(f"stream:chat:channel-{cid}-{uid}", 0, -1)
        assert len(raw) == 1
        entry = json.loads(raw[0])
        assert entry["author_id"] == str(uid)
        assert entry["content"] == "hello chat"
        assert entry["id"] == body["id"]
    finally:
        await redis.delete(active_key, f"stream:chat:channel-{cid}-{uid}")


# --- POST error paths ------------------------------------------------------


@pytest.mark.asyncio
async def test_post_stream_chat_410_without_active_stream(client, _auth_signer):
    token, uid = await _register(_auth_signer)
    _, cid = await _setup_voice_channel(client, token)
    r = await client.post(
        f"/channels/{cid}/streams/{uid}/chat",
        json={"content": "hi"},
        headers=_auth(token),
    )
    assert r.status_code == 410


@pytest.mark.asyncio
async def test_post_stream_chat_accepts_browser_screen_share(client, _auth_signer, redis):
    """LiveKit screen-share publishers count as 'live' even without an HQ stream."""
    token, uid = await _register(_auth_signer)
    _, cid = await _setup_voice_channel(client, token)
    ss_key = await _set_screen_share(redis, cid, uid)
    try:
        r = await client.post(
            f"/channels/{cid}/streams/{uid}/chat",
            json={"content": "hi from screen-share"},
            headers=_auth(token),
        )
        assert r.status_code == 201, r.text
        raw = await redis.lrange(f"stream:chat:channel-{cid}-{uid}", 0, -1)
        assert len(raw) == 1
        assert json.loads(raw[0])["content"] == "hi from screen-share"
    finally:
        await redis.delete(ss_key, f"stream:chat:channel-{cid}-{uid}")


@pytest.mark.asyncio
async def test_post_stream_chat_410_when_other_user_screen_shares(
    client, _auth_signer, redis
):
    """SET membership is per-user — only the matching uid unlocks the gate."""
    token, uid = await _register(_auth_signer)
    _, cid = await _setup_voice_channel(client, token)
    # Someone *else* (a different uid) is screen-sharing; the target streamer is not.
    other_uid = uid + 1
    ss_key = await _set_screen_share(redis, cid, other_uid)
    try:
        r = await client.post(
            f"/channels/{cid}/streams/{uid}/chat",
            json={"content": "should fail"},
            headers=_auth(token),
        )
        assert r.status_code == 410
    finally:
        await redis.delete(ss_key)


@pytest.mark.asyncio
async def test_post_stream_chat_accepts_hq_without_screen_share(
    client, _auth_signer, redis
):
    """Regression: HQ-only path still works after the screen-share branch was added."""
    token, uid = await _register(_auth_signer)
    _, cid = await _setup_voice_channel(client, token)
    active_key = await _set_active(redis, cid, uid)
    try:
        r = await client.post(
            f"/channels/{cid}/streams/{uid}/chat",
            json={"content": "hq only"},
            headers=_auth(token),
        )
        assert r.status_code == 201, r.text
    finally:
        await redis.delete(active_key, f"stream:chat:channel-{cid}-{uid}")


@pytest.mark.asyncio
async def test_post_stream_chat_403_non_member(client, _auth_signer, redis):
    owner_token, owner_uid = await _register(_auth_signer)
    outsider_token, _ = await _register(_auth_signer)
    _, cid = await _setup_voice_channel(client, owner_token)
    active_key = await _set_active(redis, cid, owner_uid)
    try:
        r = await client.post(
            f"/channels/{cid}/streams/{owner_uid}/chat",
            json={"content": "hi"},
            headers=_auth(outsider_token),
        )
        assert r.status_code == 403
    finally:
        await redis.delete(active_key)


@pytest.mark.asyncio
async def test_post_stream_chat_400_text_channel(client, _auth_signer, redis):
    token, uid = await _register(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=_auth(token))).json()
    tc = (
        await client.post(
            f"/guilds/{g['id']}/channels",
            json={"name": "general", "type": 0},
            headers=_auth(token),
        )
    ).json()
    # Active key even though it's a text channel — voice-channel check fires first.
    active_key = await _set_active(redis, tc["id"], uid)
    try:
        r = await client.post(
            f"/channels/{tc['id']}/streams/{uid}/chat",
            json={"content": "hi"},
            headers=_auth(token),
        )
        assert r.status_code == 400
    finally:
        await redis.delete(active_key)


@pytest.mark.asyncio
async def test_post_stream_chat_422_empty_content(client, _auth_signer, redis):
    token, uid = await _register(_auth_signer)
    _, cid = await _setup_voice_channel(client, token)
    active_key = await _set_active(redis, cid, uid)
    try:
        r = await client.post(
            f"/channels/{cid}/streams/{uid}/chat",
            json={"content": ""},
            headers=_auth(token),
        )
        assert r.status_code == 422
    finally:
        await redis.delete(active_key)


@pytest.mark.asyncio
async def test_post_stream_chat_429_rate_limit(client, _auth_signer, redis):
    token, uid = await _register(_auth_signer)
    _, cid = await _setup_voice_channel(client, token)
    active_key = await _set_active(redis, cid, uid)
    try:
        # Rule for "message" is 10/s; spend the bucket then expect 429.
        ok = 0
        for i in range(11):
            r = await client.post(
                f"/channels/{cid}/streams/{uid}/chat",
                json={"content": f"m{i}"},
                headers=_auth(token),
            )
            if r.status_code == 201:
                ok += 1
            else:
                assert r.status_code == 429
                break
        assert ok == 10
    finally:
        await redis.delete(active_key, f"stream:chat:channel-{cid}-{uid}")


# --- GET backfill ----------------------------------------------------------


@pytest.mark.asyncio
async def test_get_stream_chat_empty(client, _auth_signer):
    token, uid = await _register(_auth_signer)
    _, cid = await _setup_voice_channel(client, token)
    r = await client.get(
        f"/channels/{cid}/streams/{uid}/chat", headers=_auth(token)
    )
    assert r.status_code == 200
    assert r.json() == []


@pytest.mark.asyncio
async def test_get_stream_chat_returns_chronological(client, _auth_signer, redis):
    token, uid = await _register(_auth_signer)
    _, cid = await _setup_voice_channel(client, token)
    active_key = await _set_active(redis, cid, uid)
    try:
        contents = ["first", "second", "third"]
        for c in contents:
            r = await client.post(
                f"/channels/{cid}/streams/{uid}/chat",
                json={"content": c},
                headers=_auth(token),
            )
            assert r.status_code == 201
        r = await client.get(
            f"/channels/{cid}/streams/{uid}/chat", headers=_auth(token)
        )
        assert r.status_code == 200
        got = [m["content"] for m in r.json()]
        assert got == contents
    finally:
        await redis.delete(active_key, f"stream:chat:channel-{cid}-{uid}")


@pytest.mark.asyncio
async def test_get_stream_chat_non_member_403(client, _auth_signer, redis):
    owner_token, owner_uid = await _register(_auth_signer)
    outsider_token, _ = await _register(_auth_signer)
    _, cid = await _setup_voice_channel(client, owner_token)
    r = await client.get(
        f"/channels/{cid}/streams/{owner_uid}/chat",
        headers=_auth(outsider_token),
    )
    assert r.status_code == 403


# --- WebSocket: posted chat reaches subscribed WS client -------------------


@pytest.mark.asyncio
async def test_stream_chat_message_pushed_to_subscribed_ws(ws_app, _auth_signer):
    """End-to-end fan-out: POST → chat:channel:<cid> pubsub → subscribed WS gets it.

    Verifies the "no new pubsub channel — piggyback on chat:channel:<cid>"
    design decision: a client that's subscribed to the voice channel sees the
    stream_chat_message envelope without any extra wiring.
    """
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
            # Seed an active stream so the POST goes through.
            import redis as sync_redis

            r = sync_redis.Redis.from_url(_REDIS_URL)
            try:
                r.set(
                    f"stream:active:channel-{cid}-{uid}",
                    json.dumps({"user_id": str(uid), "path": "x"}),
                )
            finally:
                r.close()
            try:
                with tc.websocket_connect(f"/ws?token={token}") as ws:
                    receive_skipping(ws)  # skip hello + ready
                    ws.send_json({"op": "subscribe", "channel_id": cid})
                    ping_barrier(ws)  # subscribe registered before we publish
                    posted = tc.post(
                        f"/channels/{cid}/streams/{uid}/chat",
                        json={"content": "live!"},
                        headers=_auth(token),
                    )
                    assert posted.status_code == 201, posted.text
                    got = ws.receive_json()
                    assert got["op"] == "stream_chat_message"
                    assert got["channel_id"] == cid
                    assert got["streamer_id"] == str(uid)
                    assert got["message"]["content"] == "live!"
                    assert got["message"]["author_id"] == str(uid)
                    assert got["message"]["id"] == posted.json()["id"]
            finally:
                r = sync_redis.Redis.from_url(_REDIS_URL)
                try:
                    r.delete(
                        f"stream:active:channel-{cid}-{uid}",
                        f"stream:chat:channel-{cid}-{uid}",
                    )
                finally:
                    r.close()

    await asyncio.to_thread(_run)
