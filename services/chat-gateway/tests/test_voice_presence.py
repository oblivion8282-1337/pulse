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
from .conftest import receive_skipping

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
                    ws.receive_json()  # hello
                    payload = ws.receive_json()  # ready
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
                receive_skipping(ws)  # skip hello + ready
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
                    receive_skipping(ws)  # skip hello + ready
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
                receive_skipping(ws)  # skip hello + ready
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


@pytest.mark.asyncio
async def test_ready_carries_voice_overrides(ws_app, _auth_signer, redis):
    """Force-mute / -deafen state persisted in voice:override:* keys
    is replayed in the ready frame so a freshly-reconnected client
    sees the admin overrides without waiting for the next event."""
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
    await redis.set(
        f"voice:override:channel-{cid}:user-555",
        json.dumps({"muted": True, "deafened": False}),
    )
    await redis.set(
        f"voice:override:channel-{cid}:user-666",
        json.dumps({"muted": False, "deafened": True}),
    )
    # Empty-override key must be skipped:
    await redis.set(
        f"voice:override:channel-{cid}:user-777",
        json.dumps({"muted": False, "deafened": False}),
    )
    try:
        def _connect():
            with TestClient(ws_app) as tc:
                with tc.websocket_connect(f"/ws?token={token}") as ws:
                    ws.receive_json()  # hello
                    payload = ws.receive_json()  # ready
                    assert payload["op"] == "ready"
                    overrides = {o["user_id"]: o for o in payload["voice_overrides"]}
                    assert "555" in overrides and overrides["555"]["muted"] is True
                    assert "666" in overrides and overrides["666"]["deafened"] is True
                    assert "777" not in overrides  # empty override skipped

        await asyncio.to_thread(_connect)
    finally:
        await redis.delete(f"voice:override:channel-{cid}:user-555")
        await redis.delete(f"voice:override:channel-{cid}:user-666")
        await redis.delete(f"voice:override:channel-{cid}:user-777")


@pytest.mark.asyncio
async def test_voice_override_event_pushed_to_connected_client(
    ws_app, _auth_signer, redis
):
    """voice-signaling publishes voice_override on voice:events; the
    chat-gateway listener should forward it as op=voice_override with
    both muted+deafened flags."""
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
                receive_skipping(ws)  # skip hello + ready
                import redis as sync_redis

                r = sync_redis.Redis.from_url(_REDIS_URL)
                try:
                    r.publish(
                        "voice:events",
                        json.dumps(
                            {
                                "op": "voice_override",
                                "channel_id": cid,
                                "user_id": "555",
                                "muted": True,
                                "deafened": False,
                            }
                        ),
                    )
                finally:
                    r.close()
                got = ws.receive_json()
                assert got == {
                    "op": "voice_override",
                    "channel_id": cid,
                    "user_id": "555",
                    "muted": True,
                    "deafened": False,
                }

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_voice_disconnect_event_pushed_to_connected_client(
    ws_app, _auth_signer, redis
):
    """voice_disconnect should hit the connected client unchanged
    (channel_id + user_id), filtered through VIEW_CHANNEL."""
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
                receive_skipping(ws)  # skip hello + ready
                import redis as sync_redis

                r = sync_redis.Redis.from_url(_REDIS_URL)
                try:
                    r.publish(
                        "voice:events",
                        json.dumps(
                            {
                                "op": "voice_disconnect",
                                "channel_id": cid,
                                "user_id": "999",
                            }
                        ),
                    )
                finally:
                    r.close()
                got = ws.receive_json()
                assert got == {
                    "op": "voice_disconnect",
                    "channel_id": cid,
                    "user_id": "999",
                }

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_ready_hides_private_voice_channel_from_denied_member(
    ws_app, _auth_signer, redis
):
    """A voice channel with VIEW_CHANNEL denied to a member must not leak into
    that member's ready frame — not its id, not its occupant list. The owner
    still sees it. Pins the security boundary of the snapshot-based
    ``filter_viewable_channels_from_snapshot`` path used by ws_ready: a bug in
    the per-guild filtering would surface here as a private channel appearing
    in the denied member's ``voice_states``.
    """
    from dcc_shared.permission_resolver import OVERWRITE_TARGET_USER
    from dcc_shared.permissions import Permissions

    def _setup():
        with TestClient(ws_app) as tc:
            owner_uid = random.randint(1, 1_000_000)
            owner_token = _auth_signer.issue_access(owner_uid, f"o{owner_uid}")
            member_uid = random.randint(1, 1_000_000)
            member_token = _auth_signer.issue_access(member_uid, f"m{member_uid}")
            g = tc.post(
                "/guilds", json={"name": "g"}, headers=_auth(owner_token)
            ).json()
            tc.post(
                f"/guilds/{g['id']}/members",
                json={"user_id": member_uid},
                headers=_auth(owner_token),
            )
            vc = tc.post(
                f"/guilds/{g['id']}/channels",
                json={"name": "Secret", "type": 1},
                headers=_auth(owner_token),
            ).json()
            # Deny VIEW_CHANNEL to the member on this voice channel.
            r = tc.put(
                f"/channels/{vc['id']}/permissions/{OVERWRITE_TARGET_USER}/{member_uid}",
                json={"allow": "0", "deny": str(int(Permissions.VIEW_CHANNEL))},
                headers=_auth(owner_token),
            )
            assert r.status_code == 200, r.text
            return owner_token, member_token, vc["id"]

    owner_token, member_token, cid = await asyncio.to_thread(_setup)
    # Occupy the channel so a viewable client would carry it in voice_states.
    await redis.sadd(f"voice:room:channel-{cid}", "777")

    def _ready(token):
        with TestClient(ws_app) as tc:
            with tc.websocket_connect(f"/ws?token={token}") as ws:
                ws.receive_json()  # hello
                payload = ws.receive_json()  # ready
                assert payload["op"] == "ready"
                return {s["channel_id"] for s in payload["voice_states"]}

    try:
        owner_states = await asyncio.to_thread(_ready, owner_token)
        member_states = await asyncio.to_thread(_ready, member_token)
        assert cid in owner_states  # owner views all → sees the occupant
        assert cid not in member_states  # denied member → channel fully hidden
    finally:
        await redis.delete(f"voice:room:channel-{cid}")
