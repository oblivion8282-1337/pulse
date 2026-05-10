"""Snowflake-ID generator.

Format (64-bit signed positive int):
    [42-bit ms-since-epoch][10-bit worker-id][12-bit seq]

Epoch is configurable (default 2026-01-01T00:00:00Z) to maximise lifetime.
Within a single millisecond, up to 4096 IDs per worker can be generated. If
the sequence overflows the generator sleeps until the next millisecond.

This module is dependency-free and thread-safe via a lock.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass

# 2026-01-01 00:00:00 UTC, expressed as milliseconds since the Unix epoch.
DEFAULT_EPOCH_MS = 1767225600000

WORKER_BITS = 10
SEQ_BITS = 12

MAX_WORKER_ID = (1 << WORKER_BITS) - 1
MAX_SEQ = (1 << SEQ_BITS) - 1

WORKER_SHIFT = SEQ_BITS
TIME_SHIFT = SEQ_BITS + WORKER_BITS


@dataclass(frozen=True)
class Snowflake:
    """Decoded snowflake parts (for tests/debug)."""

    value: int
    timestamp_ms: int
    worker_id: int
    sequence: int

    @classmethod
    def decode(cls, value: int, epoch_ms: int = DEFAULT_EPOCH_MS) -> Snowflake:
        seq = value & MAX_SEQ
        worker = (value >> WORKER_SHIFT) & MAX_WORKER_ID
        ts = (value >> TIME_SHIFT) + epoch_ms
        return cls(value=value, timestamp_ms=ts, worker_id=worker, sequence=seq)


class SnowflakeGenerator:
    """Thread-safe snowflake generator."""

    def __init__(self, worker_id: int, epoch_ms: int = DEFAULT_EPOCH_MS) -> None:
        if not 0 <= worker_id <= MAX_WORKER_ID:
            raise ValueError(f"worker_id must be in [0, {MAX_WORKER_ID}], got {worker_id}")
        self.worker_id = worker_id
        self.epoch_ms = epoch_ms
        self._lock = threading.Lock()
        self._last_ts = -1
        self._seq = 0

    def _now_ms(self) -> int:
        return int(time.time() * 1000)

    def _wait_next_ms(self, last: int) -> int:
        ts = self._now_ms()
        while ts <= last:
            time.sleep(0.0001)
            ts = self._now_ms()
        return ts

    def next_id(self) -> int:
        with self._lock:
            ts = self._now_ms()
            if ts < self._last_ts:
                # Clock went backwards. Wait until last_ts to avoid duplicates.
                ts = self._wait_next_ms(self._last_ts - 1)
            if ts == self._last_ts:
                self._seq = (self._seq + 1) & MAX_SEQ
                if self._seq == 0:
                    ts = self._wait_next_ms(self._last_ts)
            else:
                self._seq = 0
            self._last_ts = ts
            delta = ts - self.epoch_ms
            if delta < 0:
                raise RuntimeError(
                    f"current time {ts} is before configured epoch {self.epoch_ms}"
                )
            return (delta << TIME_SHIFT) | (self.worker_id << WORKER_SHIFT) | self._seq
