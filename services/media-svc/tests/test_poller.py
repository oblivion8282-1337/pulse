"""Tests for the MediaMTX stream-presence poller (mocked MediaMTX API)."""

from __future__ import annotations

import json
import uuid

import httpx
import pytest
import pytest_asyncio
from dcc_media_svc.poller import reconcile_once
from dcc_media_svc.streamkeys import CHANNEL_STATE_KEY, STOPPING_KEY, STREAM_EVENTS_CHANNEL, active_key


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
async def test_solo_stream_stop_empty_snapshot_cleans_after_grace(redis, pubsub):
    """A solo/last streamer stopping shows up as a *truly empty* MediaMTX list
    (``{"items": []}``), not a path-with-no-publisher. The first empty sample is
    debounced (could be a MediaMTX blip), but once empty persists the channel
    must be torn down — otherwise it stays "live" forever (regression guard)."""
    import dcc_media_svc.poller as _poller

    _poller._empty_snapshot_streak = 0
    cid = _unique_cid()
    live = _FakeMediaMtxClient(_paths((f"channel-{cid}-1-{'cafebabe' * 4}", True)))
    empty = _FakeMediaMtxClient(_paths())  # {"items": []}
    try:
        await reconcile_once(redis, live)
        await _drain_one(pubsub)
        # First empty sample: debounced → channel still present.
        await reconcile_once(redis, empty)
        assert await redis.exists(CHANNEL_STATE_KEY.format(channel_id=cid)) == 1
        # Second consecutive empty: grace exhausted → cleaned up + event.
        await reconcile_once(redis, empty)
        assert await redis.exists(CHANNEL_STATE_KEY.format(channel_id=cid)) == 0
        ev = json.loads((await _drain_one(pubsub))["data"])
        assert ev == {"channel_id": cid, "user_ids": []}
    finally:
        _poller._empty_snapshot_streak = 0
        await redis.delete(CHANNEL_STATE_KEY.format(channel_id=cid))


@pytest.mark.asyncio
async def test_single_transient_empty_snapshot_is_skipped(redis, pubsub):
    """A single empty snapshot (e.g. MediaMTX mid-restart) must NOT tear down a
    live stream — the round-2 protection. Recovery (non-empty next poll) keeps
    the stream and resets the streak."""
    import dcc_media_svc.poller as _poller

    _poller._empty_snapshot_streak = 0
    cid = _unique_cid()
    live = _FakeMediaMtxClient(_paths((f"channel-{cid}-1-{'cafebabe' * 4}", True)))
    empty = _FakeMediaMtxClient(_paths())
    try:
        await reconcile_once(redis, live)
        await _drain_one(pubsub)
        # One transient empty → skipped, channel survives.
        await reconcile_once(redis, empty)
        assert await redis.exists(CHANNEL_STATE_KEY.format(channel_id=cid)) == 1
        # MediaMTX recovers → streak resets, channel stays.
        await reconcile_once(redis, live)
        assert await redis.exists(CHANNEL_STATE_KEY.format(channel_id=cid)) == 1
        # A later single empty is again debounced (streak was reset).
        await reconcile_once(redis, empty)
        assert await redis.exists(CHANNEL_STATE_KEY.format(channel_id=cid)) == 1
    finally:
        _poller._empty_snapshot_streak = 0
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
async def test_user_two_slots_emits_streams(redis, pubsub):
    """One user publishing two slots (two monitors) appears once in ``user_ids``
    but twice in the additive ``streams`` list — the data the viewer needs to
    render two tiles for that user."""
    cid = _unique_cid()
    client = _FakeMediaMtxClient(
        _paths(
            (f"channel-{cid}-55-{'deadbeef' * 4}", True),  # slot 0
            (f"channel-{cid}-55-s1-{'cafebabe' * 4}", True),  # slot 1
        )
    )
    try:
        await reconcile_once(redis, client)
        state = json.loads((await redis.get(CHANNEL_STATE_KEY.format(channel_id=cid))).decode())
        assert state["user_ids"] == ["55"]
        assert state["streams"] == [
            {"user_id": "55", "slot": 0},
            {"user_id": "55", "slot": 1},
        ]
        ev = json.loads((await _drain_one(pubsub))["data"])
        assert ev["channel_id"] == cid
        assert ev["user_ids"] == ["55"]
        assert ev["streams"] == [
            {"user_id": "55", "slot": 0},
            {"user_id": "55", "slot": 1},
        ]
    finally:
        await redis.delete(CHANNEL_STATE_KEY.format(channel_id=cid))


@pytest.mark.asyncio
async def test_two_slots_surface_labels_from_active_records(redis, pubsub):
    """The poller reads each stream's ``label`` (written by the auth-hook into
    ``stream:active``) and surfaces it in both ``stream:channel.streams`` and the
    ``stream:events`` payload — the data the viewer picker renders. An absent
    label → the descriptor carries no ``label`` key (legacy client fallback)."""
    cid = _unique_cid()
    # Seed the active records the auth-hook would have written on publish-auth:
    # slot 0 carries a label, slot 1 doesn't (e.g. Linux portal — unknown source).
    await redis.set(
        active_key(cid, "55", 0),
        json.dumps({
            "user_id": "55",
            "started_at": "2026-07-05T00:00:00+00:00",
            "path": f"channel-{cid}-55-{'deadbeef' * 4}",
            "label": "Monitor 1",
        }),
    )
    await redis.set(
        active_key(cid, "55", 1),
        json.dumps({
            "user_id": "55",
            "started_at": "2026-07-05T00:00:00+00:00",
            "path": f"channel-{cid}-55-s1-{'cafebabe' * 4}",
        }),
    )
    client = _FakeMediaMtxClient(
        _paths(
            (f"channel-{cid}-55-{'deadbeef' * 4}", True),  # slot 0
            (f"channel-{cid}-55-s1-{'cafebabe' * 4}", True),  # slot 1
        )
    )
    try:
        await reconcile_once(redis, client)
        state = json.loads((await redis.get(CHANNEL_STATE_KEY.format(channel_id=cid))).decode())
        assert state["streams"] == [
            {"user_id": "55", "slot": 0, "label": "Monitor 1"},
            {"user_id": "55", "slot": 1},
        ]
        ev = json.loads((await _drain_one(pubsub))["data"])
        assert ev["streams"] == [
            {"user_id": "55", "slot": 0, "label": "Monitor 1"},
            {"user_id": "55", "slot": 1},
        ]
    finally:
        await redis.delete(
            CHANNEL_STATE_KEY.format(channel_id=cid),
            active_key(cid, "55", 0),
            active_key(cid, "55", 1),
        )


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


@pytest.mark.asyncio
async def test_poller_skips_suppressed_user(redis, pubsub):
    """A user with a ``stream:stopping`` tombstone is not re-marked live even if
    MediaMTX still lists their path (publisher-disconnect lag after an explicit
    stop). The lingering channel is torn down and an empty event published."""
    cid = _unique_cid()
    await redis.set(
        CHANNEL_STATE_KEY.format(channel_id=cid),
        json.dumps({"user_ids": ["55"], "since": "2026-01-01T00:00:00+00:00"}),
    )
    await redis.set(STOPPING_KEY.format(channel_id=cid, user_id="55"), "1", ex=30)
    client = _FakeMediaMtxClient(_paths((f"channel-{cid}-55-{'deadbeef' * 4}", True)))
    try:
        await reconcile_once(redis, client)
        assert await redis.get(CHANNEL_STATE_KEY.format(channel_id=cid)) is None
        ev = json.loads((await _drain_one(pubsub))["data"])
        assert ev == {"channel_id": cid, "user_ids": []}
    finally:
        await redis.delete(
            CHANNEL_STATE_KEY.format(channel_id=cid),
            STOPPING_KEY.format(channel_id=cid, user_id="55"),
        )


@pytest.mark.asyncio
async def test_poller_suppressed_user_removed_others_kept(redis, pubsub):
    """Suppressing one streamer leaves the channel's other live streamers intact."""
    cid = _unique_cid()
    await redis.set(STOPPING_KEY.format(channel_id=cid, user_id="10"), "1", ex=30)
    client = _FakeMediaMtxClient(
        _paths(
            (f"channel-{cid}-10-{'aabbccdd' * 4}", True),
            (f"channel-{cid}-20-{'11223344' * 4}", True),
        )
    )
    try:
        await reconcile_once(redis, client)
        state = json.loads((await redis.get(CHANNEL_STATE_KEY.format(channel_id=cid))).decode())
        assert state["user_ids"] == ["20"]
        ev = json.loads((await _drain_one(pubsub))["data"])
        assert ev["channel_id"] == cid
        assert ev["user_ids"] == ["20"]
    finally:
        await redis.delete(
            CHANNEL_STATE_KEY.format(channel_id=cid),
            STOPPING_KEY.format(channel_id=cid, user_id="10"),
        )
