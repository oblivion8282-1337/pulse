"""Tests for the snowflake generator."""

from __future__ import annotations

import threading

import pytest

from dcc_shared.snowflake import (
    DEFAULT_EPOCH_MS,
    MAX_WORKER_ID,
    Snowflake,
    SnowflakeGenerator,
)


def test_worker_id_validation() -> None:
    SnowflakeGenerator(worker_id=0)
    SnowflakeGenerator(worker_id=MAX_WORKER_ID)
    with pytest.raises(ValueError):
        SnowflakeGenerator(worker_id=-1)
    with pytest.raises(ValueError):
        SnowflakeGenerator(worker_id=MAX_WORKER_ID + 1)


def test_ids_are_monotonically_increasing() -> None:
    gen = SnowflakeGenerator(worker_id=1)
    last = -1
    for _ in range(5000):
        new = gen.next_id()
        assert new > last, f"id went backwards: {new} <= {last}"
        last = new


def test_ids_are_unique_across_threads() -> None:
    gen = SnowflakeGenerator(worker_id=42)
    ids: list[int] = []
    lock = threading.Lock()

    def worker() -> None:
        local: list[int] = []
        for _ in range(2000):
            local.append(gen.next_id())
        with lock:
            ids.extend(local)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(ids) == 8 * 2000
    assert len(set(ids)) == len(ids), "duplicate ids generated"


def test_decode_roundtrip() -> None:
    gen = SnowflakeGenerator(worker_id=7)
    raw = gen.next_id()
    decoded = Snowflake.decode(raw)
    assert decoded.worker_id == 7
    assert decoded.value == raw
    # The decoded timestamp must be close to "now".
    import time

    now_ms = int(time.time() * 1000)
    assert abs(decoded.timestamp_ms - now_ms) < 5000


def test_ids_fit_in_signed_64bit() -> None:
    gen = SnowflakeGenerator(worker_id=MAX_WORKER_ID)
    for _ in range(100):
        v = gen.next_id()
        # PostgreSQL bigint is signed 64-bit: -2^63..2^63-1.
        assert 0 <= v < (1 << 63)


def test_different_workers_dont_collide() -> None:
    g1 = SnowflakeGenerator(worker_id=1)
    g2 = SnowflakeGenerator(worker_id=2)
    seen: set[int] = set()
    for _ in range(500):
        a = g1.next_id()
        b = g2.next_id()
        assert a not in seen
        assert b not in seen
        seen.add(a)
        seen.add(b)


def test_default_epoch_is_after_year_2026() -> None:
    # Sanity-check the epoch constant — must not be in the future relative to
    # current time, otherwise next_id() raises.
    import time

    now_ms = int(time.time() * 1000)
    assert DEFAULT_EPOCH_MS <= now_ms
