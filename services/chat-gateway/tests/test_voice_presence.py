"""Voice-presence broadcast tests: ready.voice_states + op:voice_state push."""

from __future__ import annotations

import asyncio
import json
import os
import random

import pytest
import pytest_asyncio
from redis.asyncio import Redis
from starlette.testclient import TestClient

_REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6380/0")


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest_asyncio.fixture
async def redis() -> Redis:
    r = Redis.from_url(_REDIS_URL, decode_responses=False)
    yield r
    await r.aclose()


@pytest.mark.asyncio
async def test_ready_carries_voice_states(ws_app, _auth_signer, redis):
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
            return token, g["id"], vc["id"]

    token, gid, cid = await asyncio.to_thread(_run)
    # Seed the voice-state key.
    await redis.sadd(f"voice:room:channel-{cid}", "777")
    try:
        def _connect():
            with TestClient(ws_app) as tc:
                with tc.websocket_connect(f"/ws?token={token}") as ws:
                    payload = ws.receive_json()
                    assert payload["op"] == "ready"
                    states = {s["channel_id"]: s["user_ids"] for s in payload["voice_states"]}
                    assert states.get(cid) == ["777"]

        await asyncio.to_thread(_connect)
    finally:
        await redis.delete(f"voice:room:channel-{cid}")


@pytest.mark.asyncio
async def test_voice_state_pushed_to_connected_client(ws_app, _auth_signer, redis):
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
            with tc.websocket_connect(f"/ws?token={token}") as ws:
                ws.receive_json()  # ready
                # Simulate the voice-signaling service publishing an event.
                import redis as sync_redis

                r = sync_redis.Redis.from_url(_REDIS_URL)
                try:
                    r.publish(
                        "voice:events",
                        json.dumps({"channel_id": cid, "user_ids": [123, 456]}),
                    )
                finally:
                    r.close()
                got = ws.receive_json()
                assert got["op"] == "voice_state"
                assert got["channel_id"] == cid
                assert got["user_ids"] == ["123", "456"]

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_guild_voice_state_rest_endpoint(ws_app, _auth_signer, redis):
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
            return token, g["id"], vc["id"]

    token, gid, cid = await asyncio.to_thread(_run)
    await redis.sadd(f"voice:room:channel-{cid}", "55")
    try:
        def _check():
            with TestClient(ws_app) as tc:
                r = tc.get(f"/guilds/{gid}/voice-state", headers=_auth(token))
                assert r.status_code == 200
                states = {s["channel_id"]: s["user_ids"] for s in r.json()["voice_states"]}
                assert states.get(cid) == ["55"]

        await asyncio.to_thread(_check)
    finally:
        await redis.delete(f"voice:room:channel-{cid}")
