"""Tests for crl_poller.py (DE 9 + DE 10 Block 1.G).

Coverage:
1. 200 response with cert_ids → Redis set replaced, validation-cache cleared
2. 304 Not Modified → Redis pipeline not called
3. ETag from 200 is persisted; next request sends If-None-Match header
4. HTTP 500 error → fail-soft, Redis unchanged
5. Network error (ConnectTimeout) → fail-soft, Redis unchanged
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from dcc_chat_gateway.crl_poller import (
    REDIS_CRL_ETAG_KEY,
    REDIS_REVOKED_SET,
    REDIS_VALID_CERT_PREFIX,
    crl_poll_once,
)

CLOUD_ORIGIN = "https://pulse.unicutmedia.com"
CRL_URL = f"{CLOUD_ORIGIN}/.well-known/revoked-credentials"


def _make_redis(*, etag: str | None = None) -> AsyncMock:
    """Build a Redis mock that records pipeline calls for assertions."""
    redis = AsyncMock()
    _store: dict[str, bytes | None] = {}
    if etag:
        _store[REDIS_CRL_ETAG_KEY] = etag.encode()

    async def _get(key):
        return _store.get(key)

    pipeline_calls: list[tuple[str, tuple]] = []

    def _make_pipeline():
        pipeline_mock = MagicMock()

        def _pipe_delete(key):
            pipeline_calls.append(("delete", (key,)))
            return pipeline_mock

        def _pipe_sadd(key, *members):
            pipeline_calls.append(("sadd", (key, *members)))
            return pipeline_mock

        def _pipe_set(key, value):
            pipeline_calls.append(("set", (key, value)))
            return pipeline_mock

        async def _pipe_execute():
            return []

        pipeline_mock.delete = _pipe_delete
        pipeline_mock.sadd = _pipe_sadd
        pipeline_mock.set = _pipe_set
        pipeline_mock.execute = _pipe_execute
        return pipeline_mock

    redis.get = _get
    redis.pipeline = MagicMock(side_effect=_make_pipeline)
    redis._store = _store
    redis._pipeline_calls = pipeline_calls
    return redis


def _make_response(status: int, body: dict | None = None, etag: str | None = None) -> MagicMock:
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status
    resp.headers = {}
    if etag:
        resp.headers["ETag"] = etag
    if body is not None:
        resp.json = MagicMock(return_value=body)
    if status >= 400:
        resp.raise_for_status = MagicMock(
            side_effect=httpx.HTTPStatusError(
                "error", request=MagicMock(), response=resp
            )
        )
    else:
        resp.raise_for_status = MagicMock()
    return resp


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_200_updates_redis():
    """200 response with cert_ids → Redis set replaced and cache cleared."""
    cert_ids = ["uuid-1", "uuid-2"]
    mock_resp = _make_response(200, body={"version": 1, "cert_ids": cert_ids}, etag='"abc123"')
    mock_client = AsyncMock()
    mock_client.get = AsyncMock(return_value=mock_resp)

    redis = _make_redis()
    await crl_poll_once(redis, CLOUD_ORIGIN, mock_client)

    calls = redis._pipeline_calls
    ops = [c[0] for c in calls]
    assert "delete" in ops, f"Expected 'delete' in pipeline calls: {ops}"
    assert "sadd" in ops, f"Expected 'sadd' in pipeline calls: {ops}"

    # Validation cache invalidation for each cert_id
    deleted_keys = [c[1][0] for c in calls if c[0] == "delete"]
    assert f"{REDIS_VALID_CERT_PREFIX}uuid-1" in deleted_keys
    assert f"{REDIS_VALID_CERT_PREFIX}uuid-2" in deleted_keys


@pytest.mark.asyncio
async def test_304_does_not_update_redis():
    """304 Not Modified → Redis pipeline never called."""
    mock_resp = _make_response(304)
    mock_resp.raise_for_status = MagicMock()
    mock_client = AsyncMock()
    mock_client.get = AsyncMock(return_value=mock_resp)

    redis = _make_redis(etag='"old-etag"')
    await crl_poll_once(redis, CLOUD_ORIGIN, mock_client)

    assert redis._pipeline_calls == []


@pytest.mark.asyncio
async def test_etag_stored_after_200():
    """ETag from a 200 response is stored in Redis for next request."""
    new_etag = '"fresh-etag"'
    cert_ids = ["uuid-99"]
    mock_resp = _make_response(200, body={"version": 1, "cert_ids": cert_ids}, etag=new_etag)
    mock_client = AsyncMock()
    mock_client.get = AsyncMock(return_value=mock_resp)

    redis = _make_redis()
    await crl_poll_once(redis, CLOUD_ORIGIN, mock_client)

    etag_stores = [
        c for c in redis._pipeline_calls
        if c[0] == "set" and c[1][0] == REDIS_CRL_ETAG_KEY
    ]
    assert etag_stores, "ETag not stored in Redis"
    assert etag_stores[0][1][1] == new_etag


@pytest.mark.asyncio
async def test_if_none_match_sent_when_etag_cached():
    """If Redis has a cached ETag, it's sent as If-None-Match."""
    cached_etag = '"existing-etag"'
    mock_resp = _make_response(304)
    mock_resp.raise_for_status = MagicMock()
    mock_client = AsyncMock()
    mock_client.get = AsyncMock(return_value=mock_resp)

    redis = _make_redis(etag=cached_etag)
    await crl_poll_once(redis, CLOUD_ORIGIN, mock_client)

    # Check that the get call included If-None-Match
    call_kwargs = mock_client.get.call_args.kwargs
    sent_headers = call_kwargs.get("headers", {})
    assert sent_headers.get("If-None-Match") == cached_etag


@pytest.mark.asyncio
async def test_http_error_fail_soft():
    """HTTP 500 → no exception raised, Redis unchanged."""
    mock_resp = _make_response(500)
    mock_client = AsyncMock()
    mock_client.get = AsyncMock(return_value=mock_resp)

    redis = _make_redis()
    # Must not raise
    await crl_poll_once(redis, CLOUD_ORIGIN, mock_client)

    assert redis._pipeline_calls == []


@pytest.mark.asyncio
async def test_network_error_fail_soft():
    """Network timeout → no exception raised, Redis unchanged."""
    mock_client = AsyncMock()
    mock_client.get = AsyncMock(side_effect=httpx.ConnectTimeout("timed out"))

    redis = _make_redis()
    await crl_poll_once(redis, CLOUD_ORIGIN, mock_client)

    assert redis._pipeline_calls == []
