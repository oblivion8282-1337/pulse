"""Tests für Standplatz-Geräte — Eintragen, Sehen, Umstellen, Entfernen.

Ein Gerät ist ein Rechner, der in einem Sprachkanal steht, ohne dort Teilnehmer
zu sein (``docs/plans/2026-08-14-fernsteuerung-unbeaufsichtigte-geraete.md``).
Geprüft wird hier vor allem das, was die Oberfläche NICHT retten kann: die
Sicht-Schranke, die Eindeutigkeiten und der Abbau beim Standplatzwechsel.
"""

from __future__ import annotations

import uuid

import pytest
from dcc_chat_gateway.models import CHANNEL_TYPE_VOICE, PermissionOverwrite
from dcc_shared.permissions import Permissions


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _make_token(signer) -> tuple[str, int]:
    uid = abs(hash(uuid.uuid4())) & ((1 << 31) - 1)
    return signer.issue_access(uid, f"u{uid}"), uid


async def _guild(client, token: str, name: str = "werkstatt") -> int:
    r = await client.post("/guilds", json={"name": name}, headers=_auth(token))
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _voice_channel(client, token: str, guild_id: int, name: str = "werkbank") -> int:
    r = await client.post(
        f"/guilds/{guild_id}/channels",
        json={"name": name, "type": CHANNEL_TYPE_VOICE},
        headers=_auth(token),
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _register(client):
    """Das Geräte-Register sitzt am ConnectionManager der Test-App — es ist
    damit je Test frisch, ohne Aufräum-Fixture."""
    return client._transport.app.state.connection_manager


@pytest.mark.asyncio
async def test_geraet_eintragen_und_wiederfinden(client, _auth_signer):
    token, uid = await _make_token(_auth_signer)
    gid = await _guild(client, token)
    cid = await _voice_channel(client, token, gid)

    r = await client.post(
        f"/guilds/{gid}/devices",
        json={"channel_id": str(cid), "name": "werkstatt-pc"},
        headers=_auth(token),
    )
    assert r.status_code == 201, r.text
    device = r.json()
    assert device["name"] == "werkstatt-pc"
    assert device["owner_user_id"] == str(uid)
    assert device["channel_id"] == str(cid)
    # Ohne Anmeldung über die WebSocket ist ein eingetragenes Gerät offline —
    # die Zeile sagt, DASS es das Gerät gibt, nicht dass es läuft.
    assert device["state"] == "offline"

    r = await client.get(f"/guilds/{gid}/devices", headers=_auth(token))
    assert r.status_code == 200
    assert [d["id"] for d in r.json()] == [device["id"]]


@pytest.mark.asyncio
async def test_name_wird_vereinheitlicht_und_geprueft(client, _auth_signer):
    """Grossschreibung wird gesenkt (sonst wären ``PC`` und ``pc`` zwei Zeilen,
    die in jeder Liste gleich aussehen), Leerzeichen abgelehnt (ein Gerät soll
    nicht wie ein Mensch heissen können)."""
    token, _ = await _make_token(_auth_signer)
    gid = await _guild(client, token)
    cid = await _voice_channel(client, token, gid)

    r = await client.post(
        f"/guilds/{gid}/devices",
        json={"channel_id": str(cid), "name": "Werkstatt-PC"},
        headers=_auth(token),
    )
    assert r.status_code == 201, r.text
    assert r.json()["name"] == "werkstatt-pc"

    r = await client.post(
        f"/guilds/{gid}/devices",
        json={"channel_id": str(cid), "name": "Michael (Admin)"},
        headers=_auth(token),
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_zweimal_derselbe_name_ist_ein_konflikt(client, _auth_signer):
    token, _ = await _make_token(_auth_signer)
    gid = await _guild(client, token)
    cid = await _voice_channel(client, token, gid)
    body = {"channel_id": str(cid), "name": "werkstatt-pc"}
    assert (await client.post(f"/guilds/{gid}/devices", json=body, headers=_auth(token))).status_code == 201
    r = await client.post(f"/guilds/{gid}/devices", json=body, headers=_auth(token))
    assert r.status_code == 409


@pytest.mark.asyncio
async def test_ein_geraet_steht_nicht_in_einem_textkanal(client, _auth_signer):
    """Die Fernsteuerung hängt an der Übertragung, und die läuft in
    Sprachkanälen. Ein Gerät im Textkanal wäre sichtbar und nicht benutzbar."""
    token, _ = await _make_token(_auth_signer)
    gid = await _guild(client, token)
    r = await client.post(
        f"/guilds/{gid}/channels", json={"name": "plausch", "type": 0}, headers=_auth(token)
    )
    text_cid = r.json()["id"]
    r = await client.post(
        f"/guilds/{gid}/devices",
        json={"channel_id": str(text_cid), "name": "werkstatt-pc"},
        headers=_auth(token),
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_wer_den_standplatz_nicht_sehen_darf_sieht_das_geraet_nicht(
    client, _auth_signer, session_factory
):
    """**Die Regel, die das Modell trägt** (Entwurf §5): Geräte werden nach dem
    Standplatz gefiltert, genau wie Kanäle nach ``VIEW_CHANNEL``. Ohne sie
    stünde in der Liste jedes Mitglieds, welche Rechner es in einem Raum gibt,
    den es nie betreten darf."""
    owner_token, _ = await _make_token(_auth_signer)
    gid = await _guild(client, owner_token)
    cid = await _voice_channel(client, owner_token, gid)
    r = await client.post(
        f"/guilds/{gid}/devices",
        json={"channel_id": str(cid), "name": "werkstatt-pc"},
        headers=_auth(owner_token),
    )
    assert r.status_code == 201, r.text

    # Zweites Mitglied, dem der Standplatz ausdrücklich verboten ist.
    fremd_token, fremd_uid = await _make_token(_auth_signer)
    invite = (
        await client.post(f"/guilds/{gid}/invites", json={}, headers=_auth(owner_token))
    ).json()
    r = await client.post(f"/invites/{invite['code']}/accept", headers=_auth(fremd_token))
    assert r.status_code in (200, 201), r.text
    async with session_factory() as s:
        s.add(
            PermissionOverwrite(
                channel_id=cid,
                target_id=fremd_uid,
                target_type=1,  # 1 = Nutzer (0 = Rolle)
                allow_bf=0,
                deny_bf=int(Permissions.VIEW_CHANNEL),
            )
        )
        await s.commit()

    r = await client.get(f"/guilds/{gid}/devices", headers=_auth(fremd_token))
    assert r.status_code == 200
    assert r.json() == []


@pytest.mark.asyncio
async def test_nur_besitzer_oder_verwaltung_darf_entfernen(client, _auth_signer):
    owner_token, _ = await _make_token(_auth_signer)
    gid = await _guild(client, owner_token)
    cid = await _voice_channel(client, owner_token, gid)
    device = (
        await client.post(
            f"/guilds/{gid}/devices",
            json={"channel_id": str(cid), "name": "werkstatt-pc"},
            headers=_auth(owner_token),
        )
    ).json()

    fremd_token, _ = await _make_token(_auth_signer)
    invite = (
        await client.post(f"/guilds/{gid}/invites", json={}, headers=_auth(owner_token))
    ).json()
    await client.post(f"/invites/{invite['code']}/accept", headers=_auth(fremd_token))

    r = await client.delete(
        f"/guilds/{gid}/devices/{device['id']}", headers=_auth(fremd_token)
    )
    assert r.status_code == 403

    r = await client.delete(
        f"/guilds/{gid}/devices/{device['id']}", headers=_auth(owner_token)
    )
    assert r.status_code == 204
    assert (await client.get(f"/guilds/{gid}/devices", headers=_auth(owner_token))).json() == []


@pytest.mark.asyncio
async def test_zustand_kommt_aus_dem_register_nicht_aus_der_datenbank(client, _auth_signer):
    """Angemeldet = bereit, belegt = belegt. Beides ohne eine einzige Spalte —
    ein Zustandsfeld in der Datenbank behauptet nach jedem Absturz „bereit"."""
    token, _ = await _make_token(_auth_signer)
    gid = await _guild(client, token)
    cid = await _voice_channel(client, token, gid)
    device = (
        await client.post(
            f"/guilds/{gid}/devices",
            json={"channel_id": str(cid), "name": "werkstatt-pc"},
            headers=_auth(token),
        )
    ).json()
    did = int(device["id"])

    mgr = _register(client)
    sock = object()
    assert mgr.device_announce(sock, did, gid, cid) is True
    r = await client.get(f"/guilds/{gid}/devices", headers=_auth(token))
    assert r.json()[0]["state"] == "ready"

    mgr.device_set_busy(did, "4711")
    r = await client.get(f"/guilds/{gid}/devices", headers=_auth(token))
    assert r.json()[0]["state"] == "busy"
    assert r.json()[0]["busy_with"] == "4711"

    # Die Verbindung fällt → offline, und die Belegung fällt mit. Ohne das käme
    # das Gerät beim nächsten Anmelden sofort als „belegt" zurück, für eine
    # Sitzung, die es nicht mehr gibt.
    assert mgr.device_forget_socket(sock) == [did]
    r = await client.get(f"/guilds/{gid}/devices", headers=_auth(token))
    assert r.json()[0]["state"] == "offline"
    assert r.json()[0]["busy_with"] is None


@pytest.mark.asyncio
async def test_ein_zweites_fenster_nimmt_das_geraet_nicht_offline(client, _auth_signer):
    """Der Client eines Geräts kann mehrere Verbindungen haben; eine zu
    schliessen darf es nicht offline melden."""
    mgr = _register(client)
    gid, cid, did = 1, 2, 3
    a, b = object(), object()
    assert mgr.device_announce(a, did, gid, cid) is True
    assert mgr.device_announce(b, did, gid, cid) is False
    assert mgr.device_withdraw(a, did) is False
    assert mgr.device_state(did)[0] == "ready"
    assert mgr.device_withdraw(b, did) is True
    assert mgr.device_state(did)[0] == "offline"


@pytest.mark.asyncio
async def test_standplatz_wechsel_setzt_den_neuen_kanal(client, _auth_signer):
    token, _ = await _make_token(_auth_signer)
    gid = await _guild(client, token)
    alt = await _voice_channel(client, token, gid, "werkbank")
    neu = await _voice_channel(client, token, gid, "lager")
    device = (
        await client.post(
            f"/guilds/{gid}/devices",
            json={"channel_id": str(alt), "name": "werkstatt-pc"},
            headers=_auth(token),
        )
    ).json()

    r = await client.patch(
        f"/guilds/{gid}/devices/{device['id']}",
        json={"channel_id": str(neu)},
        headers=_auth(token),
    )
    assert r.status_code == 200, r.text
    assert r.json()["channel_id"] == str(neu)


# ── Was der Bughunt vom 2026-08-16 gefunden hat ─────────────────────────────


@pytest.mark.asyncio
async def test_belegung_wird_frei_auch_wenn_der_socket_schon_vergessen_ist(client, _auth_signer):
    """**Der Fund:** die Freigabe der Belegung suchte ihr Gerät über das
    Anmelde-Register. Fällt eine von MEHREREN Verbindungen des Geräts, ist der
    Socket beim Aufräumen schon vergessen — das Gerät stand danach für alle
    dauerhaft auf „belegt", und bei „belegt" blendet die Oberfläche den
    Übernahme-Knopf aus. Es war also unbenutzbar, bis seine App neu startete.
    """
    mgr = _register(client)
    gid, cid, did = 10, 20, 30
    haupt, zweites = object(), object()
    mgr.device_announce(haupt, did, gid, cid)
    mgr.device_announce(zweites, did, gid, cid)
    mgr.device_set_busy(did, "4711", haupt)
    assert mgr.device_state(did) == ("busy", "4711")

    # Die Verbindung mit der Sitzung fällt — das Gerät bleibt über die zweite
    # online, wird also NICHT über `device_withdraw` mitgeräumt.
    assert mgr.device_forget_socket(haupt) == []
    await mgr.device_release_for_socket(haupt)
    assert mgr.device_state(did) == ("ready", None)


@pytest.mark.asyncio
async def test_standplatz_wechsel_zieht_den_gemerkten_ort_nach(client, _auth_signer):
    """**Der Fund:** das Register merkt sich den Ort, an den es Zustands-
    meldungen schickt. Ohne Nachziehen meldete ein umgestelltes Gerät weiter an
    den ALTEN Kanal — die Falschen sähen seinen Zustand, die Berechtigten im
    neuen Kanal nie einen."""
    token, _ = await _make_token(_auth_signer)
    gid = await _guild(client, token)
    alt = await _voice_channel(client, token, gid, "werkbank")
    neu = await _voice_channel(client, token, gid, "lager")
    device = (
        await client.post(
            f"/guilds/{gid}/devices",
            json={"channel_id": str(alt), "name": "werkstatt-pc"},
            headers=_auth(token),
        )
    ).json()
    did = int(device["id"])

    mgr = _register(client)
    # Die Hilfsfunktionen liefern die Kennungen als Zeichenkette (so reisen sie
    # ueber die API); das Register fuehrt sie als Zahl.
    mgr.device_announce(object(), did, int(gid), int(alt))
    # Privat gelesen: der gemerkte Ort ist genau das, was hier schiefging, und
    # er hat sonst keinen Weg nach aussen.
    assert mgr._device_where[did] == (int(gid), int(alt))

    r = await client.patch(
        f"/guilds/{gid}/devices/{device['id']}",
        json={"channel_id": str(neu)},
        headers=_auth(token),
    )
    assert r.status_code == 200, r.text
    assert mgr._device_where[did] == (int(gid), int(neu))


@pytest.mark.asyncio
async def test_abmelden_beendet_die_fernsteuerung_dieses_geraets(client, _auth_signer):
    """**Der Fund:** trägt der Besitzer sein Gerät aus, während es jemand
    fernsteuert, lief die Sitzung weiter. Der Client meldet das Gerät ab, bevor
    er es löscht — und der Abbau suchte die Sitzung über die Verbindungen des
    Geräts, die dann schon weg waren. Das Abmelden räumt sie deshalb selbst ab.
    """
    from dcc_chat_gateway.routes import ws_device_handlers

    gid, cid, did = 11, 21, 31
    sock = object()
    mgr = _register(client)
    mgr.device_announce(sock, did, gid, cid)

    beendet: list[int] = []

    class _Ctx:
        class websocket:  # noqa: N801 - Test-Attrappe
            app = type("A", (), {"state": type("S", (), {"connection_manager": mgr})})

        user = type("U", (), {"id": 1})

    async def _merken(device_id: int) -> None:
        beendet.append(device_id)

    mgr.end_remote_sessions_for_device = _merken  # type: ignore[method-assign]
    await ws_device_handlers.handle_withdraw(_Ctx(), {"device_id": str(did)})
    assert beendet == [did], "das Abmelden muss die Sitzung dieses Geräts abbauen"
