"""Tests for the MediaMTX stream-presence poller (mocked MediaMTX API)."""

from __future__ import annotations

import json
import uuid

import httpx
import pytest
import pytest_asyncio
from dcc_media_svc.poller import reconcile_once
from dcc_media_svc.streamkeys import CHANNEL_STATE_KEY, STREAM_EVENTS_CHANNEL


def _unique_cid() -> str:
    return str(abs(hash(uuid.uuid4())) & ((1 << 53) - 1))


class _FakeMediaMtxClient:
    """Stands in for an ``httpx.AsyncClient`` — only ``.get()`` is used by the poller."""

    def __init__(self, paths_list_body: dict):
        self._body = paths_list_body

    async def get(self, url: str, params: dict | None = None) -> httpx.Response:
        return httpx.Response(200, json=self._body, request=httpx.Request("GET", url))


def _paths(*names_with_publisher: tuple[str, bool]) -> dict:
    items = []
    for name, has_pub in names_with_publisher:
        item: dict = {"name": name, "confName": "all_others"}
        if has_pub:
            item["source"] = {"type": "rtmpConn", "id": "rtmp-1"}
            item["ready"] = True
            item["available"] = True
        else:
            item["source"] = None
            item["ready"] = False
        items.append(item)
    return {"itemCount": len(items), "pageCount": 1, "items": items}


async def _drain_one(pubsub, attempts: int = 50):
    import asyncio

    for _ in range(attempts):
        msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=0.1)
        if msg is not None and msg.get("type") == "message":
            return msg
        await asyncio.sleep(0.01)
    return None


@pytest_asyncio.fixture
async def pubsub(redis):
    ps = redis.pubsub(ignore_subscribe_messages=True)
    await ps.subscribe(STREAM_EVENTS_CHANNEL)
    yield ps
    await ps.aclose()


@pytest.mark.asyncio
async def test_new_stream_sets_state_and_publishes(redis, pubsub):
    cid = _unique_cid()
    client = _FakeMediaMtxClient(
        _paths((f"channel-{cid}-55-{'deadbeef' * 4}", True), ("all_others", False), ("egress-x", True))
    )
    try:
        await reconcile_once(redis, client)
        raw = await redis.get(CHANNEL_STATE_KEY.format(channel_id=cid))
        assert raw is not None
        state = json.loads(raw.decode())
        assert state["user_ids"] == ["55"]
        assert "since" in state
        ev = json.loads((await _drain_one(pubsub))["data"])
        assert ev == {"channel_id": cid, "user_ids": ["55"]}
    finally:
        await redis.delete(CHANNEL_STATE_KEY.format(channel_id=cid))


@pytest.mark.asyncio
async def test_multiple_streamers_in_one_channel(redis, pubsub):
    cid = _unique_cid()
    client = _FakeMediaMtxClient(
        _paths(
            (f"channel-{cid}-10-{'aabbccdd' * 4}", True),
            (f"channel-{cid}-20-{'11223344' * 4}", True),
        )
    )
    try:
        await reconcile_once(redis, client)
        state = json.loads((await redis.get(CHANNEL_STATE_KEY.format(channel_id=cid))).decode())
        assert sorted(state["user_ids"]) == ["10", "20"]
        ev = json.loads((await _drain_one(pubsub))["data"])
        assert ev["channel_id"] == cid
        assert sorted(ev["user_ids"]) == ["10", "20"]
    finally:
        await redis.delete(CHANNEL_STATE_KEY.format(channel_id=cid))


@pytest.mark.asyncio
async def test_idempotent_no_duplicate_events(redis, pubsub):
    cid = _unique_cid()
    client = _FakeMediaMtxClient(_paths((f"channel-{cid}-1-{'cafebabe' * 4}", True)))
    try:
        await reconcile_once(redis, client)
        assert await _drain_one(pubsub) is not None
        await reconcile_once(redis, client)
        assert await _drain_one(pubsub, attempts=10) is None
    finally:
        await redis.delete(CHANNEL_STATE_KEY.format(channel_id=cid))


@pytest.mark.asyncio
async def test_vanished_stream_self_heals(redis, pubsub):
    cid = _unique_cid()
    live = _FakeMediaMtxClient(_paths((f"channel-{cid}-1-{'cafebabe' * 4}", True)))
    gone = _FakeMediaMtxClient(_paths(("all_others", False)))
    try:
        await reconcile_once(redis, live)
        await _drain_one(pubsub)
        await reconcile_once(redis, gone)
        assert await redis.exists(CHANNEL_STATE_KEY.format(channel_id=cid)) == 0
        ev = json.loads((await _drain_one(pubsub))["data"])
        assert ev == {"channel_id": cid, "user_ids": []}
    finally:
        await redis.delete(CHANNEL_STATE_KEY.format(channel_id=cid))


@pytest.mark.asyncio
async def test_one_streamer_leaves_others_stay(redis, pubsub):
    cid = _unique_cid()
    both = _FakeMediaMtxClient(
        _paths(
            (f"channel-{cid}-1-{'cafebabe' * 4}", True),
            (f"channel-{cid}-2-{'d00fcafe' * 4}", True),
        )
    )
    one = _FakeMediaMtxClient(_paths((f"channel-{cid}-1-{'cafebabe' * 4}", True)))
    try:
        await reconcile_once(redis, both)
        await _drain_one(pubsub)
        await reconcile_once(redis, one)
        state = json.loads((await redis.get(CHANNEL_STATE_KEY.format(channel_id=cid))).decode())
        assert state["user_ids"] == ["1"]
        ev = json.loads((await _drain_one(pubsub))["data"])
        assert ev == {"channel_id": cid, "user_ids": ["1"]}
    finally:
        await redis.delete(CHANNEL_STATE_KEY.format(channel_id=cid))


@pytest.mark.asyncio
async def test_stale_cleanup_spares_fresh_publish_active_key(redis, pubsub):
    """TOCTOU guard: when MediaMTX no longer reports a channel, the stale-cleanup
    deletes its ``stream:active`` records — EXCEPT one written by a brand-new
    publish that raced in after this pass's MediaMTX snapshot (started_at in the
    future relative to the snapshot). That fresh key must survive so WHEP keeps
    serving the live stream."""
    import datetime as _dt

    cid = _unique_cid()
    # Seed channel presence so the channel is "known" and goes stale.
    await redis.set(CHANNEL_STATE_KEY.format(channel_id=cid), json.dumps({"user_ids": ["7"], "since": "x"}))
    old_key = f"stream:active:channel-{cid}-7"
    fresh_key = f"stream:active:channel-{cid}-9"
    # Old record: started_at well in the past → deleted.
    await redis.set(old_key, json.dumps({"user_id": "7", "started_at": "2020-01-01T00:00:00+00:00", "path": "p"}))
    # Fresh record: started_at in the future → its publish raced in after the
    # snapshot; must be spared.
    future = (_dt.datetime.now(_dt.UTC) + _dt.timedelta(seconds=60)).isoformat()
    await redis.set(fresh_key, json.dumps({"user_id": "9", "started_at": future, "path": "p2"}))
    gone = _FakeMediaMtxClient(_paths(("all_others", False)))
    try:
        await reconcile_once(redis, gone)
        assert await redis.exists(old_key) == 0
        assert await redis.exists(fresh_key) == 1
    finally:
        await redis.delete(CHANNEL_STATE_KEY.format(channel_id=cid), old_key, fresh_key)


@pytest.mark.asyncio
async def test_non_channel_paths_ignored(redis, pubsub):
    # Paths missing any segment (uid, nonce) or with non-numeric channel are
    # all ignored — must be `channel-<digits>-<digits>-<32 hex>`.
    client = _FakeMediaMtxClient(
        _paths(
            ("all_others", True),
            ("channel-5", True),
            ("channel-x-1-deadbeef", True),
            ("channel-5-1", True),  # missing nonce
            ("channel-5-1-NOTHEX!!", True),
            ("egress", True),
        )
    )
    await reconcile_once(redis, client)
    assert await _drain_one(pubsub, attempts=10) is None
