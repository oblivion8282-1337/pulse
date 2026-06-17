from __future__ import annotations
import pytest
from .conftest import make_auth_stub

SUB = "brave-otter-4f2a.relay.test"
TOK = "plse_relay_good"


def _login_body(user: str, token: str) -> dict:
    return {"version": "0.1.0", "op": "Login",
            "content": {"version": "0.58.0", "hostname": "h", "os": "linux",
                        "arch": "amd64", "user": user, "timestamp": 0,
                        "privilege_key": "", "run_id": "r1", "pool_count": 1,
                        "metas": {"token": token}, "client_address": "1.2.3.4:5"}}


@pytest.mark.asyncio
async def test_login_allows_valid(client_factory):
    plugin = await client_factory(make_auth_stub(ok_subdomain=SUB, ok_token=TOK))
    r = await plugin.post("/handler", params={"op": "Login"}, json=_login_body(SUB, TOK))
    assert r.status_code == 200
    assert r.json() == {"reject": False, "unchange": True}


@pytest.mark.asyncio
async def test_login_rejects_wrong_token(client_factory):
    plugin = await client_factory(make_auth_stub(ok_subdomain=SUB, ok_token=TOK))
    r = await plugin.post("/handler", params={"op": "Login"}, json=_login_body(SUB, "wrong"))
    assert r.json()["reject"] is True


@pytest.mark.asyncio
async def test_login_fail_closed_on_auth_error(client_factory):
    import httpx
    def boom(_req): raise httpx.ConnectError("auth down")
    plugin = await client_factory(httpx.MockTransport(boom))
    r = await plugin.post("/handler", params={"op": "Login"}, json=_login_body(SUB, TOK))
    assert r.json()["reject"] is True
