"""Zugangsdaten für MediaMTX' Steuer-API (``api_zugang.py``).

Gegen echtes MediaMTX 1.19.1-pulse7 nachgefahren (2026-10-08): ohne und mit
falschen Basic-Auth-Daten 401 auf ``/v3/paths/list`` und
``/v3/config/global/patch``, mit richtigen 200 — die Zugangsdaten kommen also
tatsächlich als ``user``/``password`` beim Hook an.
"""

from __future__ import annotations

import pytest
from dcc_mediamtx_auth_hook import routes as hook_routes
from dcc_mediamtx_auth_hook.config import Settings


def _api(user: str = "", password: str = "", ip: str = "127.0.0.1") -> dict:
    return {
        "user": user,
        "password": password,
        "token": "",
        "ip": ip,
        "action": "api",
        "path": "",
        "protocol": "",
        "id": "",
        "query": "",
    }


@pytest.fixture
def mit_passwort(monkeypatch):
    s = Settings(mediamtx_api_password="geheim-123")
    monkeypatch.setattr(hook_routes, "get_settings", lambda: s)
    return s


@pytest.mark.asyncio
async def test_api_ohne_passwort_wie_bisher_offen(client):
    # Vorgabe (Cloud, Dev): kein Passwort gesetzt → api bleibt 200.
    assert (await client.post("/", json=_api())).status_code == 200


@pytest.mark.asyncio
async def test_api_mit_passwort_verlangt_zugangsdaten(client, mit_passwort):
    assert (await client.post("/", json=_api())).status_code == 401
    assert (await client.post("/", json=_api("pulse-media-svc", "falsch"))).status_code == 401
    assert (await client.post("/", json=_api("jemand", "geheim-123"))).status_code == 401
    ok = await client.post("/", json=_api("pulse-media-svc", "geheim-123"))
    assert ok.status_code == 200


@pytest.mark.asyncio
async def test_api_umgeht_die_zuschauer_drossel(client, mit_passwort):
    """Im Container kommen Zuschauer UND Poller als 127.0.0.1 an. Ein voller
    Zuschauer-Schieber darf die API nicht sperren, und die API darf ihn nicht
    füllen."""
    hook_routes._hook_zeiten.clear()
    try:
        for _ in range(hook_routes._HOOK_LIMIT + 5):
            r = await client.post("/", json=_api("pulse-media-svc", "geheim-123"))
            assert r.status_code == 200
        assert not hook_routes._hook_zeiten.get("127.0.0.1")
    finally:
        hook_routes._hook_zeiten.clear()
