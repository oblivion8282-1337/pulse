"""Tests for cloud_policy_poller.py (Phase 3.3).

Coverage:
1. Initial poll: writes JSON body to Redis cache key.
2. Cloud unerreichbar: cache bleibt, kein Crash.
3. get_cached_policy helper: parst Redis-Wert korrekt.
4. get_cached_policy on empty cache: returns None.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from dcc_chat_gateway.cloud_policy_poller import (
    REDIS_POLICY_KEY,
    cloud_policy_poll_once,
    get_cached_policy,
)

CLOUD_ORIGIN = "https://howispulse.com"

_POLICY = {
    "version": 1,
    "current_version": "0.8.0",
    "min_version": "0.7.0",
    "updated_at": "2026-05-26T00:00:00Z",
}


def _make_redis(stored: dict | None = None) -> AsyncMock:
    """Minimal Redis mock with get/set tracking."""
    redis = AsyncMock()
    _store: dict[str, bytes] = {}
    if stored is not None:
        _store[REDIS_POLICY_KEY] = json.dumps(stored).encode()

    async def _get(key):
        return _store.get(key)

    async def _set(key, value):
        _store[key] = value.encode() if isinstance(value, str) else value

    redis.get = _get
    redis.set = _set
    redis._store = _store
    return redis


def _make_client(status: int = 200, body: dict | None = None) -> AsyncMock:
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status
    if body is not None:
        resp.json = MagicMock(return_value=body)
    if status >= 400:
        resp.raise_for_status = MagicMock(
            side_effect=httpx.HTTPStatusError("err", request=MagicMock(), response=resp)
        )
    else:
        resp.raise_for_status = MagicMock()
    client = AsyncMock()
    client.get = AsyncMock(return_value=resp)
    return client


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_initial_poll_writes_cache():
    """200 response → policy body written to Redis."""
    redis = _make_redis()
    client = _make_client(200, _POLICY)

    await cloud_policy_poll_once(redis, CLOUD_ORIGIN, client)

    raw = redis._store.get(REDIS_POLICY_KEY)
    assert raw is not None, "Expected policy written to Redis"
    stored = json.loads(raw)
    assert stored["current_version"] == "0.8.0"
    assert stored["min_version"] == "0.7.0"


@pytest.mark.asyncio
async def test_cloud_unreachable_keeps_cache():
    """Network error → no crash, existing cache unchanged."""
    redis = _make_redis(stored=_POLICY)
    client = AsyncMock()
    client.get = AsyncMock(side_effect=httpx.ConnectTimeout("timeout"))

    # Must not raise
    await cloud_policy_poll_once(redis, CLOUD_ORIGIN, client)

    raw = redis._store.get(REDIS_POLICY_KEY)
    assert raw is not None, "Cache should be preserved on error"
    assert json.loads(raw)["current_version"] == "0.8.0"


@pytest.mark.asyncio
async def test_http_error_keeps_cache():
    """HTTP 503 → fail-soft, cache unchanged."""
    redis = _make_redis(stored=_POLICY)
    client = _make_client(503)

    await cloud_policy_poll_once(redis, CLOUD_ORIGIN, client)

    raw = redis._store.get(REDIS_POLICY_KEY)
    assert raw is not None
    assert json.loads(raw)["current_version"] == "0.8.0"


@pytest.mark.asyncio
async def test_get_cached_policy_returns_parsed_dict():
    """get_cached_policy returns the parsed policy from Redis."""
    redis = _make_redis(stored=_POLICY)
    result = await get_cached_policy(redis)
    assert result is not None
    assert result["min_version"] == "0.7.0"


@pytest.mark.asyncio
async def test_get_cached_policy_returns_none_on_empty():
    """get_cached_policy returns None when cache is empty."""
    redis = _make_redis()
    result = await get_cached_policy(redis)
    assert result is None
