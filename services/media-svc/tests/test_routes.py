"""Tests for the media-svc HTTP routes."""

from __future__ import annotations

import json
import uuid

import pytest
from dcc_media_svc.streamkeys import ACTIVE_KEY, CHANNEL_STATE_KEY, TOKEN_KEY


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _unique_cid() -> str:
    return str(abs(hash(uuid.uuid4())) & ((1 << 53) - 1))


@pytest.mark.asyncio
async def test_health(client):
    r = await client.get("/health")
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_stream_token_requires_auth(client):
    r = await client.post("/channels/12345/stream-token", json={})
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_stream_token_rejects_bad_jwt(client, auth_signer):
    r = await client.post("/channels/12345/stream-token", json={}, headers=_auth("not.a.jwt"))
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_stream_token_happy_path_rtmp(client, auth_signer, redis):
    access = auth_signer.issue_access(4242, "alice")
    cid = _unique_cid()
    r = await client.post(f"/channels/{cid}/stream-token", json={}, headers=_auth(access))
    assert r.status_code == 200, r.text
    body = r.json()
    # Per-(channel, user, session-nonce) path now.
    path = body["mediamtx_path"]
    assert path.startswith(f"channel-{cid}-4242-")
    nonce = path.rsplit("-", 1)[1]
    assert len(nonce) == 32 and all(c in "0123456789abcdef" for c in nonce)
    assert body["push_protocol"] == "rtmp"
    assert body["push_url"].startswith(f"rtmps://ingest.test:1936/{path}?user=pulse&pass=")
    assert body["expires_in_s"] == 4 * 60 * 60
    token = body["token"]
    assert body["push_url"].endswith(token)
    raw = await redis.get(TOKEN_KEY.format(token=token))
    assert raw is not None
    rec = json.loads(raw.decode())
    assert rec == {
        "channel_id": cid,
        "user_id": "4242",
        "nonce": nonce,
        "scope": "publish",
        "protocol": "rtmp",
        "created_at": rec["created_at"],
    }
    assert await redis.ttl(TOKEN_KEY.format(token=token)) > 0
    await redis.delete(TOKEN_KEY.format(token=token))


@pytest.mark.asyncio
async def test_stream_token_srt_rejected(client, auth_signer):
    """SRT is disabled because UDP carries no TLS — the token would leak in cleartext."""
    access = auth_signer.issue_access(7, "bob")
    cid = _unique_cid()
    r = await client.post(
        f"/channels/{cid}/stream-token", json={"protocol": "srt"}, headers=_auth(access)
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_stream_token_rejects_bad_protocol(client, auth_signer):
    access = auth_signer.issue_access(7, "bob")
    r = await client.post("/channels/1/stream-token", json={"protocol": "hls"}, headers=_auth(access))
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_stream_token_rejects_non_numeric_channel(client, auth_signer):
    access = auth_signer.issue_access(7, "bob")
    r = await client.post("/channels/abc/stream-token", json={}, headers=_auth(access))
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_get_stream_state_empty_by_default(client, auth_signer):
    access = auth_signer.issue_access(7, "bob")
    cid = _unique_cid()
    r = await client.get(f"/channels/{cid}/stream", headers=_auth(access))
    assert r.status_code == 200
    assert r.json() == {"channel_id": cid, "user_ids": [], "since": None}


@pytest.mark.asyncio
async def test_get_stream_state_reflects_redis(client, redis, auth_signer):
    access = auth_signer.issue_access(7, "bob")
    cid = _unique_cid()
    await redis.set(
        CHANNEL_STATE_KEY.format(channel_id=cid),
        json.dumps({"user_ids": ["99", "100"], "since": "2026-05-12T00:00:00+00:00"}),
    )
    try:
        r = await client.get(f"/channels/{cid}/stream", headers=_auth(access))
        assert r.status_code == 200
        assert r.json() == {
            "channel_id": cid,
            "user_ids": ["99", "100"],
            "since": "2026-05-12T00:00:00+00:00",
        }
    finally:
        await redis.delete(CHANNEL_STATE_KEY.format(channel_id=cid))


@pytest.mark.asyncio
async def test_get_whep_url_returns_active_path(client, redis):
    cid = _unique_cid()
    path = f"channel-{cid}-42-deadbeef"
    await redis.set(
        ACTIVE_KEY.format(channel_id=cid, user_id="42"),
        json.dumps({"user_id": "42", "started_at": "2026-05-14T00:00:00+00:00", "path": path}),
    )
    try:
        r = await client.get(f"/channels/{cid}/whep?user_id=42")
        assert r.status_code == 200
        assert r.json() == {"whep_url": f"http://stream.test:8889/{path}/whep"}
    finally:
        await redis.delete(ACTIVE_KEY.format(channel_id=cid, user_id="42"))


@pytest.mark.asyncio
async def test_get_whep_url_404_when_no_active_stream(client):
    cid = _unique_cid()
    r = await client.get(f"/channels/{cid}/whep?user_id=42")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_get_whep_url_requires_user_id(client):
    cid = _unique_cid()
    r = await client.get(f"/channels/{cid}/whep")
    assert r.status_code == 422
