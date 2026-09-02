"""Community-Laufwerk (Etappe E8, Aufgabe 1) — Freigabe-Adresse setzen und
Status abfragen. Vorbild: ``test_ablage_abruf.py`` (Kanal-Pendant, E7).

Der Weiterreich-Weg (``GET .../ablage/abruf``) laeuft ueber genau dieselbe
SSRF-Pruefung wie beim Kanal — die volle Sicherheitsmatrix ist dort bereits
getestet, hier nur der gute Fall + Nicht-Mitglied, damit die Route selbst
(Owner-Bindung statt Ersteller-Bindung) geprueft ist.
"""

from __future__ import annotations

import random

import dcc_chat_gateway.ablage_ssrf as ablage_ssrf
import httpx
import pytest


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register_user(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


async def _guild_mit_zwei_mitgliedern(client, _auth_signer):
    t_owner, uid_owner = await _register_user(_auth_signer)
    t_mitglied, uid_mitglied = await _register_user(_auth_signer)
    t_fremd, _ = await _register_user(_auth_signer)

    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t_owner))).json()
    await client.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": str(uid_mitglied)},
        headers=auth(t_owner),
    )
    return t_owner, t_mitglied, t_fremd, g["id"]


@pytest.mark.asyncio
async def test_nur_besitzer_darf_setzen(client, _auth_signer):
    t_owner, t_mitglied, _, gid = await _guild_mit_zwei_mitgliedern(client, _auth_signer)

    r = await client.put(
        f"/guilds/{gid}/ablage/laufwerk",
        json={"freigabe_adresse": "https://cloud.example/pub"},
        headers=auth(t_mitglied),
    )
    assert r.status_code == 403
    assert "cloud.example" not in r.text

    r = await client.put(
        f"/guilds/{gid}/ablage/laufwerk",
        json={"freigabe_adresse": "https://cloud.example/pub"},
        headers=auth(t_owner),
    )
    assert r.status_code == 204


@pytest.mark.asyncio
async def test_adresse_wird_nie_gespiegelt(client, _auth_signer):
    t_owner, _, _, gid = await _guild_mit_zwei_mitgliedern(client, _auth_signer)
    r = await client.put(
        f"/guilds/{gid}/ablage/laufwerk",
        json={"freigabe_adresse": "https://geheim.example/pub"},
        headers=auth(t_owner),
    )
    assert r.status_code == 204
    assert r.text == "" or "geheim.example" not in r.text


@pytest.mark.asyncio
async def test_status_zeigt_nur_ja_nein(client, _auth_signer):
    t_owner, t_mitglied, t_fremd, gid = await _guild_mit_zwei_mitgliedern(client, _auth_signer)

    r = await client.get(f"/guilds/{gid}/ablage/laufwerk/status", headers=auth(t_mitglied))
    assert r.status_code == 200
    assert r.json() == {"verbunden": False}

    await client.put(
        f"/guilds/{gid}/ablage/laufwerk",
        json={"freigabe_adresse": "https://cloud.example/pub"},
        headers=auth(t_owner),
    )

    r = await client.get(f"/guilds/{gid}/ablage/laufwerk/status", headers=auth(t_mitglied))
    assert r.json() == {"verbunden": True}
    assert "cloud.example" not in r.text

    r = await client.get(f"/guilds/{gid}/ablage/laufwerk/status", headers=auth(t_fremd))
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_ersetzen_erlaubt_nur_dem_aktuellen_besitzer(client, _auth_signer):
    t_owner, t_mitglied, _, gid = await _guild_mit_zwei_mitgliedern(client, _auth_signer)
    await client.put(
        f"/guilds/{gid}/ablage/laufwerk",
        json={"freigabe_adresse": "https://cloud.example/pub"},
        headers=auth(t_owner),
    )
    r = await client.put(
        f"/guilds/{gid}/ablage/laufwerk",
        json={"freigabe_adresse": "https://cloud.example/pub2"},
        headers=auth(t_owner),
    )
    assert r.status_code == 204


@pytest.fixture
def kein_dns(monkeypatch):
    async def _resolver(host: str) -> list[str]:
        if host != "cloud.example":
            raise OSError(f"unerwarteter Host im Test: {host}")
        return ["203.0.113.10"]

    monkeypatch.setattr(ablage_ssrf, "standard_resolver", _resolver)
    return _resolver


@pytest.fixture
def upstream(monkeypatch):
    zustand: dict[str, object] = {}

    def _ctor(*args, **kwargs):
        kwargs.pop("transport", None)
        return httpx.AsyncClient(
            *args, transport=httpx.MockTransport(zustand["handler"]), **kwargs
        )

    monkeypatch.setattr(ablage_ssrf, "client_ctor", _ctor)

    def setze(handler) -> None:
        zustand["handler"] = handler

    return setze


@pytest.mark.asyncio
async def test_abruf_reicht_chiffrat_durch(client, _auth_signer, kein_dns, upstream):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["host"] == "cloud.example"
        return httpx.Response(200, content=b"chiffrat-bytes")

    upstream(handler)
    t_owner, t_mitglied, t_fremd, gid = await _guild_mit_zwei_mitgliedern(client, _auth_signer)
    await client.put(
        f"/guilds/{gid}/ablage/laufwerk",
        json={"freigabe_adresse": "https://cloud.example/pub"},
        headers=auth(t_owner),
    )

    r = await client.get(
        f"/guilds/{gid}/ablage/abruf", params={"pfad": "x"}, headers=auth(t_mitglied)
    )
    assert r.status_code == 200
    assert r.content == b"chiffrat-bytes"

    r = await client.get(
        f"/guilds/{gid}/ablage/abruf", params={"pfad": "x"}, headers=auth(t_fremd)
    )
    assert r.status_code == 403
