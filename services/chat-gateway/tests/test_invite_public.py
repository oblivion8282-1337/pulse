"""Anonyme Einladungs-Vorschau (GET /invites/{code}/public-preview).

Der erste Weg, auf dem ein Abgemeldeter etwas über eine Community erfährt.
Geprüft wird deshalb vor allem, was die Route NICHT verrät: keine Kennungen,
und jedes „nein“ sieht gleich aus — sonst ließe sich der Code-Raum abtasten.
"""

from __future__ import annotations

import random
from datetime import UTC, datetime, timedelta

import pytest
from dcc_chat_gateway.models import Guild, GuildInvite
from dcc_chat_gateway.routes import invite_public
from sqlalchemy import update


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _nutzer(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"user{uid}"), uid


async def _community_mit_link(client, _auth_signer, **link) -> tuple[str, dict, str]:
    token, _ = _nutzer(_auth_signer)
    g = (await client.post("/guilds", json={"name": "Designrunde"}, headers=_auth(token))).json()
    r = await client.post(f"/guilds/{g['id']}/invites", json=link, headers=_auth(token))
    assert r.status_code == 201, r.text
    return token, g, r.json()["code"]


@pytest.fixture(autouse=True)
async def _bremse_leeren(app):
    async for key in app.state.redis.scan_iter("einladung:rate:*"):
        await app.state.redis.delete(key)
    yield


@pytest.mark.asyncio
async def test_liefert_name_bild_mitglieder_ohne_anmeldung(client, _auth_signer):
    _, _, code = await _community_mit_link(client, _auth_signer)
    r = await client.get(f"/invites/{code}/public-preview")
    assert r.status_code == 200, r.text
    # Genau diese Felder — kein guild.id-Feld, kein channel_id (der Besitzer zählt als Mitglied).
    # (Ein Bildpfad in icon_url trägt die Guild-ID, s. test_bildpfad_…)
    assert r.json() == {"guild": {"name": "Designrunde", "icon_url": None}, "member_count": 1}


@pytest.mark.asyncio
async def test_bildpfad_wird_unverändert_geliefert(client, _auth_signer, session_factory):
    # icon_url trägt die Guild-ID im Pfad; das Bild ist über /api/chat/guild-icons/…
    # ohnehin öffentlich. Die Antwort verrät also nichts Neues — festgenagelt, damit
    # das niemand wieder als „keine ID in der Antwort“ missversteht.
    _, g, code = await _community_mit_link(client, _auth_signer)
    pfad = f"/api/chat/guild-icons/{g['id']}.webp?v=1"
    async with session_factory() as s:
        await s.execute(update(Guild).where(Guild.id == int(g["id"])).values(icon_url=pfad))
        await s.commit()
    r = await client.get(f"/invites/{code}/public-preview")
    assert r.status_code == 200, r.text
    assert set(r.json()) == {"guild", "member_count"}
    assert set(r.json()["guild"]) == {"name", "icon_url"}
    assert r.json()["guild"]["icon_url"] == pfad


@pytest.mark.asyncio
async def test_jedes_nein_sieht_gleich_aus(client, _auth_signer, session_factory):
    antworten = []

    antworten.append(await client.get("/invites/unbekannt1/public-preview"))

    owner, _, code = await _community_mit_link(client, _auth_signer)
    await client.delete(f"/invites/{code}", headers=_auth(owner))
    antworten.append(await client.get(f"/invites/{code}/public-preview"))

    _, _, code = await _community_mit_link(client, _auth_signer)
    async with session_factory() as s:
        await s.execute(
            update(GuildInvite)
            .where(GuildInvite.code == code)
            .values(expires_at=datetime.now(UTC) - timedelta(minutes=1))
        )
        await s.commit()
    antworten.append(await client.get(f"/invites/{code}/public-preview"))

    _, _, code = await _community_mit_link(client, _auth_signer, max_uses=1)
    gast, _ = _nutzer(_auth_signer)
    assert (await client.post(f"/invites/{code}/accept", headers=_auth(gast))).status_code == 200
    antworten.append(await client.get(f"/invites/{code}/public-preview"))

    _, g, code = await _community_mit_link(client, _auth_signer)
    async with session_factory() as s:
        await s.execute(
            update(Guild).where(Guild.id == int(g["id"])).values(suspended_at=datetime.now(UTC))
        )
        await s.commit()
    antworten.append(await client.get(f"/invites/{code}/public-preview"))

    assert [a.status_code for a in antworten] == [404] * 5
    assert len({a.text for a in antworten}) == 1, [a.text for a in antworten]


@pytest.mark.asyncio
async def test_bremse_pro_ip(client):
    for i in range(30):
        assert (await client.get(f"/invites/unbek{i:04d}/public-preview")).status_code == 404
    assert (await client.get("/invites/unbek9999/public-preview")).status_code == 429


@pytest.mark.asyncio
async def test_bremse_pro_code(client, monkeypatch):
    ips = iter(f"10.0.{i // 250}.{i % 250}" for i in range(1000))
    monkeypatch.setattr(invite_public, "client_ip", lambda _req: next(ips))
    for _ in range(60):
        assert (await client.get("/invites/gleich01/public-preview")).status_code == 404
    assert (await client.get("/invites/gleich01/public-preview")).status_code == 429


@pytest.mark.asyncio
async def test_bremse_buendelt_ipv6_nach_64(client, monkeypatch):
    # Gleiche /64, wechselnde Hostteile: ein gemeinsamer Eimer.
    adressen = iter(f"2001:db8:1:2::{i:x}" for i in range(1, 200))
    monkeypatch.setattr(invite_public, "client_ip", lambda _req: next(adressen))
    for i in range(30):
        assert (await client.get(f"/invites/v6a{i:04d}/public-preview")).status_code == 404
    assert (await client.get("/invites/v6a9999/public-preview")).status_code == 429


@pytest.mark.asyncio
async def test_bremse_trennt_verschiedene_ipv6_64(client, monkeypatch):
    adressen = iter(f"2001:db8:1:{i:x}::1" for i in range(1, 200))
    monkeypatch.setattr(invite_public, "client_ip", lambda _req: next(adressen))
    for i in range(31):
        assert (await client.get(f"/invites/v6b{i:04d}/public-preview")).status_code == 404
