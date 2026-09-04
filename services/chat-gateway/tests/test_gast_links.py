"""Gast-Links: erzeugen, beitreten, entwerten — und die Riegel.

Der wichtigste Teil dieser Datei sind nicht die Erfolgspfade, sondern
``test_gast_ticket_oeffnet_keine_normale_route``: ein Gast erscheint in keinem
Rechte-Resolver, und ein fehlender ``typ``-Check auf irgendeiner Route machte
aus ihm einen Vollnutzer mit synthetischer ID. Der Riegel steht zentral
(``_decode_cloud_token`` verlangt ``typ == "access"``); dieser Test hält ihn
fest, damit ein späterer „nimm hier auch Gäste an"-Handgriff auffällt.
"""

from __future__ import annotations

import random
from datetime import UTC, datetime, timedelta

import pytest

from dcc_chat_gateway.models import CHANNEL_TYPE_VOICE, GuestLink


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _guild(client, token: str, name: str = "firma") -> int:
    r = await client.post("/guilds", json={"name": name}, headers=_auth(token))
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _voice_channel(client, token: str, guild_id: int, name: str = "besprechung") -> int:
    r = await client.post(
        f"/guilds/{guild_id}/channels",
        json={"name": name, "type": CHANNEL_TYPE_VOICE},
        headers=_auth(token),
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _owner(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


@pytest.fixture(autouse=True)
def _ticket_stub(monkeypatch, _auth_signer):
    """auth-svc steht im Test nicht — das Ticket hier selbst signieren.

    Bewusst mit DEMSELBEN Signierer, den auch die Produktion benutzt (die
    Test-JWKS ist im chat-gateway installiert): so prüft der Riegel-Test unten
    eine echte Signatur und nicht eine Attrappe, die alles durchliesse.
    """
    from dcc_chat_gateway import gaeste

    async def _fake(*, gast_id, guild_id, channel_id, name, ttl_s, http=None):
        token = _auth_signer.issue_gast(
            gast_id=gast_id,
            guild_id=str(guild_id),
            channel_id=str(channel_id),
            name=name,
            ttl_s=ttl_s,
        )
        return token, ttl_s

    monkeypatch.setattr(gaeste, "ticket_holen", _fake)


@pytest.mark.asyncio
async def test_link_erzeugen_und_beitreten(client, _auth_signer):
    token, _ = _owner(_auth_signer)
    gid = await _guild(client, token)
    cid = await _voice_channel(client, token, gid)

    r = await client.post(f"/channels/{cid}/guest-links", json={}, headers=_auth(token))
    assert r.status_code == 200, r.text
    code = r.json()["code"]
    assert code, "der Code kommt genau einmal — in dieser Antwort"

    info = await client.get(f"/gast/{code}")
    assert info.status_code == 200
    assert info.json()["channel_name"] == "besprechung"

    bei = await client.post(f"/gast/{code}/beitritt", json={"name": "Frau Meier"})
    assert bei.status_code == 200, bei.text
    daten = bei.json()
    assert daten["gast_id"].startswith("gast-")
    assert daten["channel_id"] == str(cid)
    assert daten["ticket"]


@pytest.mark.asyncio
async def test_liste_liefert_den_code_nie_nach(client, _auth_signer):
    token, _ = _owner(_auth_signer)
    gid = await _guild(client, token)
    cid = await _voice_channel(client, token, gid)
    await client.post(f"/channels/{cid}/guest-links", json={}, headers=_auth(token))

    r = await client.get(f"/guilds/{gid}/guest-links", headers=_auth(token))
    assert r.status_code == 200
    assert len(r.json()) == 1
    # In der Datenbank steht nur der Hash — die Liste KANN ihn nicht zeigen.
    assert r.json()[0]["code"] is None


@pytest.mark.asyncio
async def test_ohne_move_members_kein_link(client, _auth_signer):
    besitzer, _ = _owner(_auth_signer)
    gid = await _guild(client, besitzer)
    cid = await _voice_channel(client, besitzer, gid)
    # Zweiter Nutzer tritt bei (über den Einladungscode) und hat @everyone-Rechte,
    # also kein MOVE_MEMBERS.
    inv = await client.post(f"/guilds/{gid}/invites", json={}, headers=_auth(besitzer))
    assert inv.status_code in (200, 201), inv.text
    code = inv.json()["code"]
    fremd, _ = _owner(_auth_signer)
    beitritt = await client.post(f"/invites/{code}/accept", headers=_auth(fremd))
    assert beitritt.status_code in (200, 201), beitritt.text

    r = await client.post(f"/channels/{cid}/guest-links", json={}, headers=_auth(fremd))
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_abgelaufen_entwertet_und_unbekannt_antworten_gleich(
    client, _auth_signer, session_factory
):
    token, _ = _owner(_auth_signer)
    gid = await _guild(client, token)
    cid = await _voice_channel(client, token, gid)
    r = await client.post(f"/channels/{cid}/guest-links", json={}, headers=_auth(token))
    code = r.json()["code"]
    link_id = int(r.json()["id"])

    # abgelaufen
    async with session_factory() as s:
        link = await s.get(GuestLink, link_id)
        link.expires_at = datetime.now(UTC) - timedelta(minutes=1)
        await s.commit()
    assert (await client.get(f"/gast/{code}")).status_code == 404
    assert (await client.get("/gast/gibtesnicht")).status_code == 404

    # entwertet (und wieder gültig gemacht, damit nur der Widerruf zählt)
    async with session_factory() as s:
        link = await s.get(GuestLink, link_id)
        link.expires_at = datetime.now(UTC) + timedelta(hours=1)
        link.revoked_at = datetime.now(UTC)
        await s.commit()
    assert (await client.get(f"/gast/{code}")).status_code == 404


@pytest.mark.asyncio
async def test_entwerten_sperrt_laufende_gaeste(client, _auth_signer, app):
    token, _ = _owner(_auth_signer)
    gid = await _guild(client, token)
    cid = await _voice_channel(client, token, gid)
    r = await client.post(f"/channels/{cid}/guest-links", json={}, headers=_auth(token))
    code, link_id = r.json()["code"], r.json()["id"]
    bei = await client.post(f"/gast/{code}/beitritt", json={"name": "Gast"})
    gast_id = bei.json()["gast_id"]

    weg = await client.delete(f"/guest-links/{link_id}", headers=_auth(token))
    assert weg.status_code == 204

    from dcc_shared import gaeste as geteilt

    assert await geteilt.ist_gesperrt(app.state.redis, gast_id) is True
    # ... und die gesperrte Kennung kommt an keiner Gast-Route mehr durch.
    ticket = bei.json()["ticket"]
    nochmal = await client.get("/gast/sitzung/stream-state", headers=_auth(ticket))
    assert nochmal.status_code == 403


@pytest.mark.asyncio
async def test_ticket_ist_an_seinen_kanal_gebunden(client, _auth_signer):
    """Ein Ticket für Kanal A darf Kanal B nicht öffnen.

    Hier über ``/gast/whep`` geprüft, das den Kanal aus dem Claim nimmt: der
    Gast kann gar keinen anderen angeben. Der Gegenbeweis liegt in
    voice-signaling (``test_gast_token.py``), wo der Kanal im Rumpf steht und
    abweichen KANN.
    """
    token, _ = _owner(_auth_signer)
    gid = await _guild(client, token)
    cid = await _voice_channel(client, token, gid)
    r = await client.post(f"/channels/{cid}/guest-links", json={}, headers=_auth(token))
    bei = await client.post(f"/gast/{r.json()['code']}/beitritt", json={"name": "G"})
    ticket = bei.json()["ticket"]

    stand = await client.get("/gast/sitzung/stream-state", headers=_auth(ticket))
    assert stand.status_code == 200
    assert stand.json() == {"stream_states": []}


@pytest.mark.asyncio
async def test_gast_ticket_oeffnet_keine_normale_route(client, _auth_signer):
    """Der Riegel: ein Gast-Ticket ist überall sonst wertlos.

    Wenn dieser Test rot wird, ist irgendwo ein „oder Gast" in eine
    Nutzer-Abhängigkeit gerutscht — und damit ein Gast zum Vollnutzer geworden.
    """
    token, _ = _owner(_auth_signer)
    gid = await _guild(client, token)
    cid = await _voice_channel(client, token, gid)
    r = await client.post(f"/channels/{cid}/guest-links", json={}, headers=_auth(token))
    bei = await client.post(f"/gast/{r.json()['code']}/beitritt", json={"name": "G"})
    ticket = bei.json()["ticket"]

    for methode, pfad in (
        ("get", "/guilds"),
        ("get", f"/channels/{cid}"),
        ("get", f"/guilds/{gid}/members"),
        ("post", f"/channels/{cid}/stream-token"),
        ("get", f"/guilds/{gid}/guest-links"),
        ("post", f"/channels/{cid}/guest-links"),
    ):
        aufruf = getattr(client, methode)
        antwort = await (
            aufruf(pfad, headers=_auth(ticket), json={})
            if methode == "post"
            else aufruf(pfad, headers=_auth(ticket))
        )
        assert antwort.status_code == 401, f"{methode.upper()} {pfad} liess ein Gast-Ticket durch"


@pytest.mark.asyncio
async def test_link_in_seiner_letzten_minute_wird_nicht_mehr_eingeloest(
    client, _auth_signer, session_factory
):
    """Ein Ticket darf den Link nicht überleben.

    ``ticket_holen`` hebt jede Laufzeit unter einer Minute auf diese
    Untergrenze an (auth-svc nimmt darunter nichts an) — ein Link mit zehn
    Sekunden Restlaufzeit erzeugte damit einen Gast, der ihn um fünfzig
    Sekunden überlebt. Für den Beitretenden ist das dasselbe wie abgelaufen,
    also dieselbe Antwort.
    """
    token, _ = _owner(_auth_signer)
    gid = await _guild(client, token)
    cid = await _voice_channel(client, token, gid)
    r = await client.post(f"/channels/{cid}/guest-links", json={}, headers=_auth(token))
    code, link_id = r.json()["code"], int(r.json()["id"])

    async with session_factory() as s:
        link = await s.get(GuestLink, link_id)
        link.expires_at = datetime.now(UTC) + timedelta(seconds=10)
        await s.commit()

    # Die Vorschau zeigt ihn noch — er lebt ja.
    assert (await client.get(f"/gast/{code}")).status_code == 200
    # Einlösen nicht mehr.
    bei = await client.post(f"/gast/{code}/beitritt", json={"name": "Zuspaet"})
    assert bei.status_code == 404


@pytest.mark.asyncio
async def test_geloeschter_kanal_nimmt_seine_gast_links_mit(
    client, _auth_signer, session_factory
):
    """Sonst bliebe der Link bis zu seinem Ablauf als Karteileiche stehen.

    Hereinkommen könnte damit ohnehin niemand mehr (der Beitritt scheitert,
    sobald der Kanal fehlt) — aber er stünde weiter in der Liste des
    Gastgebers und zeigte auf einen Kanal, den es nicht mehr gibt.
    """
    token, _ = _owner(_auth_signer)
    gid = await _guild(client, token)
    cid = await _voice_channel(client, token, gid)
    r = await client.post(f"/channels/{cid}/guest-links", json={}, headers=_auth(token))
    link_id = int(r.json()["id"])

    weg = await client.delete(f"/channels/{cid}", headers=_auth(token))
    assert weg.status_code == 204
    async with session_factory() as s:
        assert await s.get(GuestLink, link_id) is None


@pytest.mark.asyncio
async def test_geloeschte_community_nimmt_ihre_gast_links_mit(
    client, _auth_signer, session_factory
):
    token, _ = _owner(_auth_signer)
    gid = await _guild(client, token)
    cid = await _voice_channel(client, token, gid)
    r = await client.post(f"/channels/{cid}/guest-links", json={}, headers=_auth(token))
    link_id = int(r.json()["id"])

    weg = await client.delete(f"/guilds/{gid}", headers=_auth(token))
    assert weg.status_code == 204
    async with session_factory() as s:
        assert await s.get(GuestLink, link_id) is None


@pytest.mark.asyncio
async def test_link_erzeugen_ist_gebremst(client, _auth_signer):
    """Jeder Aufruf schreibt eine Zeile — ein durchgedrehtes Skript sonst viele.

    Die Bremse steht nicht gegen den Menschen (``MOVE_MEMBERS`` hält nur, wem
    man ohnehin vertraut), sondern gegen die unbegrenzte Zeilenzahl.
    """
    token, _ = _owner(_auth_signer)
    gid = await _guild(client, token)
    cid = await _voice_channel(client, token, gid)
    codes = set()
    for _ in range(20):
        r = await client.post(f"/channels/{cid}/guest-links", json={}, headers=_auth(token))
        assert r.status_code == 200, r.text
        codes.add(r.json()["code"])
    # 20 verschiedene Codes — der Zufall wiederholt sich nicht.
    assert len(codes) == 20
    zuviel = await client.post(f"/channels/{cid}/guest-links", json={}, headers=_auth(token))
    assert zuviel.status_code == 429
