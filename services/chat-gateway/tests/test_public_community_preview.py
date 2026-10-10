"""Anonyme Vorschau öffentlicher Adressen (GET /c/{handle}/public-preview).

Wie bei der Einladungs-Vorschau zählt vor allem, was die Route NICHT verrät:
keine Kennung, kein ``is_public``, und unbekannt / privat / gesperrt sehen
gleich aus.
"""

from __future__ import annotations

import random
from datetime import UTC, datetime

import pytest
from dcc_chat_gateway.models import Guild
from dcc_chat_gateway.routes import public_community_preview
from sqlalchemy import update

pytestmark = pytest.mark.usefixtures("cloud_mode")


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _community(client, _auth_signer, session_factory, handle: str, **werte) -> dict:
    uid = random.randint(1, 1_000_000)
    token = _auth_signer.issue_access(uid, f"user{uid}")
    g = (await client.post("/guilds", json={"name": "Designrunde"}, headers=_auth(token))).json()
    async with session_factory() as s:
        await s.execute(
            update(Guild)
            .where(Guild.id == int(g["id"]))
            .values(**{"handle": handle, "is_public": True, **werte})
        )
        await s.commit()
    return g


@pytest.fixture(autouse=True)
async def _bremse_leeren(app):
    async for key in app.state.redis.scan_iter("adresse:rate:*"):
        await app.state.redis.delete(key)
    yield


@pytest.mark.asyncio
async def test_liefert_name_bild_mitglieder_ohne_anmeldung(client, _auth_signer, session_factory):
    g = await _community(client, _auth_signer, session_factory, "designrunde")
    pfad = f"/api/chat/guild-icons/{g['id']}.webp?v=1"
    async with session_factory() as s:
        await s.execute(update(Guild).where(Guild.id == int(g["id"])).values(icon_url=pfad))
        await s.commit()
    r = await client.get("/c/designrunde/public-preview")
    assert r.status_code == 200, r.text
    # Kein guild.id-Feld, kein is_public; icon_url trägt die Guild-ID (Bild ist öffentlich).
    assert r.json() == {"guild": {"name": "Designrunde", "icon_url": pfad}, "member_count": 1}


@pytest.mark.asyncio
async def test_jedes_nein_sieht_gleich_aus(client, _auth_signer, session_factory):
    antworten = [await client.get("/c/gibtesnicht/public-preview")]
    await _community(client, _auth_signer, session_factory, "geheim", is_public=False)
    antworten.append(await client.get("/c/geheim/public-preview"))
    await _community(
        client, _auth_signer, session_factory, "gesperrt", suspended_at=datetime.now(UTC)
    )
    antworten.append(await client.get("/c/gesperrt/public-preview"))
    assert [a.status_code for a in antworten] == [404] * 3
    assert len({a.text for a in antworten}) == 1, [a.text for a in antworten]
    assert antworten[0].json()["detail"] == "community not found"


@pytest.mark.asyncio
async def test_zu_langer_handle_ist_422(client):
    assert (await client.get(f"/c/{'a' * 65}/public-preview")).status_code == 422


@pytest.mark.asyncio
async def test_bremse_pro_ip(client):
    for i in range(30):
        assert (await client.get(f"/c/unbek{i:04d}/public-preview")).status_code == 404
    assert (await client.get("/c/unbek9999/public-preview")).status_code == 429


@pytest.mark.asyncio
async def test_bremse_pro_handle(client, monkeypatch):
    ips = iter(f"10.0.{i // 250}.{i % 250}" for i in range(1000))
    monkeypatch.setattr(public_community_preview, "client_ip", lambda _req: next(ips))
    for _ in range(60):
        assert (await client.get("/c/gleich01/public-preview")).status_code == 404
    assert (await client.get("/c/gleich01/public-preview")).status_code == 429


@pytest.mark.asyncio
async def test_self_host_antwortet_404(client, _auth_signer, session_factory, _isolate_chat_settings):
    await _community(client, _auth_signer, session_factory, "offen")
    assert (await client.get("/c/offen/public-preview")).status_code == 200
    _isolate_chat_settings.pulse_instance_mode = "self-host"
    r = await client.get("/c/offen/public-preview")
    assert r.status_code == 404
    assert r.json()["detail"] == "community not found"
