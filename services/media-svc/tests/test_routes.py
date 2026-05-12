"""Tests for the media-svc HTTP routes."""

from __future__ import annotations

import json
import uuid

import pytest
from dcc_media_svc.streamkeys import CHANNEL_STATE_KEY, TOKEN_KEY


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
    # Per-(channel, user) path now.
    assert body["mediamtx_path"] == f"channel-{cid}-4242"
    assert body["push_protocol"] == "rtmp"
    assert body["push_url"].startswith(
        f"rtmps://ingest.test:1936/channel-{cid}-4242?user=pulse&pass="
    )
    assert body["expires_in_s"] == 4 * 60 * 60
    token = body["token"]
    assert body["push_url"].endswith(token)
    raw = await redis.get(TOKEN_KEY.format(token=token))
    assert raw is not None
    rec = json.loads(raw.decode())
    assert rec == {
        "channel_id": cid,
        "user_id": "4242",
        "scope": "publish",
        "protocol": "rtmp",
        "created_at": rec["created_at"],
    }
    assert await redis.ttl(TOKEN_KEY.format(token=token)) > 0
    await redis.delete(TOKEN_KEY.format(token=token))


@pytest.mark.asyncio
async def test_stream_token_srt_protocol(client, auth_signer, redis):
    access = auth_signer.issue_access(7, "bob")
    cid = _unique_cid()
    r = await client.post(
        f"/channels/{cid}/stream-token", json={"protocol": "srt"}, headers=_auth(access)
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["push_protocol"] == "srt"
    assert body["push_url"].startswith(
        f"srt://ingest.test:8890?streamid=publish:channel-{cid}-7:pulse:"
    )
    await redis.delete(TOKEN_KEY.format(token=body["token"]))


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
async def test_get_stream_state_empty_by_default(client):
    cid = _unique_cid()
    r = await client.get(f"/channels/{cid}/stream")
    assert r.status_code == 200
    assert r.json() == {"channel_id": cid, "user_ids": [], "since": None}


@pytest.mark.asyncio
async def test_get_stream_state_reflects_redis(client, redis):
    cid = _unique_cid()
    await redis.set(
        CHANNEL_STATE_KEY.format(channel_id=cid),
        json.dumps({"user_ids": ["99", "100"], "since": "2026-05-12T00:00:00+00:00"}),
    )
    try:
        r = await client.get(f"/channels/{cid}/stream")
        assert r.status_code == 200
        assert r.json() == {
            "channel_id": cid,
            "user_ids": ["99", "100"],
            "since": "2026-05-12T00:00:00+00:00",
        }
    finally:
        await redis.delete(CHANNEL_STATE_KEY.format(channel_id=cid))


@pytest.mark.asyncio
async def test_get_whep_url(client):
    cid = _unique_cid()
    r = await client.get(f"/channels/{cid}/whep?user_id=42")
    assert r.status_code == 200
    assert r.json() == {"whep_url": f"http://stream.test:8889/channel-{cid}-42/whep"}


@pytest.mark.asyncio
async def test_get_whep_url_requires_user_id(client):
    cid = _unique_cid()
    r = await client.get(f"/channels/{cid}/whep")
    assert r.status_code == 422
