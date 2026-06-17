from __future__ import annotations
from collections.abc import AsyncIterator

import httpx
import pytest
import pytest_asyncio

import dcc_relay_frps_plugin.config as cfg
from dcc_relay_frps_plugin.app import create_app

_TEST_SETTINGS = cfg.Settings(
    auth_svc_url="http://auth.test",
    internal_service_secret="s3cr3t",
    relay_base_domain="relay.test",
)


@pytest.fixture(autouse=True)
def _isolate_settings():
    cfg.get_settings.cache_clear()

    def _provider() -> cfg.Settings:
        return _TEST_SETTINGS

    original = cfg.get_settings
    cfg.get_settings = _provider  # type: ignore[assignment]
    import dcc_relay_frps_plugin.routes as routes
    routes.get_settings = _provider  # type: ignore[assignment]
    yield _TEST_SETTINGS
    cfg.get_settings = original  # type: ignore[assignment]
    cfg.get_settings.cache_clear()


def make_auth_stub(*, ok_subdomain: str, ok_token: str, status_ok: int = 200):
    """httpx.MockTransport, das /selfhost/relay/auth nachbildet."""
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path != "/selfhost/relay/auth":
            return httpx.Response(404)
        if request.headers.get("x-pulse-internal-secret") != "s3cr3t":
            return httpx.Response(401)
        body = httpx.Response  # noqa: F841
        import json
        data = json.loads(request.content)
        if data.get("subdomain") == ok_subdomain and data.get("token") == ok_token:
            return httpx.Response(status_ok, json={"instance_id": "1", "subdomain": ok_subdomain})
        return httpx.Response(401)
    return httpx.MockTransport(handler)


@pytest_asyncio.fixture
async def client_factory(_isolate_settings) -> AsyncIterator:
    created: list[httpx.AsyncClient] = []

    async def _make(transport: httpx.MockTransport) -> httpx.AsyncClient:
        http = httpx.AsyncClient(transport=transport, base_url="http://auth.test")
        created.append(http)
        app = create_app(http_client=http)
        plugin = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://plugin")
        created.append(plugin)
        return plugin

    yield _make
    for c in created:
        await c.aclose()
