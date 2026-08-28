"""Der Poller, der die Cloud-Schlüssel warmhält.

Fail-open ist die wichtigste Eigenschaft: Ist die Cloud weg, bleibt der zuletzt
bekannte Stand stehen. Ein Cloud-Ausfall darf keinen Self-Host lahmlegen.
"""

from __future__ import annotations

import httpx
import pytest

from dcc_chat_gateway.jwks_poller import REDIS_CLOUD_JWKS_KEY, hole_cloud_jwks


class FakeRedis:
    def __init__(self, start: dict | None = None):
        self.werte = dict(start or {})

    async def set(self, key, value):
        self.werte[key] = value
        return True


@pytest.mark.asyncio
async def test_holt_und_legt_ab():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text='{"keys":[]}')

    r = FakeRedis()
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as k:
        await hole_cloud_jwks(r, "https://howispulse.com", k)
    assert r.werte[REDIS_CLOUD_JWKS_KEY] == '{"keys":[]}'


@pytest.mark.asyncio
async def test_cloud_weg_laesst_den_bestand_stehen():
    """Fail-open. Wuerde der Poller den Schluessel loeschen, liesse der Server
    niemanden mehr herein, sobald die Cloud kurz hustet."""

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("weg")

    r = FakeRedis({REDIS_CLOUD_JWKS_KEY: '{"keys":["alt"]}'})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as k:
        await hole_cloud_jwks(r, "https://howispulse.com", k)
    assert r.werte[REDIS_CLOUD_JWKS_KEY] == '{"keys":["alt"]}'


@pytest.mark.asyncio
async def test_fehlerantwort_laesst_den_bestand_ebenfalls_stehen():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503)

    r = FakeRedis({REDIS_CLOUD_JWKS_KEY: '{"keys":["alt"]}'})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as k:
        await hole_cloud_jwks(r, "https://howispulse.com", k)
    assert r.werte[REDIS_CLOUD_JWKS_KEY] == '{"keys":["alt"]}'
