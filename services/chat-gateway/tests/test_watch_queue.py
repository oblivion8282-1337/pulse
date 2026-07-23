"""Watch-party queue mutations (``watchkeys.queue_*``).

Directly exercises the Redis-level queue helpers — the WS handlers are thin
wrappers that add auth/validation on top (covered by test_watch.py's op
tests). Focus here: append, per-user removal rights, host-only reorder/advance,
auto-advance vs. play-now, and the empty-queue-serialises-as-``[]`` guard.
"""

from __future__ import annotations

import json
import os
import random

import pytest
import pytest_asyncio
from redis.asyncio import Redis

from dcc_chat_gateway import watchkeys as wk

_REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6380/0")

HOST = "10"
OTHER = "20"


@pytest_asyncio.fixture
async def redis() -> Redis:
    r = Redis.from_url(_REDIS_URL, decode_responses=False)
    yield r
    await r.aclose()


def _src(embed: str) -> dict:
    return {"type": "youtube", "embed_id": embed}


def _item(qid: str, embed: str, by: str) -> dict:
    return {"id": qid, "source": _src(embed), "submitted_by": by, "submitted_at": int(qid)}


async def _seed(r: Redis, cid: str, pid: str) -> None:
    state = {
        "party_id": pid,
        "source": _src("START"),
        "host_user_id": HOST,
        "position": 0.0,
        "is_playing": True,
        "updated_at": 1,
        "started_at": 1,
    }
    await r.hset(f"watch:channel-{cid}", pid, json.dumps(state))
    await r.expire(f"watch:channel-{cid}", 600)


@pytest_asyncio.fixture
async def party(redis: Redis):
    cid = str(random.randint(1, 1_000_000))
    pid = str(random.randint(1, 1_000_000))
    await _seed(redis, cid, pid)
    yield cid, pid
    await redis.delete(f"watch:channel-{cid}")


async def _queue(redis, cid, pid) -> list:
    state = await wk.read_party(redis, cid, pid)
    return state.get("queue", []) if state else []


@pytest.mark.asyncio
async def test_add_appends_in_order(redis, party):
    cid, pid = party
    await wk.queue_add(redis, cid, pid, _item("1", "A", OTHER))
    await wk.queue_add(redis, cid, pid, _item("2", "B", HOST))
    assert [i["id"] for i in await _queue(redis, cid, pid)] == ["1", "2"]


@pytest.mark.asyncio
async def test_add_missing_party_returns_none(redis):
    assert await wk.queue_add(redis, "999", "888", _item("1", "A", HOST)) is None


@pytest.mark.asyncio
async def test_remove_host_may_remove_anything(redis, party):
    cid, pid = party
    await wk.queue_add(redis, cid, pid, _item("1", "A", OTHER))
    assert isinstance(await wk.queue_remove(redis, cid, pid, "1", HOST), dict)
    assert await _queue(redis, cid, pid) == []


@pytest.mark.asyncio
async def test_remove_submitter_may_remove_own_only(redis, party):
    cid, pid = party
    await wk.queue_add(redis, cid, pid, _item("1", "A", OTHER))  # OTHER's
    await wk.queue_add(redis, cid, pid, _item("2", "B", HOST))  # HOST's
    # OTHER may drop their own …
    assert isinstance(await wk.queue_remove(redis, cid, pid, "1", OTHER), dict)
    # … but not the host's item.
    assert await wk.queue_remove(redis, cid, pid, "2", OTHER) == "FORBIDDEN"
    assert [i["id"] for i in await _queue(redis, cid, pid)] == ["2"]


@pytest.mark.asyncio
async def test_remove_unknown_id(redis, party):
    cid, pid = party
    assert await wk.queue_remove(redis, cid, pid, "nope", HOST) == "NOTFOUND"


@pytest.mark.asyncio
async def test_move_host_only(redis, party):
    cid, pid = party
    for n in ("1", "2", "3"):
        await wk.queue_add(redis, cid, pid, _item(n, n, HOST))
    # Non-host can't reorder.
    assert await wk.queue_move(redis, cid, pid, "3", 0, OTHER) == "FORBIDDEN"
    # Host moves item 3 to the front.
    assert isinstance(await wk.queue_move(redis, cid, pid, "3", 0, HOST), dict)
    assert [i["id"] for i in await _queue(redis, cid, pid)] == ["3", "1", "2"]


@pytest.mark.asyncio
async def test_advance_promotes_first(redis, party):
    cid, pid = party
    await wk.queue_add(redis, cid, pid, _item("1", "NEXT", OTHER))
    await wk.queue_add(redis, cid, pid, _item("2", "LATER", OTHER))
    await wk.queue_advance(redis, cid, pid, HOST)
    state = await wk.read_party(redis, cid, pid)
    assert state["source"]["embed_id"] == "NEXT"
    assert state["is_playing"] is True
    assert state["position"] == 0.0
    assert [i["id"] for i in state["queue"]] == ["2"]


@pytest.mark.asyncio
async def test_advance_specific_id_plays_now(redis, party):
    cid, pid = party
    await wk.queue_add(redis, cid, pid, _item("1", "A", OTHER))
    await wk.queue_add(redis, cid, pid, _item("2", "SKIP_TO", OTHER))
    await wk.queue_advance(redis, cid, pid, HOST, "2")
    state = await wk.read_party(redis, cid, pid)
    assert state["source"]["embed_id"] == "SKIP_TO"
    assert [i["id"] for i in state["queue"]] == ["1"]  # item 1 stays queued


@pytest.mark.asyncio
async def test_advance_host_only(redis, party):
    cid, pid = party
    await wk.queue_add(redis, cid, pid, _item("1", "A", OTHER))
    assert await wk.queue_advance(redis, cid, pid, OTHER) == "FORBIDDEN"


@pytest.mark.asyncio
async def test_advance_empty_queue(redis, party):
    cid, pid = party
    assert await wk.queue_advance(redis, cid, pid, HOST) == "EMPTY"


@pytest.mark.asyncio
async def test_empty_queue_serialises_as_array(redis, party):
    cid, pid = party
    await wk.queue_add(redis, cid, pid, _item("1", "A", OTHER))
    await wk.queue_advance(redis, cid, pid, HOST)  # drains the one item
    # Raw JSON in Redis: the empty queue must be [], not {} (the cjson trap the
    # Python WATCH/MULTI path avoids).
    raw = await redis.hget(f"watch:channel-{cid}", pid)
    assert '"queue":[]' in raw.decode()


@pytest.mark.asyncio
async def test_advance_bumps_source_epoch(redis, party):
    """Promoting a queued clip is a source swap → the epoch increments. The
    host tags heartbeats with it; the server drops stale-clip positions."""
    cid, pid = party
    await wk.queue_add(redis, cid, pid, _item("1", "A", OTHER))
    state = await wk.queue_advance(redis, cid, pid, HOST)
    assert isinstance(state, dict)
    assert state["source_epoch"] == 1  # seeded without the field (0) → bumped

    await wk.queue_add(redis, cid, pid, _item("2", "B", OTHER))
    state2 = await wk.queue_advance(redis, cid, pid, HOST)
    assert state2["source_epoch"] == 2


@pytest.mark.asyncio
async def test_host_write_does_not_clobber_concurrent_enqueue(redis, party):
    """Lost-update guard: a host write (play/pause/seek/heartbeat) goes through
    ``mutate_party`` — the same WATCH/MULTI path as the queue — so an enqueue
    that commits between the host op's read and its write is NOT dropped.

    We drive the race deterministically: on the host mutate's first pass a
    competing enqueue lands via a *separate* connection, which invalidates the
    WATCH and forces a retry; the retry must observe the queued item."""
    import redis as redis_sync  # sync client, present in the same package

    cid, pid = party
    other = redis_sync.Redis.from_url(_REDIS_URL, decode_responses=False)
    injected = {"done": False}

    def apply(state: dict) -> None:
        # First pass only: enqueue through another connection *after* our
        # WATCH-read but *before* our MULTI commits → WatchError → retry.
        if not injected["done"]:
            injected["done"] = True
            raw = other.hget(f"watch:channel-{cid}", pid)
            s = json.loads(raw)
            s.setdefault("queue", []).append(_item("99", "VID", OTHER))
            other.hset(f"watch:channel-{cid}", pid, json.dumps(s))
        state["position"] = 42.0  # the host write itself
        return None

    try:
        result = await wk.mutate_party(redis, cid, pid, apply)
    finally:
        other.close()

    assert injected["done"]  # the race actually fired
    assert isinstance(result, dict)  # not CONTENDED / None
    assert result["position"] == 42.0  # host write applied
    # The concurrent enqueue survived — the whole point of routing host writes
    # through the optimistic path instead of a plain snapshot write_party.
    assert [i["id"] for i in await _queue(redis, cid, pid)] == ["99"]
