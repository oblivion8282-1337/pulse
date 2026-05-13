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
    # Seed voice-state + streaming keys.
    await redis.sadd(f"voice:room:channel-{cid}", "777")
    await redis.sadd(f"voice:room:channel-{cid}:streaming", "777")
    await redis.set(
        "voice:user_state:777",
        json.dumps({"mic_muted": True, "deafened": False}),
    )
    try:
        def _connect():
            with TestClient(ws_app) as tc:
                with tc.websocket_connect(f"/ws?token={token}") as ws:
                    payload = ws.receive_json()
                    assert payload["op"] == "ready"
                    states = {s["channel_id"]: s for s in payload["voice_states"]}
                    assert states[cid]["user_ids"] == ["777"]
                    assert states[cid]["streaming_user_ids"] == ["777"]
                    assert states[cid]["user_states"] == {
                        "777": {"mic_muted": True, "deafened": False}
                    }

        await asyncio.to_thread(_connect)
    finally:
        await redis.delete(f"voice:room:channel-{cid}")
        await redis.delete(f"voice:room:channel-{cid}:streaming")
        await redis.delete("voice:user_state:777")


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
                        json.dumps({
                            "channel_id": cid,
                            "user_ids": [123, 456],
                            "streaming_user_ids": [123],
                        }),
                    )
                finally:
                    r.close()
                got = ws.receive_json()
                assert got["op"] == "voice_state"
                assert got["channel_id"] == cid
                assert got["user_ids"] == ["123", "456"]
                assert got["streaming_user_ids"] == ["123"]
                # voice-signaling does not publish user_states; chat-gateway
                # enriches the envelope before broadcasting (none seeded here).
                assert got["user_states"] == {}

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_voice_self_state_op_persists_and_broadcasts(ws_app, _auth_signer, redis):
    """Client→server voice_self_state writes Redis and republishes the
    channel's snapshot so other connected clients pick up the new flags."""

    def _run():
        with TestClient(ws_app) as tc:
            owner_uid = random.randint(1, 1_000_000)
            owner_token = _auth_signer.issue_access(owner_uid, f"u{owner_uid}")
            g = tc.post(
                "/guilds", json={"name": "g"}, headers=_auth(owner_token)
            ).json()
            vc = tc.post(
                f"/guilds/{g['id']}/channels",
                json={"name": "Voice", "type": 1},
                headers=_auth(owner_token),
            ).json()
            cid = vc["id"]
            # Mark owner as present in the voice channel so the snapshot
            # includes them (the WS op itself doesn't manage presence — that
            # is voice-signaling's job via LiveKit webhooks).
            import redis as sync_redis

            r = sync_redis.Redis.from_url(_REDIS_URL)
            try:
                r.sadd(f"voice:room:channel-{cid}", str(owner_uid))
                with tc.websocket_connect(f"/ws?token={owner_token}") as ws:
                    ws.receive_json()  # ready
                    ws.send_json(
                        {
                            "op": "voice_self_state",
                            "channel_id": cid,
                            "mic_muted": True,
                            "deafened": True,
                        }
                    )
                    got = ws.receive_json()
                    assert got["op"] == "voice_state"
                    assert got["channel_id"] == cid
                    assert got["user_states"] == {
                        str(owner_uid): {"mic_muted": True, "deafened": True}
                    }
                    # Toggle back off — both flags False drops the key, the
                    # broadcast snapshot reflects the cleared state.
                    ws.send_json(
                        {
                            "op": "voice_self_state",
                            "channel_id": cid,
                            "mic_muted": False,
                            "deafened": False,
                        }
                    )
                    got = ws.receive_json()
                    assert got["op"] == "voice_state"
                    assert got["user_states"] == {}
                    assert r.exists(f"voice:user_state:{owner_uid}") == 0
            finally:
                r.delete(f"voice:room:channel-{cid}")
                r.delete(f"voice:user_state:{owner_uid}")
                r.close()

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_voice_self_state_rejects_non_voice_channel(ws_app, _auth_signer):
    """voice_self_state for a text channel must reject — voice state has no
    meaning there, and accepting it would publish a stray voice:events snapshot."""

    def _run():
        with TestClient(ws_app) as tc:
            uid = random.randint(1, 1_000_000)
            token = _auth_signer.issue_access(uid, f"u{uid}")
            g = tc.post("/guilds", json={"name": "g"}, headers=_auth(token)).json()
            tc_chan = tc.post(
                f"/guilds/{g['id']}/channels",
                json={"name": "general", "type": 0},
                headers=_auth(token),
            ).json()
            with tc.websocket_connect(f"/ws?token={token}") as ws:
                ws.receive_json()  # ready
                ws.send_json(
                    {
                        "op": "voice_self_state",
                        "channel_id": tc_chan["id"],
                        "mic_muted": True,
                        "deafened": False,
                    }
                )
                got = ws.receive_json()
                assert got["op"] == "error"
                assert got["code"] == 4004

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
    await redis.sadd(f"voice:room:channel-{cid}:streaming", "55")
    await redis.set(
        "voice:user_state:55",
        json.dumps({"mic_muted": False, "deafened": True}),
    )
    try:
        def _check():
            with TestClient(ws_app) as tc:
                r = tc.get(f"/guilds/{gid}/voice-state", headers=_auth(token))
                assert r.status_code == 200
                states = {s["channel_id"]: s for s in r.json()["voice_states"]}
                assert states[cid]["user_ids"] == ["55"]
                assert states[cid]["streaming_user_ids"] == ["55"]
                assert states[cid]["user_states"] == {
                    "55": {"mic_muted": False, "deafened": True}
                }

        await asyncio.to_thread(_check)
    finally:
        await redis.delete(f"voice:room:channel-{cid}")
        await redis.delete(f"voice:room:channel-{cid}:streaming")
        await redis.delete("voice:user_state:55")
