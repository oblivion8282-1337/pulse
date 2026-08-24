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
async def test_sendende_plaetze_nur_von_angemeldeten_geraeten(client, _auth_signer):
    """Ein Gerät meldet selbst, auf welchen Plätzen es sendet.

    **Warum es das überhaupt gibt** (2026-08-16): der Strom eines Geräts läuft
    unter dem Konto seines Besitzers und trägt keine Geräte-Kennung. Ohne diese
    Meldung muss die Oberfläche raten — und sie hat falsch geraten: klickte der
    Besitzer an seinem eigenen Rechner auf „Live", wanderte das LIVE-Abzeichen
    an den unbeteiligten Standplatz.
    """
    mgr = _register(client)
    gid, cid, did = 1, 2, 3

    # Nicht angemeldet: nichts zu melden. Ein Eintrag ohne Verbindung bliebe
    # stehen, bis ihn zufällig jemand überschreibt.
    assert mgr.device_streams_set(did, {0}) is False
    assert mgr.device_streams(did) == []

    mgr.device_announce(object(), did, gid, cid)
    assert mgr.device_streams(did) == []
    assert mgr.device_streams_set(did, {1, 0}) is True
    assert mgr.device_streams(did) == [0, 1]
    # Dieselbe Menge erneut: keine Meldung, sonst schickte jeder Neustart eines
    # Streams dieselbe Nachricht ein zweites Mal.
    assert mgr.device_streams_set(did, {0, 1}) is False
    # Leer ist eine Aussage („sendet nicht mehr"), keine Nichtmeldung.
    assert mgr.device_streams_set(did, set()) is True
    assert mgr.device_streams(did) == []


@pytest.mark.asyncio
async def test_offline_geraet_meldet_keine_sendenden_plaetze_mehr(client, _auth_signer):
    """Bughunt 2026-08-17: ``device_withdraw`` räumte die Belegung, liess aber
    ``_device_streams`` stehen — ein längst offline gegangenes Gerät meldete
    weiter alte Plätze als sendend, und ein später vom Besitzer selbst
    gestarteter Strom auf demselben Platz landete am falschen Empfänger."""
    mgr = _register(client)
    gid, cid, did = 1, 2, 3
    sock = object()

    mgr.device_announce(sock, did, gid, cid)
    assert mgr.device_streams_set(did, {0}) is True
    assert mgr.device_streams(did) == [0]

    assert mgr.device_withdraw(sock, did) is True
    assert mgr.device_state(did)[0] == "offline"
    assert mgr.device_streams(did) == []


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
    mgr = _register(client)
    # Die Verbindung, die das Gerät angemeldet hat — nur sie darf es abmelden
    # (der zweite Bughunt vom selben Tag, s. weiter unten).
    sock = _Sock(client._transport.app)
    mgr.device_announce(sock, did, gid, cid)

    beendet: list[int] = []

    async def _merken(device_id: int) -> None:
        beendet.append(device_id)

    mgr.end_remote_sessions_for_device = _merken  # type: ignore[method-assign]
    await ws_device_handlers.handle_withdraw(_Ctx(sock, _User(1)), {"device_id": str(did)})
    assert beendet == [did], "das Abmelden muss die Sitzung dieses Geräts abbauen"


@pytest.mark.asyncio
async def test_rauswurf_entfernt_die_geraete_des_mitglieds(client, _auth_signer, session_factory):
    """**Der Fund:** ein Gerät lässt sich von jedem wecken, der im Kanal
    `REMOTE_CONTROL` hat — geprüft wird das Recht des RUFERS, nicht die
    Mitgliedschaft des Besitzers. Blieb die Zeile nach einem Rauswurf stehen,
    war der Rechner eines Ex-Mitglieds weiter benutzbar, und der Besitzer kam
    nicht einmal mehr heran, um ihn auszutragen."""
    from dcc_chat_gateway.remote_guard import remove_devices_for_member

    owner_token, _ = await _make_token(_auth_signer)
    gid = await _guild(client, owner_token)
    cid = await _voice_channel(client, owner_token, gid)

    fremd_token, fremd_uid = await _make_token(_auth_signer)
    invite = (
        await client.post(f"/guilds/{gid}/invites", json={}, headers=_auth(owner_token))
    ).json()
    await client.post(f"/invites/{invite['code']}/accept", headers=_auth(fremd_token))
    r = await client.post(
        f"/guilds/{gid}/devices",
        json={"channel_id": str(cid), "name": "fremder-pc"},
        headers=_auth(fremd_token),
    )
    assert r.status_code == 201, r.text

    async with session_factory() as s:
        entfernt = await remove_devices_for_member(s, _register(client), int(gid), fremd_uid)
        await s.commit()
    assert entfernt == 1
    assert (await client.get(f"/guilds/{gid}/devices", headers=_auth(owner_token))).json() == []


# ── Was der zweite Bughunt vom 2026-08-16 gefunden hat ──────────────────────
#
# Die Attrappen unten stehen bewusst hier und nicht in der conftest: sie sind
# das kleinste, was die Geräte-Ops brauchen (eine Verbindung, die mitschreibt,
# und ein Kontext, der ihr den Manager reicht). Ein Fixture daraus zu machen
# hiesse, sie über die ganze Suite zu verteilen, ohne dass sie dort jemand
# braucht.


class _Sock:
    """Eine Verbindung, die aufschreibt, was ihr geschickt wird."""

    def __init__(self, app=None) -> None:
        self.sent: list[dict] = []
        self.app = app

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)


class _Ctx:
    """Der Verbindungskontext, wie ihn die WS-Ops sehen."""

    def __init__(self, sock, user) -> None:
        self.websocket = sock
        self.user = user
        self.last_remote_request = 0.0
        self.last_device_announce = 0.0
        self.last_device_wake = 0.0


class _User:
    def __init__(self, uid: int) -> None:
        self.id = uid
        self.username = f"u{uid}"
        self.is_admin = False
        self.is_owner = False
        self.payload: dict = {}
        self.user_identifier = str(uid)
        self.is_self_host = False


def _ctx(client, uid: int) -> _Ctx:
    """Kontext auf der Test-App — die WS-Ops holen den Manager über
    ``websocket.app.state``."""
    return _Ctx(_Sock(client._transport.app), _User(uid))


async def _mitglied(client, owner_token: str, gid: int, _auth_signer) -> tuple[str, int]:
    """Ein zweites Mitglied der Community."""
    token, uid = await _make_token(_auth_signer)
    invite = (
        await client.post(f"/guilds/{gid}/invites", json={}, headers=_auth(owner_token))
    ).json()
    r = await client.post(f"/invites/{invite['code']}/accept", headers=_auth(token))
    assert r.status_code in (200, 201), r.text
    return token, uid


@pytest.mark.asyncio
async def test_verlassen_entfernt_die_geraete_ueber_die_route(client, _auth_signer):
    """**Der Fund:** ``remove_devices_for_member`` flusht nur. Beide Aufrufer
    rufen NACH ihrem eigenen Commit, und ``get_session`` rollt beim Schliessen
    zurück — die Gerätezeilen überlebten den Austritt. Beim Rauswurf und beim
    Bann ging es nur zufällig durch (die Moderations-Nachricht committet
    danach), beim freiwilligen Verlassen gar nicht.

    Deshalb über die ROUTE geprüft: der bestehende Test ruft den Helfer direkt
    und committet selbst — genau der Unterschied, um den es geht.
    """
    owner_token, _ = await _make_token(_auth_signer)
    gid = await _guild(client, owner_token)
    cid = await _voice_channel(client, owner_token, gid)
    fremd_token, _ = await _mitglied(client, owner_token, gid, _auth_signer)

    r = await client.post(
        f"/guilds/{gid}/devices",
        json={"channel_id": str(cid), "name": "fremder-pc"},
        headers=_auth(fremd_token),
    )
    assert r.status_code == 201, r.text

    r = await client.delete(f"/guilds/{gid}/members/@me", headers=_auth(fremd_token))
    assert r.status_code == 204, r.text
    assert (await client.get(f"/guilds/{gid}/devices", headers=_auth(owner_token))).json() == []


@pytest.mark.asyncio
async def test_rauswurf_ueber_die_route_entfernt_die_geraete(client, _auth_signer):
    """Dasselbe für den Rauswurf — dort committet heute zufällig die
    Moderations-Nachricht danach. Der Test hält fest, dass es nicht davon
    abhängt."""
    owner_token, _ = await _make_token(_auth_signer)
    gid = await _guild(client, owner_token)
    cid = await _voice_channel(client, owner_token, gid)
    fremd_token, fremd_uid = await _mitglied(client, owner_token, gid, _auth_signer)
    r = await client.post(
        f"/guilds/{gid}/devices",
        json={"channel_id": str(cid), "name": "fremder-pc"},
        headers=_auth(fremd_token),
    )
    assert r.status_code == 201, r.text

    r = await client.delete(
        f"/guilds/{gid}/members/{fremd_uid}", headers=_auth(owner_token)
    )
    assert r.status_code == 204, r.text
    assert (await client.get(f"/guilds/{gid}/devices", headers=_auth(owner_token))).json() == []


@pytest.mark.asyncio
async def test_umstellen_bleibt_dem_besitzer_vorbehalten(client, _auth_signer):
    """**Der Fund:** ``MANAGE_GUILD`` durfte ein fremdes Gerät umstellen — in
    einen Kanal, in dem ``@everyone`` ``REMOTE_CONTROL`` hat. Der Standplatz ist
    der Rechteanker; „räumen können" trägt das Umwidmen nicht. Löschen und
    Umbenennen bleiben bei der Verwaltung."""
    owner_token, _ = await _make_token(_auth_signer)
    gid = await _guild(client, owner_token)
    alt = await _voice_channel(client, owner_token, gid, "werkbank")
    neu = await _voice_channel(client, owner_token, gid, "lager")
    fremd_token, _ = await _mitglied(client, owner_token, gid, _auth_signer)
    device = (
        await client.post(
            f"/guilds/{gid}/devices",
            json={"channel_id": str(alt), "name": "fremder-pc"},
            headers=_auth(fremd_token),
        )
    ).json()

    # Der Community-Besitzer hat MANAGE_GUILD — und darf trotzdem nicht.
    r = await client.patch(
        f"/guilds/{gid}/devices/{device['id']}",
        json={"channel_id": str(neu)},
        headers=_auth(owner_token),
    )
    assert r.status_code == 403
    # Umbenennen darf er weiterhin, und entfernen auch.
    r = await client.patch(
        f"/guilds/{gid}/devices/{device['id']}",
        json={"name": "abgestellt"},
        headers=_auth(owner_token),
    )
    assert r.status_code == 200, r.text
    assert (
        await client.delete(f"/guilds/{gid}/devices/{device['id']}", headers=_auth(owner_token))
    ).status_code == 204


@pytest.mark.asyncio
async def test_ein_unsichtbarer_kanal_antwortet_wie_ein_nicht_vorhandener(
    client, _auth_signer, session_factory
):
    """**Der Fund:** Existenz und Typ wurden vor den Rechten geprüft. Die drei
    Antworten 404 / 400 / 403 verrieten damit, ob es hinter einer Kennung einen
    Kanal gibt und ob er Sprache oder Text trägt — auch für Kanäle, die der
    Rufer nicht sehen darf."""
    owner_token, _ = await _make_token(_auth_signer)
    gid = await _guild(client, owner_token)
    geheim = await _voice_channel(client, owner_token, gid, "geheim")
    fremd_token, fremd_uid = await _mitglied(client, owner_token, gid, _auth_signer)
    async with session_factory() as s:
        s.add(
            PermissionOverwrite(
                channel_id=geheim,
                target_id=fremd_uid,
                target_type=1,
                allow_bf=0,
                deny_bf=int(Permissions.VIEW_CHANNEL),
            )
        )
        await s.commit()

    versteckt = await client.post(
        f"/guilds/{gid}/devices",
        json={"channel_id": str(geheim), "name": "werkstatt-pc"},
        headers=_auth(fremd_token),
    )
    erfunden = await client.post(
        f"/guilds/{gid}/devices",
        json={"channel_id": "123456789", "name": "werkstatt-pc"},
        headers=_auth(fremd_token),
    )
    assert versteckt.status_code == erfunden.status_code == 404


@pytest.mark.asyncio
async def test_geloeschtes_geraet_hinterlaesst_nichts_im_register(client, _auth_signer):
    """**Der Fund:** Standplatz und Bildschirmliste blieben für eine gelöschte
    Kennung über die ganze Prozesslaufzeit stehen — ein Leck, und jede spätere
    Meldung ginge an einen Kanal für ein Gerät, das es nicht mehr gibt."""
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
    mgr.device_announce(_Sock(), did, int(gid), int(cid), [{"index": 1, "name": "HDMI-1"}])

    r = await client.delete(f"/guilds/{gid}/devices/{device['id']}", headers=_auth(token))
    assert r.status_code == 204
    assert did not in mgr._device_where
    assert did not in mgr._device_monitors
    assert mgr.device_state(did) == ("offline", None)


# ── Die WS-Ops eines Geräts ─────────────────────────────────────────────────


async def _erlauben(session_factory, channel_id: int, user_id: int, bits: int) -> None:
    """Einem Nutzer ein Recht im Kanal geben (Kanal-Overwrite)."""
    async with session_factory() as s:
        s.add(
            PermissionOverwrite(
                channel_id=int(channel_id),
                target_id=int(user_id),
                target_type=1,
                allow_bf=bits,
                deny_bf=0,
            )
        )
        await s.commit()


@pytest.mark.asyncio
async def test_anmelden_mit_fremdem_geraet_wird_still_verworfen(client, _auth_signer):
    """Die Anmeldung sagt „dieser Rechner ist Gerät X". Sie gilt nur für den
    Besitzer der Zeile — und sie antwortet nicht, weil eine Fehlerantwort einem
    fremden Konto verriete, dass es die Zeile gibt."""
    from dcc_chat_gateway.routes import ws_device_handlers

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
    did = int(device["id"])

    fremd_token, fremd_uid = await _mitglied(client, owner_token, gid, _auth_signer)
    ctx = _ctx(client, fremd_uid)
    await ws_device_handlers.handle_announce(ctx, {"device_id": str(did)})
    assert _register(client).device_state(did) == ("offline", None)
    assert ctx.websocket.sent == []


@pytest.mark.asyncio
async def test_abmelden_von_fremdem_socket_kappt_keine_sitzung(client, _auth_signer):
    """**Der Fund:** ``device_withdraw`` prüfte gar nichts — weder Besitz noch
    Mitgliedschaft noch ob dieser Socket das Gerät angemeldet hat —, und der
    Abbau der Fernsteuerung lief VOR allem anderen. Jeder eingeloggte Nutzer
    konnte damit jede laufende Übernahme kappen, beliebig oft."""
    from dcc_chat_gateway.routes import ws_device_handlers

    mgr = _register(client)
    gid, cid, did = 40, 41, 42
    geraet_sock = _Sock(client._transport.app)
    mgr.device_announce(geraet_sock, did, gid, cid)

    beendet: list[int] = []

    async def _merken(device_id: int) -> None:
        beendet.append(device_id)

    mgr.end_remote_sessions_for_device = _merken  # type: ignore[method-assign]

    await ws_device_handlers.handle_withdraw(_ctx(client, 999), {"device_id": str(did)})
    assert beendet == [], "ein fremder Socket darf nichts abbauen"
    assert mgr.device_state(did) == ("ready", None)

    # Der Socket des Geräts selbst darf es weiterhin.
    eigen = _Ctx(geraet_sock, _User(1))
    await ws_device_handlers.handle_withdraw(eigen, {"device_id": str(did)})
    assert beendet == [did]
    assert mgr.device_state(did) == ("offline", None)


@pytest.mark.asyncio
async def test_wecken_verlangt_remote_control(client, _auth_signer, session_factory):
    """Wer nicht übernehmen darf, darf auch keinen fremden Rechner zum
    Encodieren bringen — sonst wäre das Wecken ein Weg, einem Gerät dauerhaft
    Last aufzuzwingen. Die Ablehnung ist wortgleich mit „gibt es nicht"."""
    from dcc_chat_gateway.routes import ws_device_handlers

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
    did = int(device["id"])
    fremd_token, fremd_uid = await _mitglied(client, owner_token, gid, _auth_signer)

    ohne = _ctx(client, fremd_uid)
    await ws_device_handlers.handle_wake(ohne, {"device_id": str(did)})
    assert ohne.websocket.sent[-1]["code"] == 4060

    await _erlauben(session_factory, cid, fremd_uid, int(Permissions.REMOTE_CONTROL))
    mit = _ctx(client, fremd_uid)
    await ws_device_handlers.handle_wake(mit, {"device_id": str(did)})
    # Jetzt scheitert es nur noch daran, dass niemand da ist.
    assert mit.websocket.sent[-1]["code"] == 4061

    # Und mit angemeldetem Gerät kommt der Weckruf wirklich an.
    geraet_sock = _Sock(client._transport.app)
    _register(client).device_announce(geraet_sock, did, int(gid), int(cid))
    dritter = _ctx(client, fremd_uid)
    await ws_device_handlers.handle_wake(dritter, {"device_id": str(did), "monitor": 2})
    assert geraet_sock.sent[-1]["op"] == "device_wake"
    assert geraet_sock.sent[-1]["monitor"] == 2


@pytest.mark.asyncio
async def test_wecken_hat_eine_bremse(client, _auth_signer, session_factory):
    """**Der Fund:** ``device_wake`` hatte keinen Takt-Deckel, obwohl
    ``remote_request`` mit derselben Begründung eine Zwei-Sekunden-Pause hat —
    und ein Weckruf erzeugt zusätzlich Last auf einem FREMDEN Rechner."""
    from dcc_chat_gateway.routes import ws_device_handlers

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
    ctx = _ctx(client, 4242)

    await ws_device_handlers.handle_wake(ctx, {"device_id": str(did)})
    erste = len(ctx.websocket.sent)
    await ws_device_handlers.handle_wake(ctx, {"device_id": str(did)})
    assert ctx.websocket.sent[-1]["code"] == 4056
    assert len(ctx.websocket.sent) == erste + 1


@pytest.mark.asyncio
async def test_bildschirmnummern_ueber_der_grenze_fallen_weg():
    """Die Auswahl darf keinen Punkt anbieten, den der Weckruf still verwirft:
    ``handle_wake`` lässt nur 1..8 durch, die Anmeldeliste nahm jede Nummer."""
    from dcc_chat_gateway.routes.ws_device_handlers import MAX_MONITORS, _monitore

    roh = [{"index": 1}, {"index": MAX_MONITORS + 1}, {"index": 0}]
    assert [m["index"] for m in _monitore(roh)] == [1]


# ── Lage und Groesse eines gemeldeten Bildschirms (Bildschirm-Karte) ────────


def test_monitor_mit_lage_und_groesse_kommt_vollstaendig_durch():
    """Meldet ein Gerät alle vier Zahlen, reisen sie unverändert mit — die
    Bildschirm-Karte im Overlay braucht sie, um massstäblich zu zeichnen."""
    from dcc_chat_gateway.routes.ws_device_handlers import _monitore

    roh = [
        {
            "index": 1,
            "name": "HDMI-1",
            "primary": True,
            "x": 0,
            "y": 0,
            "width": 1920,
            "height": 1080,
        }
    ]
    [monitor] = _monitore(roh)
    assert monitor == {
        "index": 1,
        "name": "HDMI-1",
        "primary": True,
        "x": 0,
        "y": 0,
        "width": 1920,
        "height": 1080,
    }


def test_monitor_ohne_lage_kommt_weiterhin_durch():
    """Ein älteres Gerät, dessen Sidecar die vier Zahlen noch nicht kennt,
    darf nicht aus der Liste fallen — nur die vier Felder fehlen dann."""
    from dcc_chat_gateway.routes.ws_device_handlers import _monitore

    roh = [{"index": 1, "name": "HDMI-1", "primary": True}]
    [monitor] = _monitore(roh)
    assert monitor == {"index": 1, "name": "HDMI-1", "primary": True}
    assert "x" not in monitor
    assert "y" not in monitor
    assert "width" not in monitor
    assert "height" not in monitor


def test_negative_lage_ist_gueltig():
    """**Der Fund, der lautlos zuschlägt:** ein Monitor links vom
    Hauptbildschirm hat ein negatives ``x``, einer darüber ein negatives
    ``y`` — die häufigste Mehrschirm-Aufstellung. Eine ``>= 0``-Prüfung würfe
    genau diesen Fall weg."""
    from dcc_chat_gateway.routes.ws_device_handlers import _monitore

    roh = [{"index": 2, "x": -1920, "y": -200, "width": 1920, "height": 1080}]
    [monitor] = _monitore(roh)
    assert monitor["x"] == -1920
    assert monitor["y"] == -200


def test_unfug_wird_je_feld_weggelassen_monitor_bleibt():
    """Zeichenkette, ``null``, Kommazahl und ein nicht-positiver Wert führen
    zum Weglassen NUR des betroffenen Felds — nie zum Verwerfen des ganzen
    Monitors, und es wird keine Zahl geraten."""
    from dcc_chat_gateway.routes.ws_device_handlers import _monitore

    roh = [
        {
            "index": 1,
            "name": "HDMI-1",
            "x": "links",  # Zeichenkette
            "y": None,  # null
            "width": 1920.5,  # Kommazahl
            "height": 0,  # nicht positiv — Breite/Höhe müssen es sein
        }
    ]
    [monitor] = _monitore(roh)
    assert monitor["index"] == 1
    assert monitor["name"] == "HDMI-1"
    assert "x" not in monitor
    assert "y" not in monitor
    assert "width" not in monitor
    assert "height" not in monitor


def test_negative_breite_und_hoehe_fallen_weg():
    """Anders als ``x``/``y`` müssen ``width``/``height`` positiv sein — ein
    Bildschirm ohne Ausdehnung ist Unfug, keine gültige Lage."""
    from dcc_chat_gateway.routes.ws_device_handlers import _monitore

    roh = [{"index": 1, "width": -1920, "height": 1080}]
    [monitor] = _monitore(roh)
    assert "width" not in monitor
    assert monitor["height"] == 1080


def test_max_monitors_bleibt_wirksam_mit_lage_und_groesse():
    """Die vier zusätzlichen Zahlen dürfen die Acht-Schirme-Grenze nicht
    aufweichen — dieselbe Kürzung wie zuvor, jetzt mit vollen Monitoren."""
    from dcc_chat_gateway.routes.ws_device_handlers import MAX_MONITORS, _monitore

    roh = [
        {"index": i, "x": i, "y": i, "width": 1920, "height": 1080}
        for i in range(1, MAX_MONITORS + 2)
    ]
    ergebnis = _monitore(roh)
    assert len(ergebnis) == MAX_MONITORS
    assert all(m["width"] == 1920 for m in ergebnis)


# ── Die Bindung einer Fernsteuer-Anfrage an den Standplatz ──────────────────
#
# Der schwerste Fund des Hunts: die Anfrage prüfte die Rechte in dem Kanal, den
# der RUFER nannte, und das mitgeschickte Gerät wurde nur durchgereicht. Wer
# irgendwo eine eigene Community hat, in der das Opfer Mitglied ist, gab sich
# dort REMOTE_CONTROL — und die Dauerfreigabe des Geräts stimmte zu, ohne dass
# der echte Standplatz je gefragt wurde.


async def _fernaufbau(client, _auth_signer):
    """Steuernder (Community-Besitzer), Host mit einem Gerät in Kanal A, und
    ein zweiter Kanal B, in dem der Steuernde ebenfalls alles darf."""
    owner_token, owner_uid = await _make_token(_auth_signer)
    gid = await _guild(client, owner_token)
    a = await _voice_channel(client, owner_token, gid, "werkbank")
    b = await _voice_channel(client, owner_token, gid, "lager")
    host_token, host_uid = await _mitglied(client, owner_token, gid, _auth_signer)
    device = (
        await client.post(
            f"/guilds/{gid}/devices",
            json={"channel_id": str(a), "name": "werkstatt-pc"},
            headers=_auth(host_token),
        )
    ).json()
    return owner_token, owner_uid, host_token, host_uid, int(gid), int(a), int(b), device


def _geraet_verbinden(mgr, client, device_id: int, host_uid: int, gid: int, cid: int):
    """Eine Verbindung des Hosts, die sich als dieses Gerät angemeldet hat."""
    sock = _Sock(client._transport.app)
    mgr._ws_user[sock] = _User(host_uid)
    mgr._user_conns.setdefault(host_uid, set()).add(sock)
    mgr.device_announce(sock, device_id, gid, cid)
    return sock


@pytest.mark.asyncio
async def test_anfrage_mit_geraet_aus_einem_anderen_kanal_wird_abgelehnt(
    client, _auth_signer, session_factory
):
    """**Der Fund:** das Gerät wurde nie gegen seinen Standplatz gehalten. Die
    Ablehnung bleibt bei 4051 — dieselbe Antwort wie „kein Zugriff", damit sie
    nichts über fremde Kanäle verrät."""
    from dcc_chat_gateway.routes import ws_remote_handlers

    _, owner_uid, _, host_uid, gid, a, b, device = await _fernaufbau(client, _auth_signer)
    mgr = _register(client)
    _geraet_verbinden(mgr, client, int(device["id"]), host_uid, gid, a)

    ctx = _ctx(client, owner_uid)
    await ws_remote_handlers.handle_request(
        ctx,
        {"channel_id": str(b), "host_user_id": str(host_uid), "device_id": device["id"]},
        session_factory=session_factory,
    )
    assert ctx.websocket.sent[-1]["code"] == 4051
    assert mgr.remote_sessions_snapshot() == []


@pytest.mark.asyncio
async def test_anfrage_im_standplatz_erreicht_genau_das_geraet(
    client, _auth_signer, session_factory
):
    """Der Gegenbeweis zum Test darüber: im richtigen Kanal geht dieselbe
    Anfrage durch, die Einladung landet auf der Verbindung des Geräts, und die
    Sitzung trägt dessen Kennung (daran findet sie später der Abbau beim
    Umstellen)."""
    from dcc_chat_gateway.routes import ws_remote_handlers

    _, owner_uid, _, host_uid, gid, a, _b, device = await _fernaufbau(client, _auth_signer)
    mgr = _register(client)
    did = int(device["id"])
    sock = _geraet_verbinden(mgr, client, did, host_uid, gid, a)

    ctx = _ctx(client, owner_uid)
    await ws_remote_handlers.handle_request(
        ctx,
        {"channel_id": str(a), "host_user_id": str(host_uid), "device_id": device["id"]},
        session_factory=session_factory,
    )
    einladung = [f for f in sock.sent if f.get("op") == "remote_request"]
    assert len(einladung) == 1
    assert einladung[0]["device_id"] == device["id"]
    sitzungen = mgr.remote_sessions_snapshot()
    assert [s.device_id for s in sitzungen] == [str(did)]
    mgr.remote_cancel_timeout(sitzungen[0].session_id)


@pytest.mark.asyncio
async def test_anfrage_ohne_geraet_erreicht_kein_geraet(
    client, _auth_signer, session_factory
):
    """Eine Anfrage an einen MENSCHEN darf nicht bei einem Gerät landen: dort
    beantwortet sie die Dauerfreigabe, und die kennt den Kanal nicht, an dem der
    Gateway gerade die Rechte geprüft hat. Ist die einzige Verbindung des Hosts
    ein Gerät, ist er als Mensch schlicht nicht erreichbar (4052)."""
    from dcc_chat_gateway.routes import ws_remote_handlers

    _, owner_uid, _, host_uid, gid, a, _b, device = await _fernaufbau(client, _auth_signer)
    mgr = _register(client)
    sock = _geraet_verbinden(mgr, client, int(device["id"]), host_uid, gid, a)

    ctx = _ctx(client, owner_uid)
    await ws_remote_handlers.handle_request(
        ctx,
        {"channel_id": str(a), "host_user_id": str(host_uid)},
        session_factory=session_factory,
    )
    assert ctx.websocket.sent[-1]["code"] == 4052
    assert [f for f in sock.sent if f.get("op") == "remote_request"] == []


@pytest.mark.asyncio
async def test_zwei_geraete_desselben_besitzers_blockieren_sich_nicht(
    client, _auth_signer, session_factory
):
    """**Der Fund:** die Eindeutigkeit lag auf dem Host-KONTO. Standplatz-Geräte
    hängen aber alle am Konto ihres Besitzers — das zweite Gerät antwortete mit
    4054, während es in der Liste als „bereit" stand."""
    from dcc_chat_gateway.routes import ws_remote_handlers

    owner_token, owner_uid, host_token, host_uid, gid, a, _b, erstes = await _fernaufbau(
        client, _auth_signer
    )
    zweites = (
        await client.post(
            f"/guilds/{gid}/devices",
            json={"channel_id": str(a), "name": "lager-pc"},
            headers=_auth(host_token),
        )
    ).json()
    mgr = _register(client)
    _geraet_verbinden(mgr, client, int(erstes["id"]), host_uid, gid, a)
    _geraet_verbinden(mgr, client, int(zweites["id"]), host_uid, gid, a)

    for geraet in (erstes, zweites):
        # Je eine eigene Verbindung: die Mindestpause zwischen zwei Anfragen
        # hängt am Socket, und zwei Geräte weckt man aus zwei Kacheln.
        ctx = _ctx(client, owner_uid)
        await ws_remote_handlers.handle_request(
            ctx,
            {"channel_id": str(a), "host_user_id": str(host_uid), "device_id": geraet["id"]},
            session_factory=session_factory,
        )
        assert [f for f in ctx.websocket.sent if f.get("op") == "error"] == [], (
            f"Anfrage an {geraet['name']} abgelehnt"
        )
    sitzungen = mgr.remote_sessions_snapshot()
    assert sorted(s.device_id for s in sitzungen) == sorted(
        [erstes["id"], zweites["id"]]
    )
    for s in sitzungen:
        mgr.remote_cancel_timeout(s.session_id)


@pytest.mark.asyncio
async def test_ein_geraet_stimmt_nur_fuer_sich_selbst_zu(client, _auth_signer):
    """Der Riegel am anderen Ende: meldet sich ein Gerät erst an, NACHDEM die
    Einladung hinausging, könnte seine Dauerfreigabe eine Anfrage annehmen, die
    an einem fremden Kanal geprüft wurde. Ein Geräte-Socket nimmt deshalb nur
    an, was auf sein eigenes Gerät und dessen Standplatz zeigt."""
    from dcc_chat_gateway.routes import ws_remote_handlers

    mgr = _register(client)
    gid, cid, did = 50, 51, 52
    geraet_sock = _Sock(client._transport.app)
    ctrl_sock = _Sock(client._transport.app)
    mgr.device_announce(geraet_sock, did, gid, cid)
    # Eine Sitzung, die KEIN Gerät nennt — genau die, die vorher durchging.
    sess = await mgr.remote_create(str(cid), "70", geraet_sock, "80", ctrl_sock)
    await ws_remote_handlers.handle_respond(
        geraet_sock, _User(70), {"session_id": sess.session_id, "accept": True}
    )
    assert geraet_sock.sent[-1]["code"] == 4051
    assert mgr.remote_get(sess.session_id).state == "pending"


@pytest.mark.asyncio
async def test_geraet_wechselt_die_community(client, _auth_signer):
    token, uid = await _make_token(_auth_signer)
    quelle = await _guild(client, token, "projekt-nord")
    ziel = await _guild(client, token, "projekt-sued")
    kanal_quelle = await _voice_channel(client, token, quelle)
    kanal_ziel = await _voice_channel(client, token, ziel, "schnitt-2")

    r = await client.post(
        f"/guilds/{quelle}/devices",
        json={"channel_id": str(kanal_quelle), "name": "schnitt-3"},
        headers=_auth(token),
    )
    device_id = r.json()["id"]

    r = await client.patch(
        f"/guilds/{quelle}/devices/{device_id}",
        json={"guild_id": str(ziel), "channel_id": str(kanal_ziel)},
        headers=_auth(token),
    )
    assert r.status_code == 200, r.text
    assert r.json()["guild_id"] == str(ziel)
    assert r.json()["channel_id"] == str(kanal_ziel)

    # Aus der alten Community verschwunden, in der neuen aufgetaucht.
    alt = await client.get(f"/guilds/{quelle}/devices", headers=_auth(token))
    assert alt.json() == []
    neu = await client.get(f"/guilds/{ziel}/devices", headers=_auth(token))
    assert [d["id"] for d in neu.json()] == [device_id]


@pytest.mark.asyncio
async def test_community_wechsel_ohne_rechte_am_ziel(client, _auth_signer):
    token, uid = await _make_token(_auth_signer)
    fremd_token, _ = await _make_token(_auth_signer)
    quelle = await _guild(client, token, "meins")
    kanal = await _voice_channel(client, token, quelle)
    fremd = await _guild(client, fremd_token, "fremd")
    fremd_kanal = await _voice_channel(client, fremd_token, fremd)

    r = await client.post(
        f"/guilds/{quelle}/devices",
        json={"channel_id": str(kanal), "name": "werkstatt-pc"},
        headers=_auth(token),
    )
    device_id = r.json()["id"]

    # Kein Mitglied der Zielcommunity: wortgleich wie ein nicht vorhandener
    # Kanal — die Antwort darf nicht verraten, dass es die Community gibt.
    r = await client.patch(
        f"/guilds/{quelle}/devices/{device_id}",
        json={"guild_id": str(fremd), "channel_id": str(fremd_kanal)},
        headers=_auth(token),
    )
    assert r.status_code == 404, r.text


@pytest.mark.asyncio
async def test_gleiche_community_bleibt_ein_kanalwechsel(client, _auth_signer):
    besitzer, _ = await _make_token(_auth_signer)
    gid = await _guild(client, besitzer, "studio")
    kanal = await _voice_channel(client, besitzer, gid)
    zweit_kanal = await _voice_channel(client, besitzer, gid, "schnitt-2")
    r = await client.post(
        f"/guilds/{gid}/devices",
        json={"channel_id": str(kanal), "name": "schnitt-1"},
        headers=_auth(besitzer),
    )
    device_id = r.json()["id"]

    # Der Community-Eigner ist hier zugleich Besitzer des Geräts; für den
    # Gegentest braucht es ein Gerät, das jemand anderem gehört. Wir prüfen
    # deshalb den Fall über die vorhandene Regel: derselbe Aufruf mit
    # ``guild_id`` auf die eigene Community ist ein reiner Kanalwechsel und
    # muss weiterhin durchgehen.
    r = await client.patch(
        f"/guilds/{gid}/devices/{device_id}",
        json={"guild_id": str(gid), "channel_id": str(zweit_kanal)},
        headers=_auth(besitzer),
    )
    assert r.status_code == 200, r.text
    assert r.json()["channel_id"] == str(zweit_kanal)


@pytest.mark.asyncio
async def test_community_wechsel_nur_besitzer(client, _auth_signer):
    """**Der echte Nicht-Besitzer-Fall**: ``MANAGE_GUILD`` darf ein fremdes
    Gerät räumen (löschen/umbenennen), aber nicht umwidmen — dieselbe Regel
    wie beim reinen Kanalwechsel (``test_umstellen_bleibt_dem_besitzer_vorbehalten``),
    hier gegen den Community-Wechsel geprüft. Ein zweites Mitglied mit einer
    ``MANAGE_GUILD``-Rolle versucht, das Gerät eines anderen Mitglieds in eine
    andere Community zu verschieben, und bekommt 403 — nicht 404, denn diese
    Person IST Mitglied beider Communities, es geht hier nicht um Sichtbarkeit
    sondern um Eigentum."""
    besitzer, _ = await _make_token(_auth_signer)
    gid = await _guild(client, besitzer, "werkstatt-a")
    ziel_gid = await _guild(client, besitzer, "werkstatt-b")
    kanal = await _voice_channel(client, besitzer, gid)
    ziel_kanal = await _voice_channel(client, besitzer, ziel_gid, "andere-bank")

    geraete_besitzer, geraete_uid = await _mitglied(client, besitzer, gid, _auth_signer)
    device = (
        await client.post(
            f"/guilds/{gid}/devices",
            json={"channel_id": str(kanal), "name": "fremder-pc"},
            headers=_auth(geraete_besitzer),
        )
    ).json()

    # Verwalter mit MANAGE_GUILD, aber nicht Besitzer des Geräts.
    verwalter_token, verwalter_uid = await _mitglied(client, besitzer, gid, _auth_signer)
    role = (
        await client.post(
            f"/guilds/{gid}/roles",
            json={"name": "verwaltung", "permissions": str(int(Permissions.MANAGE_GUILD))},
            headers=_auth(besitzer),
        )
    ).json()
    await client.put(
        f"/guilds/{gid}/members/{verwalter_uid}/roles/{role['id']}",
        headers=_auth(besitzer),
    )

    r = await client.patch(
        f"/guilds/{gid}/devices/{device['id']}",
        json={"guild_id": str(ziel_gid), "channel_id": str(ziel_kanal)},
        headers=_auth(verwalter_token),
    )
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_geraete_deckel_kommt_aus_dem_community_limit(client, _auth_signer):
    token, _ = await _make_token(_auth_signer)
    gid = await _guild(client, token, "studio")
    kanal = await _voice_channel(client, token, gid)
    # Deckel auf 1 setzen (Community-eigener Wert)
    r = await client.patch(
        f"/guilds/{gid}/limits",
        json={"limits": {"max_devices_per_owner": 1}},
        headers=_auth(token),
    )
    assert r.status_code == 200, r.text

    r = await client.post(
        f"/guilds/{gid}/devices",
        json={"channel_id": str(kanal), "name": "schnitt-1"},
        headers=_auth(token),
    )
    assert r.status_code == 201
    r = await client.post(
        f"/guilds/{gid}/devices",
        json={"channel_id": str(kanal), "name": "schnitt-2"},
        headers=_auth(token),
    )
    assert r.status_code == 409, r.text


@pytest.mark.asyncio
async def test_umstellen_markiert_die_abmeldung_als_umzug(client, _auth_signer):
    """**Prüfbefund K-1 (2026-08-20):** die Abmeldung an den ALTEN Standplatz
    beim Umstellen war von einem echten Löschen nicht unterscheidbar — der
    Rechner des Geräts ist Mitglied der alten Community, empfängt die eigene
    Abmeldung also selbst und hätte seine lokale Eintragung dauerhaft
    weggeräumt, obwohl das Gerät nur umgezogen ist. Die Abmeldung beim
    Umstellen muss ``moved: True`` tragen, ein echtes Löschen NICHT."""
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

    mgr = _register(client)
    aufrufe: list[dict] = []

    async def _merken(**kwargs):
        aufrufe.append(kwargs)

    mgr.publish_device_change = _merken  # type: ignore[method-assign]

    r = await client.patch(
        f"/guilds/{gid}/devices/{device['id']}",
        json={"channel_id": str(neu)},
        headers=_auth(token),
    )
    assert r.status_code == 200, r.text

    abmeldungen = [a for a in aufrufe if a["removed"] is True]
    assert len(abmeldungen) == 1, "genau eine Abmeldung an den alten Standplatz"
    assert abmeldungen[0]["moved"] is True

    aufrufe.clear()
    r = await client.delete(
        f"/guilds/{gid}/devices/{device['id']}",
        headers=_auth(token),
    )
    assert r.status_code == 204, r.text
    assert len(aufrufe) == 1
    assert aufrufe[0]["removed"] is True
    assert aufrufe[0]["moved"] is False
