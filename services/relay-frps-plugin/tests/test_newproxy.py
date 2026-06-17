from __future__ import annotations
import pytest
from .conftest import make_auth_stub

SUB = "brave-otter-4f2a.relay.test"   # volle Subdomain (relay_base_domain = relay.test)
SLUG = "brave-otter-4f2a"
TOK = "plse_relay_good"


def _newproxy_body(user: str, subdomain: str, token: str) -> dict:
    return {"version": "0.1.0", "op": "NewProxy",
            "content": {"user": {"user": user, "metas": {"token": token}, "run_id": "r1"},
                        "proxy_name": f"{user}-chat", "proxy_type": "http",
                        "subdomain": subdomain, "metas": {"token": token}}}


@pytest.mark.asyncio
async def test_newproxy_allows_matching_subdomain(client_factory):
    plugin = await client_factory(make_auth_stub(ok_subdomain=SUB, ok_token=TOK))
    r = await plugin.post("/handler", params={"op": "NewProxy"},
                          json=_newproxy_body(SUB, SLUG, TOK))
    assert r.json() == {"reject": False, "unchange": True}


@pytest.mark.asyncio
async def test_newproxy_rejects_foreign_subdomain(client_factory):
    # Eingeloggt als SUB, will aber eine fremde Subdomain beanspruchen.
    plugin = await client_factory(make_auth_stub(ok_subdomain=SUB, ok_token=TOK))
    r = await plugin.post("/handler", params={"op": "NewProxy"},
                          json=_newproxy_body(SUB, "someone-else-9999", TOK))
    assert r.json()["reject"] is True


@pytest.mark.asyncio
async def test_newproxy_rejects_bad_token(client_factory):
    plugin = await client_factory(make_auth_stub(ok_subdomain=SUB, ok_token=TOK))
    r = await plugin.post("/handler", params={"op": "NewProxy"},
                          json=_newproxy_body(SUB, SLUG, "wrong"))
    assert r.json()["reject"] is True
