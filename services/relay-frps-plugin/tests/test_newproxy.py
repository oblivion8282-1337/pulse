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


# --- Hijack-Schutz (Security-Audit 2026-09-16) -----------------------------
# Ein authentifizierter Tenant darf NUR den eigenen Slug als vhost registrieren
# — custom_domains (fremde Domains in den eigenen Tunnel), Nicht-http(s)-
# Proxotypes und remote_port (beliebige Ports auf dem frps-Host) werden
# hart abgelehnt, BEVOR die Token-Validierung überhaupt läuft.

@pytest.mark.asyncio
async def test_newproxy_rejects_custom_domains(client_factory):
    plugin = await client_factory(make_auth_stub(ok_subdomain=SUB, ok_token=TOK))
    body = _newproxy_body(SUB, SLUG, TOK)
    body["content"]["custom_domains"] = ["fremde.tld", "auch-mein.example"]
    r = await plugin.post("/handler", params={"op": "NewProxy"}, json=body)
    assert r.json()["reject"] is True


@pytest.mark.asyncio
async def test_newproxy_rejects_tcp_proxy_type(client_factory):
    plugin = await client_factory(make_auth_stub(ok_subdomain=SUB, ok_token=TOK))
    body = _newproxy_body(SUB, SLUG, TOK)
    body["content"]["proxy_type"] = "tcp"
    r = await plugin.post("/handler", params={"op": "NewProxy"}, json=body)
    assert r.json()["reject"] is True


@pytest.mark.asyncio
async def test_newproxy_rejects_remote_port(client_factory):
    plugin = await client_factory(make_auth_stub(ok_subdomain=SUB, ok_token=TOK))
    body = _newproxy_body(SUB, SLUG, TOK)
    body["content"]["remote_port"] = 7000
    r = await plugin.post("/handler", params={"op": "NewProxy"}, json=body)
    assert r.json()["reject"] is True


@pytest.mark.asyncio
async def test_newproxy_allows_remote_port_zero(client_factory):
    # frps setzt remote_port für reine vhost-Proxies auf 0 — das ist die
    # erlaubte Form und darf (bei korrektem Slug+Token) weiterhin durchgehen.
    plugin = await client_factory(make_auth_stub(ok_subdomain=SUB, ok_token=TOK))
    body = _newproxy_body(SUB, SLUG, TOK)
    body["content"]["remote_port"] = 0
    r = await plugin.post("/handler", params={"op": "NewProxy"}, json=body)
    assert r.json() == {"reject": False, "unchange": True}
