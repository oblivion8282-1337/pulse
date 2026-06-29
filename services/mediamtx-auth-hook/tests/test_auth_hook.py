"""Tests for the MediaMTX authHTTP delegation hook."""

from __future__ import annotations

import json
import time
import uuid

import pytest
from dcc_mediamtx_auth_hook.shared import ACTIVE_KEY, TOKEN_KEY, active_key


def _unique_cid() -> str:
    return str(abs(hash(uuid.uuid4())) & ((1 << 53) - 1))


async def _put_token(
    redis,
    token: str,
    *,
    channel_id: str,
    user_id: str,
    nonce: str = "deadbeef" * 4,
    scope: str = "publish",
    slot: int = 0,
    ttl: int = 3600,
):
    record = {
        "channel_id": channel_id,
        "user_id": user_id,
        "nonce": nonce,
        "scope": scope,
        "protocol": "rtmp",
        "created_at": int(time.time()),
    }
    if slot:  # slot 0 omitted → legacy token shape (matches media-svc)
        record["slot"] = slot
    await redis.set(TOKEN_KEY.format(token=token), json.dumps(record, separators=(",", ":")), ex=ttl)


def _ch_path(cid: str, uid: str, nonce: str = "deadbeef" * 4, slot: int = 0) -> str:
    # Slot 0 == legacy path with no -s segment; slot ≥ 1 carries -s<slot>.
    return f"channel-{cid}-{uid}-{nonce}" if not slot else f"channel-{cid}-{uid}-s{slot}-{nonce}"


def _body(action: str, path: str, *, password: str = "", token: str = "", protocol: str = "rtmp") -> dict:
    return {
        "user": "",
        "password": password,
        "token": token,
        "ip": "1.2.3.4",
        "action": action,
        "path": path,
        "protocol": protocol,
        "id": "conn-1",
        "query": "",
    }


@pytest.mark.asyncio
async def test_health(client):
    r = await client.get("/health")
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_publish_valid_token_for_right_channel_user(client, redis):
    cid = _unique_cid()
    uid = "42"
    token = "tok-" + uuid.uuid4().hex
    await _put_token(redis, token, channel_id=cid, user_id=uid)
    try:
        path = _ch_path(cid, uid)
        r = await client.post("/", json=_body("publish", path, password=token))
        assert r.status_code == 200, r.text
        raw = await redis.get(ACTIVE_KEY.format(channel_id=cid, user_id=uid))
        assert raw is not None
        rec = json.loads(raw.decode())
        assert rec["user_id"] == uid
        assert "started_at" in rec
        assert rec["path"] == path
    finally:
        await redis.delete(TOKEN_KEY.format(token=token), ACTIVE_KEY.format(channel_id=cid, user_id=uid))


@pytest.mark.asyncio
async def test_publish_token_in_token_field_also_works(client, redis):
    cid = _unique_cid()
    uid = "7"
    token = "tok-" + uuid.uuid4().hex
    await _put_token(redis, token, channel_id=cid, user_id=uid)
    try:
        r = await client.post("/", json=_body("publish", _ch_path(cid, uid), token=token))
        assert r.status_code == 200, r.text
    finally:
        await redis.delete(TOKEN_KEY.format(token=token), ACTIVE_KEY.format(channel_id=cid, user_id=uid))


@pytest.mark.asyncio
async def test_publish_token_consumed_after_success(client, redis):
    """A successful publish must invalidate the token immediately so the 4h TTL
    window can't be replayed (stolen-URL replay-protection)."""
    cid = _unique_cid()
    uid = "42"
    token = "tok-" + uuid.uuid4().hex
    await _put_token(redis, token, channel_id=cid, user_id=uid)
    try:
        r = await client.post("/", json=_body("publish", _ch_path(cid, uid), password=token))
        assert r.status_code == 200
        # Token must no longer be in Redis.
        assert await redis.exists(TOKEN_KEY.format(token=token)) == 0
        # A second publish with the same token must be denied.
        r2 = await client.post("/", json=_body("publish", _ch_path(cid, uid), password=token))
        assert r2.status_code == 401
    finally:
        await redis.delete(ACTIVE_KEY.format(channel_id=cid, user_id=uid))


@pytest.mark.asyncio
async def test_publish_valid_token_wrong_channel_denied(client, redis):
    cid = _unique_cid()
    other = _unique_cid()
    uid = "42"
    token = "tok-" + uuid.uuid4().hex
    await _put_token(redis, token, channel_id=cid, user_id=uid)
    try:
        r = await client.post("/", json=_body("publish", _ch_path(other, uid), password=token))
        assert r.status_code == 401
        assert await redis.exists(ACTIVE_KEY.format(channel_id=other, user_id=uid)) == 0
    finally:
        await redis.delete(TOKEN_KEY.format(token=token))


@pytest.mark.asyncio
async def test_publish_valid_token_wrong_user_denied(client, redis):
    cid = _unique_cid()
    token = "tok-" + uuid.uuid4().hex
    await _put_token(redis, token, channel_id=cid, user_id="42")
    try:
        # Token says user 42, but the path claims user 99 → denied.
        r = await client.post("/", json=_body("publish", _ch_path(cid, "99"), password=token))
        assert r.status_code == 401
        assert await redis.exists(ACTIVE_KEY.format(channel_id=cid, user_id="99")) == 0
    finally:
        await redis.delete(TOKEN_KEY.format(token=token))


@pytest.mark.asyncio
async def test_publish_wrong_nonce_denied(client, redis):
    """Token's nonce must match the one in the path — guards against a stale
    token reusing a fresh path (or vice versa)."""
    cid = _unique_cid()
    uid = "42"
    token = "tok-" + uuid.uuid4().hex
    await _put_token(redis, token, channel_id=cid, user_id=uid, nonce="aabbccdd" * 4)
    try:
        r = await client.post(
            "/", json=_body("publish", _ch_path(cid, uid, nonce="11223344" * 4), password=token)
        )
        assert r.status_code == 401
        assert await redis.exists(ACTIVE_KEY.format(channel_id=cid, user_id=uid)) == 0
    finally:
        await redis.delete(TOKEN_KEY.format(token=token))


@pytest.mark.asyncio
async def test_publish_slot1_writes_slotted_active_key(client, redis):
    """A slot-1 token publishing on a slot-1 path is accepted, and its active
    record lands under the slotted key so it can't clobber the user's slot-0
    stream (the whole point of slots: two streams, two records)."""
    cid = _unique_cid()
    uid = "42"
    token = "tok-" + uuid.uuid4().hex
    await _put_token(redis, token, channel_id=cid, user_id=uid, slot=1)
    try:
        path = _ch_path(cid, uid, slot=1)
        r = await client.post("/", json=_body("publish", path, password=token))
        assert r.status_code == 200, r.text
        # The record lives at the slotted key, NOT the legacy slot-0 key.
        raw = await redis.get(active_key(cid, uid, 1))
        assert raw is not None and json.loads(raw.decode())["path"] == path
        assert await redis.exists(active_key(cid, uid, 0)) == 0
    finally:
        await redis.delete(TOKEN_KEY.format(token=token), active_key(cid, uid, 1))


@pytest.mark.asyncio
async def test_publish_slot_mismatch_denied(client, redis):
    """A slot-0 token (legacy, no slot field) may not publish on a slot-1 path
    and vice versa — guards a token being reused for the wrong stream."""
    cid = _unique_cid()
    uid = "42"
    # Token says slot 0 (omitted), path claims slot 1 → denied.
    token0 = "tok-" + uuid.uuid4().hex
    await _put_token(redis, token0, channel_id=cid, user_id=uid)
    # Token says slot 1, path is the legacy slot-0 path → denied.
    token1 = "tok-" + uuid.uuid4().hex
    await _put_token(redis, token1, channel_id=cid, user_id=uid, slot=1)
    try:
        r = await client.post("/", json=_body("publish", _ch_path(cid, uid, slot=1), password=token0))
        assert r.status_code == 401
        r = await client.post("/", json=_body("publish", _ch_path(cid, uid), password=token1))
        assert r.status_code == 401
        # Neither wrote an active record.
        assert await redis.exists(active_key(cid, uid, 0)) == 0
        assert await redis.exists(active_key(cid, uid, 1)) == 0
    finally:
        await redis.delete(TOKEN_KEY.format(token=token0), TOKEN_KEY.format(token=token1))


@pytest.mark.asyncio
async def test_publish_unknown_token_denied(client):
    cid = _unique_cid()
    r = await client.post(
        "/", json=_body("publish", _ch_path(cid, "1"), password="nope-" + uuid.uuid4().hex)
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_publish_expired_token_denied(client, redis):
    cid = _unique_cid()
    token = "tok-" + uuid.uuid4().hex
    await _put_token(redis, token, channel_id=cid, user_id="1")
    await redis.delete(TOKEN_KEY.format(token=token))
    r = await client.post("/", json=_body("publish", _ch_path(cid, "1"), password=token))
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_publish_wrong_scope_denied(client, redis):
    cid = _unique_cid()
    token = "tok-" + uuid.uuid4().hex
    await _put_token(redis, token, channel_id=cid, user_id="1", scope="read")
    try:
        r = await client.post("/", json=_body("publish", _ch_path(cid, "1"), password=token))
        assert r.status_code == 401
    finally:
        await redis.delete(TOKEN_KEY.format(token=token))


@pytest.mark.asyncio
async def test_publish_non_channel_path_denied(client, redis):
    token = "tok-" + uuid.uuid4().hex
    await _put_token(redis, token, channel_id="123", user_id="1")
    try:
        r = await client.post("/", json=_body("publish", "some-random-path", password=token))
        assert r.status_code == 401
        # Invalid path shapes: non-numeric channel, missing user, missing nonce.
        r = await client.post(
            "/", json=_body("publish", "channel-abc-1-" + "deadbeef" * 4, password=token)
        )
        assert r.status_code == 401
        r = await client.post("/", json=_body("publish", "channel-123", password=token))
        assert r.status_code == 401
        r = await client.post("/", json=_body("publish", "channel-123-1", password=token))
        assert r.status_code == 401
    finally:
        await redis.delete(TOKEN_KEY.format(token=token))


@pytest.mark.asyncio
async def test_read_with_valid_token_allowed(client, redis):
    cid = _unique_cid()
    token = "read-" + uuid.uuid4().hex
    await _put_token(redis, token, channel_id=cid, user_id="1", scope="read")
    try:
        r = await client.post("/", json=_body("read", _ch_path(cid, "1"), token=token))
        assert r.status_code == 200
        r = await client.post("/", json=_body("playback", _ch_path(cid, "1"), token=token))
        assert r.status_code == 200
    finally:
        await redis.delete(TOKEN_KEY.format(token=token))


@pytest.mark.asyncio
async def test_read_token_via_query_field_allowed(client, redis):
    """MediaMTX 1.17.1 delivers the WHEP ``?token=`` in the raw ``query`` field,
    NOT the dedicated ``token`` field (verified live against the real server).
    The hook must parse it out of ``query`` — otherwise every legitimate viewer
    is rejected with read_unknown_token. Regression pin for that behaviour."""
    cid = _unique_cid()
    token = "read-" + uuid.uuid4().hex
    await _put_token(redis, token, channel_id=cid, user_id="1", scope="read")
    try:
        body = _body("read", _ch_path(cid, "1"))  # token + password stay ""
        body["query"] = f"token={token}"
        r = await client.post("/", json=body)
        assert r.status_code == 200
    finally:
        await redis.delete(TOKEN_KEY.format(token=token))


@pytest.mark.asyncio
async def test_read_without_token_denied(client):
    cid = _unique_cid()
    r = await client.post("/", json=_body("read", _ch_path(cid, "1")))
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_read_with_publish_scope_token_denied(client, redis):
    cid = _unique_cid()
    token = "pub-" + uuid.uuid4().hex
    await _put_token(redis, token, channel_id=cid, user_id="1", scope="publish")
    try:
        r = await client.post("/", json=_body("read", _ch_path(cid, "1"), token=token))
        assert r.status_code == 401
    finally:
        await redis.delete(TOKEN_KEY.format(token=token))


@pytest.mark.asyncio
async def test_read_token_for_other_channel_denied(client, redis):
    cid = _unique_cid()
    other = _unique_cid()
    token = "read-" + uuid.uuid4().hex
    await _put_token(redis, token, channel_id=other, user_id="1", scope="read")
    try:
        r = await client.post("/", json=_body("read", _ch_path(cid, "1"), token=token))
        assert r.status_code == 401
    finally:
        await redis.delete(TOKEN_KEY.format(token=token))


@pytest.mark.asyncio
async def test_read_token_not_consumed_multi_use(client, redis):
    """A WHEP handshake auths multiple times (OPTIONS + POST) and reconnects —
    the read token must survive repeated reads, unlike single-use publish."""
    cid = _unique_cid()
    token = "read-" + uuid.uuid4().hex
    await _put_token(redis, token, channel_id=cid, user_id="1", scope="read")
    try:
        for _ in range(3):
            r = await client.post("/", json=_body("read", _ch_path(cid, "1"), token=token))
            assert r.status_code == 200
        assert await redis.get(TOKEN_KEY.format(token=token)) is not None
    finally:
        await redis.delete(TOKEN_KEY.format(token=token))


@pytest.mark.asyncio
async def test_read_anonymous_when_disabled(client, monkeypatch):
    from dcc_mediamtx_auth_hook import routes as hook_routes
    from dcc_mediamtx_auth_hook.config import Settings

    monkeypatch.setattr(
        hook_routes, "get_settings", lambda: Settings(read_token_required=False)
    )
    cid = _unique_cid()
    r = await client.post("/", json=_body("read", _ch_path(cid, "1")))
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_read_on_non_channel_path_denied(client):
    r = await client.post("/", json=_body("read", "all_others"))
    assert r.status_code == 401
    r = await client.post("/", json=_body("read", "channel-123-1"))  # no nonce
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_api_metrics_pprof_allowed(client):
    for action in ("api", "metrics", "pprof"):
        r = await client.post("/", json=_body(action, ""))
        assert r.status_code == 200, action


@pytest.mark.asyncio
async def test_unknown_action_denied(client):
    cid = _unique_cid()
    r = await client.post("/", json=_body("teleport", _ch_path(cid, "1")))
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_auth_alias_path_works(client):
    r = await client.post("/auth", json=_body("api", ""))
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_extra_fields_tolerated(client):
    body = _body("api", "")
    body["someNewField"] = "x"
    r = await client.post("/", json=body)
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_null_string_fields_tolerated(client, redis):
    # MediaMTX 1.17 emits JSON `null` for fields it doesn't set (e.g. `id` on
    # WHEP OPTIONS preflights). Older clients used to send "" here; both must
    # parse without 422 so the auth chain never breaks across MediaMTX builds.
    token = "read-" + uuid.uuid4().hex
    await _put_token(redis, token, channel_id="1", user_id="2", scope="read")
    try:
        body = _body(
            "read", "channel-1-2-" + "deadbeef" * 4, protocol="webrtc", token=token
        )
        body["id"] = None
        body["user"] = None
        body["query"] = None
        r = await client.post("/", json=body)
        assert r.status_code == 200
    finally:
        await redis.delete(TOKEN_KEY.format(token=token))
