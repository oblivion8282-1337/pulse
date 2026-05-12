"""Test fixtures for the MediaMTX auth hook.

Uses a real Redis at REDIS_URL but on index ``/1`` for isolation (matches the
project convention for the other services' integration tests). Each test uses a
unique token / channel-id so cross-test pollution is impossible.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from urllib.parse import urlsplit, urlunsplit

import httpx
import pytest
import pytest_asyncio
from redis.asyncio import Redis


def _test_redis_url() -> str:
    base = os.environ.get("REDIS_URL", "redis://localhost:6380/0")
    parts = urlsplit(base)
    # Force db index 1 for test isolation.
    return urlunsplit((parts.scheme, parts.netloc, "/1", parts.query, parts.fragment))


import dcc_mediamtx_auth_hook.config as hook_cfg  # noqa: E402
from dcc_mediamtx_auth_hook.app import create_app  # noqa: E402

_TEST_SETTINGS = hook_cfg.Settings(redis_url=_test_redis_url())


@pytest.fixture(autouse=True)
def _isolate_settings():
    hook_cfg.get_settings.cache_clear()

    def _provider() -> hook_cfg.Settings:
        return _TEST_SETTINGS

    original = hook_cfg.get_settings
    hook_cfg.get_settings = _provider  # type: ignore[assignment]
    import dcc_mediamtx_auth_hook.routes as hook_routes

    hook_routes.get_settings = _provider  # type: ignore[assignment]
    yield _TEST_SETTINGS
    hook_cfg.get_settings = original  # type: ignore[assignment]
    hook_cfg.get_settings.cache_clear()


@pytest_asyncio.fixture
async def redis() -> AsyncIterator[Redis]:
    r = Redis.from_url(_TEST_SETTINGS.redis_url, decode_responses=False)
    yield r
    await r.aclose()


@pytest_asyncio.fixture
async def app(_isolate_settings, redis):
    application = create_app(skip_redis=True)
    application.state.redis = redis
    return application


@pytest_asyncio.fixture
async def client(app) -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
