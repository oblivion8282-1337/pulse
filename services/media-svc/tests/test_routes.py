"""Tests for the media-svc HTTP routes."""

from __future__ import annotations

import json
import uuid

import pytest
from dcc_media_svc.streamkeys import (
    ACTIVE_KEY,
    CHANNEL_STATE_KEY,
    STOPPING_KEY,
    TOKEN_KEY,
    active_key,
    stopping_key,
)


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
async def test_stream_token_slot1_path_and_record(client, auth_signer, redis):
    """A slot-1 token targets a slotted path ``…-s1-<nonce>`` and stamps ``slot``
    into the record so the auth-hook can bind the publish to that slot."""
    access = auth_signer.issue_access(4242, "alice")
    cid = _unique_cid()
    r = await client.post(f"/channels/{cid}/stream-token", json={"slot": 1}, headers=_auth(access))
    assert r.status_code == 200, r.text
    body = r.json()
    path = body["mediamtx_path"]
    assert path.startswith(f"channel-{cid}-4242-s1-")
    token = body["token"]
    try:
        rec = json.loads((await redis.get(TOKEN_KEY.format(token=token))).decode())
        assert rec["slot"] == 1
    finally:
        await redis.delete(TOKEN_KEY.format(token=token))


@pytest.mark.asyncio
async def test_stream_token_rejects_out_of_range_slot(client, auth_signer):
    """Slot is clamped to the N=2 range (0/1); slot 2 is rejected, not silently
    accepted (which would mint an un-viewable path)."""
    access = auth_signer.issue_access(7, "bob")
    r = await client.post("/channels/1/stream-token", json={"slot": 2}, headers=_auth(access))
    assert r.status_code == 422


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
    assert r.json() == {"channel_id": cid, "user_ids": [], "streams": [], "since": None}


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
            "streams": [],
            "since": "2026-05-12T00:00:00+00:00",
        }
    finally:
        await redis.delete(CHANNEL_STATE_KEY.format(channel_id=cid))


@pytest.mark.asyncio
async def test_get_whep_url_returns_active_path(client, redis, auth_signer):
    access = auth_signer.issue_access(7, "bob")
    cid = _unique_cid()
    path = f"channel-{cid}-42-{'deadbeef' * 4}"
    await redis.set(
        ACTIVE_KEY.format(channel_id=cid, user_id="42"),
        json.dumps({"user_id": "42", "started_at": "2026-05-14T00:00:00+00:00", "path": path}),
    )
    try:
        r = await client.get(f"/channels/{cid}/whep?user_id=42", headers=_auth(access))
        assert r.status_code == 200
        whep_url = r.json()["whep_url"]
        # URL points at the active nonce'd path and carries a read token.
        base, _, query = whep_url.partition("?")
        assert base == f"http://stream.test:8889/{path}/whep"
        assert query.startswith("token=")
        read_token = query[len("token=") :]

        # The token resolves to a channel+publisher-bound read record in Redis.
        raw = await redis.get(TOKEN_KEY.format(token=read_token))
        assert raw is not None
        rec = json.loads(raw)
        assert rec["scope"] == "read"
        assert rec["channel_id"] == cid
        assert rec["user_id"] == "42"
    finally:
        await redis.delete(ACTIVE_KEY.format(channel_id=cid, user_id="42"))
        await redis.delete(TOKEN_KEY.format(token=read_token))


@pytest.mark.asyncio
async def test_get_whep_url_slot1_reads_slotted_active_key(client, redis, auth_signer):
    """``?slot=1`` resolves the user's *second* stream — a distinct active record
    and a distinct MediaMTX path from slot 0."""
    access = auth_signer.issue_access(7, "bob")
    cid = _unique_cid()
    path0 = f"channel-{cid}-42-{'deadbeef' * 4}"
    path1 = f"channel-{cid}-42-s1-{'cafebabe' * 4}"
    await redis.set(
        active_key(cid, "42", 0),
        json.dumps({"user_id": "42", "started_at": "2026-05-14T00:00:00+00:00", "path": path0}),
    )
    await redis.set(
        active_key(cid, "42", 1),
        json.dumps({"user_id": "42", "started_at": "2026-05-14T00:00:00+00:00", "path": path1}),
    )
    try:
        r0 = await client.get(f"/channels/{cid}/whep?user_id=42", headers=_auth(access))
        r1 = await client.get(f"/channels/{cid}/whep?user_id=42&slot=1", headers=_auth(access))
        assert r0.status_code == 200 and r1.status_code == 200
        assert f"/{path0}/whep" in r0.json()["whep_url"]
        assert f"/{path1}/whep" in r1.json()["whep_url"]
    finally:
        await redis.delete(active_key(cid, "42", 0), active_key(cid, "42", 1))


@pytest.mark.asyncio
async def test_get_whep_url_requires_auth(client):
    """Anonymous callers must never get the nonce'd WHEP URL — a self-host
    deployment exposing media-svc directly would otherwise leak streams."""
    cid = _unique_cid()
    r = await client.get(f"/channels/{cid}/whep?user_id=42")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_get_whep_url_404_when_no_active_stream(client, auth_signer):
    access = auth_signer.issue_access(7, "bob")
    cid = _unique_cid()
    r = await client.get(f"/channels/{cid}/whep?user_id=42", headers=_auth(access))
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_get_whep_url_requires_user_id(client, auth_signer):
    access = auth_signer.issue_access(7, "bob")
    cid = _unique_cid()
    r = await client.get(f"/channels/{cid}/whep", headers=_auth(access))
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_stop_stream_requires_auth(client):
    r = await client.delete("/channels/123/stream")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_stop_stream_clears_presence_and_sets_tombstone(client, auth_signer, redis):
    """Explicit stop drops the user's active record + channel state immediately
    and arms the stopping-tombstone so the poller won't re-add them."""
    access = auth_signer.issue_access(4242, "alice")
    cid = _unique_cid()
    ck = CHANNEL_STATE_KEY.format(channel_id=cid)
    ak = ACTIVE_KEY.format(channel_id=cid, user_id="4242")
    sk = STOPPING_KEY.format(channel_id=cid, user_id="4242")
    await redis.set(ck, json.dumps({"user_ids": ["4242"], "since": "2026-01-01T00:00:00+00:00"}))
    await redis.set(ak, json.dumps({"user_id": "4242", "path": f"channel-{cid}-4242-x"}))
    try:
        r = await client.delete(f"/channels/{cid}/stream", headers=_auth(access))
        assert r.status_code == 204, r.text
        assert await redis.get(ck) is None  # solo streamer → channel torn down
        assert await redis.get(ak) is None  # active record gone
        assert await redis.get(sk) is not None  # tombstone armed
        assert await redis.ttl(sk) > 0
    finally:
        await redis.delete(ck, ak, sk)


@pytest.mark.asyncio
async def test_stop_stream_keeps_other_streamers(client, auth_signer, redis):
    """Stopping one user leaves co-streamers in the channel state."""
    access = auth_signer.issue_access(4242, "alice")
    cid = _unique_cid()
    ck = CHANNEL_STATE_KEY.format(channel_id=cid)
    await redis.set(ck, json.dumps({"user_ids": ["4242", "999"], "since": "2026-01-01T00:00:00+00:00"}))
    try:
        r = await client.delete(f"/channels/{cid}/stream", headers=_auth(access))
        assert r.status_code == 204, r.text
        state = json.loads((await redis.get(ck)).decode())
        assert state["user_ids"] == ["999"]
    finally:
        await redis.delete(ck, STOPPING_KEY.format(channel_id=cid, user_id="4242"))


@pytest.mark.asyncio
async def test_stop_specific_slot_keeps_users_other_stream(client, auth_signer, redis):
    """Stopping only slot 1 leaves the caller's slot-0 stream live (and other
    users untouched); the state falls back to the legacy shape once nobody runs
    slot ≥ 1 any more."""
    access = auth_signer.issue_access(4242, "alice")
    cid = _unique_cid()
    ck = CHANNEL_STATE_KEY.format(channel_id=cid)
    state = {
        "user_ids": ["4242", "999"],
        "streams": [
            {"user_id": "4242", "slot": 0},
            {"user_id": "4242", "slot": 1},
            {"user_id": "999", "slot": 0},
        ],
        "since": "2026-01-01T00:00:00+00:00",
    }
    await redis.set(ck, json.dumps(state))
    await redis.set(active_key(cid, "4242", 1), json.dumps({"user_id": "4242", "path": "p"}))
    try:
        r = await client.delete(f"/channels/{cid}/stream?slot=1", headers=_auth(access))
        assert r.status_code == 204, r.text
        assert await redis.exists(active_key(cid, "4242", 1)) == 0  # slot-1 record gone
        new = json.loads((await redis.get(ck)).decode())
        assert sorted(new["user_ids"]) == ["4242", "999"]  # alice still present via slot 0
        assert "streams" not in new  # only slot-0 left → legacy shape
        assert await redis.get(stopping_key(cid, "4242", 1)) is not None  # slot-1 tombstone armed
        assert await redis.get(stopping_key(cid, "4242", 0)) is None  # slot-0 untouched
    finally:
        await redis.delete(ck, active_key(cid, "4242", 1), stopping_key(cid, "4242", 1))


@pytest.mark.asyncio
async def test_issue_token_clears_stopping_tombstone(client, auth_signer, redis):
    """A fresh token (restart) cancels a pending stop-suppression for that user."""
    access = auth_signer.issue_access(4242, "alice")
    cid = _unique_cid()
    sk = STOPPING_KEY.format(channel_id=cid, user_id="4242")
    await redis.set(sk, "1", ex=30)
    r = await client.post(f"/channels/{cid}/stream-token", json={}, headers=_auth(access))
    assert r.status_code == 200, r.text
    try:
        assert await redis.get(sk) is None
    finally:
        await redis.delete(TOKEN_KEY.format(token=r.json()["token"]), sk)
