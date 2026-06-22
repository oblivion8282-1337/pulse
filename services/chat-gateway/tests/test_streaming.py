"""HQ-streaming proxy + presence tests (T5b).

Covers:
  * ``POST /channels/{id}/stream-token`` — member → proxies media-svc (mocked);
    non-member → 403; non-existent channel → 404; text channel → 400;
    media-svc down → 502.
  * ``GET /channels/{id}/whep`` — member → proxies media-svc (mocked).
  * ``GET /guilds/{id}/stream-state`` — reflects the Redis ``stream:channel:*``
    state; non-member → 403.
  * the ``stream:events`` → ``stream_state`` WebSocket broadcast (mirrors the
    voice:events test) + ``ready.stream_states``.
"""

from __future__ import annotations

import asyncio
import json
import os
import random

import dcc_chat_gateway.routes.streaming as streaming_routes
import httpx
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


@pytest.fixture
def mock_media_svc(monkeypatch):
    """Replace ``_media_svc_request`` with a recording stub. Returns a list the
    test can append fake ``httpx.Response`` objects to (FIFO) plus a `.calls`
    log of ``(method, path, bearer, json_body)`` tuples."""
    calls: list[tuple] = []
    responses: list[httpx.Response] = []

    async def _fake(method, path, *, bearer, json_body=None, http=None):
        calls.append((method, path, bearer, json_body))
        if not responses:
            raise AssertionError("no fake media-svc response queued")
        return responses.pop(0)

    monkeypatch.setattr(streaming_routes, "_media_svc_request", _fake)
    return type("MockMedia", (), {"calls": calls, "responses": responses})()


def _resp(status: int, body: dict) -> httpx.Response:
    return httpx.Response(status, json=body, request=httpx.Request("GET", "http://media-svc/x"))


async def _set_everyone_perms(client, token: str, guild_id: str, perms: int) -> None:
    """Edit @everyone in-place. Used by tests that need to strip STREAM
    from the default mask to verify the gate kicks in."""
    roles = (await client.get(f"/guilds/{guild_id}/roles", headers=_auth(token))).json()
    everyone = next(r for r in roles if r["is_everyone"])
    r = await client.patch(
        f"/guilds/{guild_id}/roles/{everyone['id']}",
        json={"permissions": str(perms)},
        headers=_auth(token),
    )
    assert r.status_code == 200, r.text


@pytest.mark.asyncio
async def test_stream_token_403_without_stream_permission(
    client, _auth_signer, mock_media_svc
):
    """A member without STREAM permission can't mint a publish token,
    even if they're in the voice channel. The backend gate is what's
    being asserted — the frontend already hides the button."""
    from dcc_shared.permissions import DEFAULT_EVERYONE_PERMISSIONS, Permissions

    t_owner, _ = await _register(_auth_signer)
    t_other, uid_other = await _register(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=_auth(t_owner))).json()
    vc = (
        await client.post(
            f"/guilds/{g['id']}/channels",
            json={"name": "Voice", "type": 1},
            headers=_auth(t_owner),
        )
    ).json()
    await client.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": str(uid_other)},
        headers=_auth(t_owner),
    )
    # Strip STREAM from @everyone.
    await _set_everyone_perms(
        client,
        t_owner,
        g["id"],
        DEFAULT_EVERYONE_PERMISSIONS & ~int(Permissions.STREAM),
    )
    r = await client.post(
        f"/channels/{vc['id']}/stream-token", json={}, headers=_auth(t_other)
    )
    assert r.status_code == 403
    # And we never bothered calling media-svc.
    assert mock_media_svc.calls == []


@pytest.mark.asyncio
async def test_stream_token_owner_bypasses_stream_permission(
    client, _auth_signer, mock_media_svc
):
    """Owners short-circuit to GRANT_ALL_SAFE even when @everyone has
    STREAM revoked — the publish gate must not lock out the owner."""
    from dcc_shared.permissions import DEFAULT_EVERYONE_PERMISSIONS, Permissions

    token, _ = await _register(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=_auth(token))).json()
    vc = (
        await client.post(
            f"/guilds/{g['id']}/channels",
            json={"name": "Voice", "type": 1},
            headers=_auth(token),
        )
    ).json()
    await _set_everyone_perms(
        client,
        token,
        g["id"],
        DEFAULT_EVERYONE_PERMISSIONS & ~int(Permissions.STREAM),
    )
    mock_media_svc.responses.append(
        _resp(
            200,
            {
                "token": "ok",
                "mediamtx_path": f"channel-{vc['id']}-1",
                "push_protocol": "rtmp",
                "push_url": "rtmps://x",
                "expires_in_s": 14400,
            },
        )
    )
    r = await client.post(
        f"/channels/{vc['id']}/stream-token", json={}, headers=_auth(token)
    )
    assert r.status_code == 200, r.text


# --- POST /channels/{id}/stream-token --------------------------------------


@pytest.mark.asyncio
async def test_stream_token_member_proxies_media_svc(client, _auth_signer, mock_media_svc):
    token, _ = await _register(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=_auth(token))).json()
    vc = (
        await client.post(
            f"/guilds/{g['id']}/channels", json={"name": "Voice", "type": 1}, headers=_auth(token)
        )
    ).json()
    mock_media_svc.responses.append(
        _resp(
            200,
            {
                "token": "tok123",
                "mediamtx_path": f"channel-{vc['id']}-1",
                "push_protocol": "rtmp",
                "push_url": f"rtmps://localhost:1936/channel-{vc['id']}-1?user=pulse&pass=tok123",
                "expires_in_s": 14400,
            },
        )
    )
    r = await client.post(f"/channels/{vc['id']}/stream-token", json={}, headers=_auth(token))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["token"] == "tok123"
    assert body["mediamtx_path"] == f"channel-{vc['id']}-1"
    assert body["push_protocol"] == "rtmp"
    # The user's bearer token was forwarded to media-svc.
    method, path, bearer, json_body = mock_media_svc.calls[0]
    assert method == "POST"
    assert path == f"/channels/{vc['id']}/stream-token"
    assert bearer == token
    assert json_body == {"protocol": "rtmp"}


@pytest.mark.asyncio
async def test_stream_token_srt_rejected_at_gateway(client, _auth_signer, mock_media_svc):
    """Regression (bug-hunt batch 2, #12): ``srt`` is rejected at the
    chat-gateway layer (422) and never forwarded to media-svc, which also
    rejects it. Previously the gateway accepted ``srt`` and forwarded it,
    producing a confusing 422 sourced from media-svc instead."""
    token, _ = await _register(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=_auth(token))).json()
    vc = (
        await client.post(
            f"/guilds/{g['id']}/channels", json={"name": "Voice", "type": 1}, headers=_auth(token)
        )
    ).json()
    r = await client.post(
        f"/channels/{vc['id']}/stream-token", json={"protocol": "srt"}, headers=_auth(token)
    )
    assert r.status_code == 422, r.text
    assert mock_media_svc.calls == []  # never reached media-svc


@pytest.mark.asyncio
async def test_stream_token_non_member_403(client, _auth_signer, mock_media_svc):
    owner, _ = await _register(_auth_signer)
    outsider, _ = await _register(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=_auth(owner))).json()
    vc = (
        await client.post(
            f"/guilds/{g['id']}/channels", json={"name": "Voice", "type": 1}, headers=_auth(owner)
        )
    ).json()
    r = await client.post(
        f"/channels/{vc['id']}/stream-token", json={}, headers=_auth(outsider)
    )
    assert r.status_code == 403
    assert mock_media_svc.calls == []  # never reached media-svc


@pytest.mark.asyncio
async def test_stream_token_unknown_channel_404(client, _auth_signer, mock_media_svc):
    token, _ = await _register(_auth_signer)
    r = await client.post("/channels/999999999/stream-token", json={}, headers=_auth(token))
    assert r.status_code == 404
    assert mock_media_svc.calls == []


@pytest.mark.asyncio
async def test_stream_token_text_channel_400(client, _auth_signer, mock_media_svc):
    token, _ = await _register(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=_auth(token))).json()
    tc = (
        await client.post(
            f"/guilds/{g['id']}/channels", json={"name": "general", "type": 0}, headers=_auth(token)
        )
    ).json()
    r = await client.post(f"/channels/{tc['id']}/stream-token", json={}, headers=_auth(token))
    assert r.status_code == 400
    assert mock_media_svc.calls == []


@pytest.mark.asyncio
async def test_stream_token_media_svc_down_502(client, _auth_signer, monkeypatch):
    token, _ = await _register(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=_auth(token))).json()
    vc = (
        await client.post(
            f"/guilds/{g['id']}/channels", json={"name": "Voice", "type": 1}, headers=_auth(token)
        )
    ).json()

    async def _boom(*a, **k):
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(streaming_routes, "_media_svc_request", _boom)
    r = await client.post(f"/channels/{vc['id']}/stream-token", json={}, headers=_auth(token))
    assert r.status_code == 502


@pytest.mark.asyncio
async def test_stream_token_media_svc_4xx_surfaced(client, _auth_signer, mock_media_svc):
    token, _ = await _register(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=_auth(token))).json()
    vc = (
        await client.post(
            f"/guilds/{g['id']}/channels", json={"name": "Voice", "type": 1}, headers=_auth(token)
        )
    ).json()
    mock_media_svc.responses.append(_resp(401, {"detail": "nope"}))
    r = await client.post(f"/channels/{vc['id']}/stream-token", json={}, headers=_auth(token))
    assert r.status_code == 401


# --- GET /channels/{id}/whep ------------------------------------------------


@pytest.mark.asyncio
async def test_whep_proxy(client, _auth_signer, mock_media_svc):
    token, _ = await _register(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=_auth(token))).json()
    vc = (
        await client.post(
            f"/guilds/{g['id']}/channels", json={"name": "Voice", "type": 1}, headers=_auth(token)
        )
    ).json()
    mock_media_svc.responses.append(
        _resp(200, {"whep_url": f"http://localhost:8889/channel-{vc['id']}-1/whep"})
    )
    r = await client.get(f"/channels/{vc['id']}/whep?user_id=1", headers=_auth(token))
    assert r.status_code == 200, r.text
    assert r.json()["whep_url"].endswith(f"channel-{vc['id']}-1/whep")
    assert mock_media_svc.calls[0][0] == "GET"


@pytest.mark.asyncio
async def test_whep_non_member_403(client, _auth_signer, mock_media_svc):
    owner, _ = await _register(_auth_signer)
    outsider, _ = await _register(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=_auth(owner))).json()
    vc = (
        await client.post(
            f"/guilds/{g['id']}/channels", json={"name": "Voice", "type": 1}, headers=_auth(owner)
        )
    ).json()
    r = await client.get(f"/channels/{vc['id']}/whep?user_id=1", headers=_auth(outsider))
    assert r.status_code == 403
    assert mock_media_svc.calls == []


# --- GET /guilds/{id}/stream-state ------------------------------------------


@pytest.mark.asyncio
async def test_guild_stream_state_reflects_redis(client, _auth_signer, redis):
    token, _ = await _register(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=_auth(token))).json()
    vc = (
        await client.post(
            f"/guilds/{g['id']}/channels", json={"name": "Voice", "type": 1}, headers=_auth(token)
        )
    ).json()
    await redis.set(
        f"stream:channel:{vc['id']}",
        json.dumps({"user_ids": ["808", "809"], "since": "2026-05-12T00:00:00+00:00"}),
    )
    try:
        r = await client.get(f"/guilds/{g['id']}/stream-state", headers=_auth(token))
        assert r.status_code == 200, r.text
        states = {s["channel_id"]: s for s in r.json()["stream_states"]}
        assert states[vc["id"]]["user_ids"] == ["808", "809"]
    finally:
        await redis.delete(f"stream:channel:{vc['id']}")


@pytest.mark.asyncio
async def test_guild_stream_state_empty_when_inactive(client, _auth_signer, redis):
    token, _ = await _register(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=_auth(token))).json()
    vc = (
        await client.post(
            f"/guilds/{g['id']}/channels", json={"name": "Voice", "type": 1}, headers=_auth(token)
        )
    ).json()
    await redis.set(f"stream:channel:{vc['id']}", json.dumps({"user_ids": []}))
    try:
        r = await client.get(f"/guilds/{g['id']}/stream-state", headers=_auth(token))
        assert r.status_code == 200
        assert r.json()["stream_states"] == []
    finally:
        await redis.delete(f"stream:channel:{vc['id']}")


@pytest.mark.asyncio
async def test_guild_stream_state_non_member_403(client, _auth_signer):
    owner, _ = await _register(_auth_signer)
    outsider, _ = await _register(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=_auth(owner))).json()
    r = await client.get(f"/guilds/{g['id']}/stream-state", headers=_auth(outsider))
    assert r.status_code == 403


# --- WebSocket: ready.stream_states + stream:events broadcast ---------------


@pytest.mark.asyncio
async def test_ready_carries_stream_states(ws_app, _auth_signer, redis):
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
            return token, vc["id"]

    token, cid = await asyncio.to_thread(_run)
    await redis.set(f"stream:channel:{cid}", json.dumps({"user_ids": ["777"]}))
    try:
        def _connect():
            with TestClient(ws_app) as tc:
                with tc.websocket_connect(f"/ws?token={token}") as ws:
                    ws.receive_json()  # hello
                    payload = ws.receive_json()  # ready
                    assert payload["op"] == "ready"
                    states = {s["channel_id"]: s for s in payload["stream_states"]}
                    assert states[cid]["user_ids"] == ["777"]

        await asyncio.to_thread(_connect)
    finally:
        await redis.delete(f"stream:channel:{cid}")


@pytest.mark.asyncio
async def test_stream_state_pushed_to_connected_client(ws_app, _auth_signer):
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
                # Simulate media-svc publishing a stream-state change.
                import redis as sync_redis

                r = sync_redis.Redis.from_url(_REDIS_URL)
                try:
                    r.publish(
                        "stream:events",
                        json.dumps({"channel_id": cid, "user_ids": [999]}),
                    )
                finally:
                    r.close()
                got = ws.receive_json()
                assert got["op"] == "stream_state"
                assert got["channel_id"] == cid
                assert got["user_ids"] == ["999"]

    await asyncio.to_thread(_run)


# --- DELETE /channels/{id}/stream (explicit stop) ---------------------------


@pytest.mark.asyncio
async def test_stop_stream_member_proxies_media_svc(client, _auth_signer, mock_media_svc):
    token, _ = await _register(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=_auth(token))).json()
    vc = (
        await client.post(
            f"/guilds/{g['id']}/channels", json={"name": "Voice", "type": 1}, headers=_auth(token)
        )
    ).json()
    mock_media_svc.responses.append(
        httpx.Response(204, request=httpx.Request("DELETE", "http://media-svc/x"))
    )
    r = await client.delete(f"/channels/{vc['id']}/stream", headers=_auth(token))
    assert r.status_code == 204, r.text
    method, path, bearer, json_body = mock_media_svc.calls[0]
    assert method == "DELETE"
    assert path == f"/channels/{vc['id']}/stream"
    assert bearer == token  # caller's bearer forwarded → media-svc stops *their* stream


@pytest.mark.asyncio
async def test_stop_stream_non_member_403(client, _auth_signer, mock_media_svc):
    owner, _ = await _register(_auth_signer)
    outsider, _ = await _register(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=_auth(owner))).json()
    vc = (
        await client.post(
            f"/guilds/{g['id']}/channels", json={"name": "Voice", "type": 1}, headers=_auth(owner)
        )
    ).json()
    r = await client.delete(f"/channels/{vc['id']}/stream", headers=_auth(outsider))
    assert r.status_code == 403
    assert mock_media_svc.calls == []  # never reached media-svc
