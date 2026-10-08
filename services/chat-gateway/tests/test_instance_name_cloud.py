"""Server-Name: interner Setz-Weg (Server-App) + Meldung an die Cloud (2026-10-08).

Die Server-Leiste wird aus der Cloud gebaut — ohne Meldung sah jeder, der den
Heim-Server nie geöffnet hatte, die Relay-Adresse statt des Namens.
"""

from __future__ import annotations

import json

import httpx
import pytest

from dcc_chat_gateway import instance_name as modul

from .test_permissions import _make_token, auth


@pytest.fixture
def gemeldet(monkeypatch):
    """Fängt die Cloud-Meldung ab, statt ins Netz zu gehen."""
    namen: list[str | None] = []

    async def _melde(name):
        namen.append(name)
        return True

    monkeypatch.setattr(modul, "melde_an_cloud", _melde)
    return namen


async def _warte_auf_hintergrund():
    import asyncio

    for _ in range(5):
        await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_admin_patch_meldet_namen_an_cloud(client, _auth_signer, gemeldet):
    token, _ = await _make_token(_auth_signer, is_admin=True)
    r = await client.patch("/admin/permissions", json={"instance_name": " Michaels Server "},
                           headers=auth(token))
    assert r.status_code == 200, r.text
    await _warte_auf_hintergrund()
    assert gemeldet == ["Michaels Server"]
    # Andere Felder ändern meldet nichts.
    await client.patch("/admin/permissions", json={"locked": True}, headers=auth(token))
    await _warte_auf_hintergrund()
    assert gemeldet == ["Michaels Server"]


@pytest.mark.asyncio
async def test_intern_setzen_und_lesen(client, monkeypatch, _isolate_chat_settings, gemeldet):
    monkeypatch.setattr(_isolate_chat_settings, "internal_service_secret", "s")
    h = {"X-Pulse-Internal-Secret": "s"}
    r = await client.put("/internal/instance-name", json={"name": "  Heimserver  "}, headers=h)
    assert r.status_code == 200, r.text
    assert r.json() == {"name": "Heimserver"}
    assert (await client.get("/internal/instance-name", headers=h)).json() == {"name": "Heimserver"}
    await _warte_auf_hintergrund()
    assert gemeldet == ["Heimserver"]
    # Leer = zurücksetzen.
    r = await client.put("/internal/instance-name", json={"name": ""}, headers=h)
    assert r.json() == {"name": None}


@pytest.mark.asyncio
async def test_intern_ohne_oder_mit_falschem_geheimnis_401(client, monkeypatch, _isolate_chat_settings, gemeldet):
    monkeypatch.setattr(_isolate_chat_settings, "internal_service_secret", "s")
    assert (await client.put("/internal/instance-name", json={"name": "X"})).status_code == 401
    r = await client.put("/internal/instance-name", json={"name": "X"},
                         headers={"X-Pulse-Internal-Secret": "falsch"})
    assert r.status_code == 401
    assert gemeldet == []


@pytest.mark.asyncio
async def test_meldung_an_cloud_traegt_instanz_zugangsdaten(monkeypatch, _isolate_chat_settings):
    s = _isolate_chat_settings
    monkeypatch.setattr(s, "pulse_instance_mode", "self-host")
    monkeypatch.setattr(s, "pulse_instance_id", 99084438121484288)
    monkeypatch.setattr(s, "pulse_cloud_origin", "https://cloud.example/")
    monkeypatch.setattr(s, "pulse_cloud_client_id", "ci_x")
    monkeypatch.setattr(s, "pulse_cloud_client_secret", "geheim")
    gesehen: list[httpx.Request] = []

    def antwort(req: httpx.Request) -> httpx.Response:
        gesehen.append(req)
        return httpx.Response(204)

    echt = httpx.AsyncClient
    monkeypatch.setattr(modul.httpx, "AsyncClient",
                        lambda **kw: echt(transport=httpx.MockTransport(antwort), **kw))
    assert await modul.melde_an_cloud("Michaels Server") is True
    assert str(gesehen[0].url) == "https://cloud.example/api/auth/selfhost/anzeigename"
    assert json.loads(gesehen[0].content) == {
        "instance_id": "99084438121484288", "client_id": "ci_x", "token": "geheim",
        "anzeigename": "Michaels Server",
    }


@pytest.mark.asyncio
async def test_cloud_selbst_meldet_nichts(monkeypatch, _isolate_chat_settings):
    monkeypatch.setattr(_isolate_chat_settings, "pulse_instance_mode", "cloud")
    monkeypatch.setattr(_isolate_chat_settings, "pulse_cloud_client_id", "ci_x")
    monkeypatch.setattr(_isolate_chat_settings, "pulse_cloud_client_secret", "geheim")
    assert await modul.melde_an_cloud("X") is False
