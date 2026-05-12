"""Tests for the MediaMTX stream-presence poller (mocked MediaMTX API)."""

from __future__ import annotations

import json
import uuid

import httpx
import pytest
import pytest_asyncio
from dcc_media_svc.poller import reconcile_once
from dcc_media_svc.streamkeys import (
    ACTIVE_KEY,
    CHANNEL_STATE_KEY,
    STREAM_EVENTS_CHANNEL,
)


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
    # Auth hook wrote the publisher record.
    await redis.set(ACTIVE_KEY.format(channel_id=cid), json.dumps({"user_id": "55", "started_at": "x"}))
    client = _FakeMediaMtxClient(_paths((f"channel-{cid}", True), ("all_others", False), ("egress-x", True)))
    try:
        await reconcile_once(redis, client)
        raw = await redis.get(CHANNEL_STATE_KEY.format(channel_id=cid))
        assert raw is not None
        state = json.loads(raw.decode())
        assert state["active"] is True
        assert state["user_id"] == "55"
        assert "since" in state
        msg = await _drain_one(pubsub)
        assert msg is not None
        ev = json.loads(msg["data"])
        assert ev == {"channel_id": cid, "active": True, "user_id": "55"}
    finally:
        await redis.delete(CHANNEL_STATE_KEY.format(channel_id=cid), ACTIVE_KEY.format(channel_id=cid))


@pytest.mark.asyncio
async def test_new_stream_without_publisher_record_reports_null_user(redis, pubsub):
    cid = _unique_cid()
    client = _FakeMediaMtxClient(_paths((f"channel-{cid}", True)))
    try:
        await reconcile_once(redis, client)
        state = json.loads((await redis.get(CHANNEL_STATE_KEY.format(channel_id=cid))).decode())
        assert state["active"] is True
        assert state["user_id"] is None
        ev = json.loads((await _drain_one(pubsub))["data"])
        assert ev == {"channel_id": cid, "active": True, "user_id": None}
    finally:
        await redis.delete(CHANNEL_STATE_KEY.format(channel_id=cid))


@pytest.mark.asyncio
async def test_idempotent_no_duplicate_events(redis, pubsub):
    cid = _unique_cid()
    await redis.set(ACTIVE_KEY.format(channel_id=cid), json.dumps({"user_id": "1", "started_at": "x"}))
    client = _FakeMediaMtxClient(_paths((f"channel-{cid}", True)))
    try:
        await reconcile_once(redis, client)
        first = await _drain_one(pubsub)
        assert first is not None
        # Second pass — no state change → no event.
        await reconcile_once(redis, client)
        second = await _drain_one(pubsub, attempts=10)
        assert second is None
    finally:
        await redis.delete(CHANNEL_STATE_KEY.format(channel_id=cid), ACTIVE_KEY.format(channel_id=cid))


@pytest.mark.asyncio
async def test_vanished_stream_self_heals(redis, pubsub):
    cid = _unique_cid()
    await redis.set(ACTIVE_KEY.format(channel_id=cid), json.dumps({"user_id": "1", "started_at": "x"}))
    live = _FakeMediaMtxClient(_paths((f"channel-{cid}", True)))
    gone = _FakeMediaMtxClient(_paths(("all_others", False)))
    try:
        await reconcile_once(redis, live)
        await _drain_one(pubsub)  # the "active" event
        # Now MediaMTX no longer lists a publisher → flip to inactive.
        await reconcile_once(redis, gone)
        assert await redis.exists(CHANNEL_STATE_KEY.format(channel_id=cid)) == 0
        assert await redis.exists(ACTIVE_KEY.format(channel_id=cid)) == 0
        ev = json.loads((await _drain_one(pubsub))["data"])
        assert ev == {"channel_id": cid, "active": False, "user_id": None}
    finally:
        await redis.delete(CHANNEL_STATE_KEY.format(channel_id=cid), ACTIVE_KEY.format(channel_id=cid))


@pytest.mark.asyncio
async def test_non_channel_paths_ignored(redis, pubsub):
    client = _FakeMediaMtxClient(_paths(("all_others", True), ("channel-notanumber", True), ("egress", True)))
    await reconcile_once(redis, client)
    # Nothing got published.
    assert await _drain_one(pubsub, attempts=10) is None
