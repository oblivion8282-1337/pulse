"""Tests für die Freigabeliste eines Standplatz-Geräts — lesen und ersetzen.

Die Liste sagt, WER einen Rechner ohne Rückfrage übernehmen darf. Sie lag bis
2026-08-20 auf dem Gerät selbst und war damit nur vor Ort änderbar; Entwurf:
``docs/superpowers/specs/2026-08-20-geraeteverwaltung-design.md``.
"""

from __future__ import annotations

import uuid

import pytest
from dcc_chat_gateway.models import (
    CHANNEL_TYPE_VOICE,
    SUBJECT_EVERYONE,
    DeviceGrant,
    PermissionOverwrite,
)
from dcc_chat_gateway.snowflake import next_id
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


async def _mitglied(client, owner_token: str, gid: int, _auth_signer) -> tuple[str, int]:
    """Ein zweites Mitglied der Community — via Einladung beigetreten, wie im
    Muster aus ``tests/test_devices.py``."""
    token, uid = await _make_token(_auth_signer)
    invite = (
        await client.post(f"/guilds/{gid}/invites", json={}, headers=_auth(owner_token))
    ).json()
    r = await client.post(f"/invites/{invite['code']}/accept", headers=_auth(token))
    assert r.status_code in (200, 201), r.text
    return token, uid


@pytest.mark.asyncio
async def test_freigabe_haengt_am_geraet(session_factory):
    async with session_factory() as session:
        session.add(
            DeviceGrant(
                id=1,
                device_id=42,
                subject_type=SUBJECT_EVERYONE,
                subject_id=None,
                expires_at=None,
                created_by_user_id=7,
            )
        )
        await session.commit()
        geladen = await session.get(DeviceGrant, 1)
        assert geladen.subject_type == SUBJECT_EVERYONE
        assert geladen.subject_id is None
        assert geladen.created_at is not None


@pytest.mark.asyncio
async def test_nur_der_besitzer_sieht_und_setzt(client, _auth_signer):
    besitzer, b_uid = await _make_token(_auth_signer)
    gid = await _guild(client, besitzer, "studio")
    kanal = await _voice_channel(client, besitzer, gid)
    r = await client.post(
        f"/guilds/{gid}/devices",
        json={"channel_id": str(kanal), "name": "schnitt-1"},
        headers=_auth(besitzer),
    )
    did = r.json()["id"]

    # Der Fremde ist Mitglied der Community UND traegt MANAGE_GUILD — die
    # Sicherheits-Zusage ist erst dann geprueft, wenn require_member (403 wegen
    # fehlender Mitgliedschaft) nicht schon vorher greift.
    fremd, f_uid = await _mitglied(client, besitzer, gid, _auth_signer)
    role = (
        await client.post(
            f"/guilds/{gid}/roles",
            json={"name": "verwaltung", "permissions": str(int(Permissions.MANAGE_GUILD))},
            headers=_auth(besitzer),
        )
    ).json()
    r_rolle = await client.put(
        f"/guilds/{gid}/members/{f_uid}/roles/{role['id']}",
        headers=_auth(besitzer),
    )
    # **Testschärfe** (Prüfbefund 2026-08-20): ohne diese Zusicherung schlägt
    # die Rollen-Zuweisung still fehl, ohne dass ein späterer Test es merkt —
    # dann prüft dieser Test nicht mehr MANAGE_GUILD gegen 404, sondern einen
    # beliebigen Fremden ohne Rechte, genau das, was ein früherer Commit hier
    # gerade repariert hat.
    assert r_rolle.status_code == 204, r_rolle.text

    # Setzen
    r = await client.put(
        f"/guilds/{gid}/devices/{did}/grants",
        json={"grants": [{"subject_type": "user", "subject_id": str(f_uid)}]},
        headers=_auth(besitzer),
    )
    assert r.status_code == 200, r.text
    assert r.json()[0]["subject_id"] == str(f_uid)

    # Lesen
    r = await client.get(f"/guilds/{gid}/devices/{did}/grants", headers=_auth(besitzer))
    assert len(r.json()) == 1

    # Ein Fremder — auch mit MANAGE_GUILD — darf weder lesen noch setzen: 404,
    # nicht 403, damit die Antwort nicht verraet, wem welche Kennung gehoert.
    r = await client.get(f"/guilds/{gid}/devices/{did}/grants", headers=_auth(fremd))
    assert r.status_code == 404, r.text
    r = await client.put(
        f"/guilds/{gid}/devices/{did}/grants",
        json={"grants": []},
        headers=_auth(fremd),
    )
    assert r.status_code == 404, r.text


@pytest.mark.asyncio
async def test_ersetzen_raeumt_die_alte_liste(client, _auth_signer):
    besitzer, _ = await _make_token(_auth_signer)
    _, a_uid = await _make_token(_auth_signer)
    _, b_uid = await _make_token(_auth_signer)
    gid = await _guild(client, besitzer, "studio")
    kanal = await _voice_channel(client, besitzer, gid)
    did = (
        await client.post(
            f"/guilds/{gid}/devices",
            json={"channel_id": str(kanal), "name": "schnitt-1"},
            headers=_auth(besitzer),
        )
    ).json()["id"]

    await client.put(
        f"/guilds/{gid}/devices/{did}/grants",
        json={"grants": [{"subject_type": "user", "subject_id": str(a_uid)}]},
        headers=_auth(besitzer),
    )
    r = await client.put(
        f"/guilds/{gid}/devices/{did}/grants",
        json={"grants": [{"subject_type": "user", "subject_id": str(b_uid)}]},
        headers=_auth(besitzer),
    )
    assert [g["subject_id"] for g in r.json()] == [str(b_uid)]


@pytest.mark.asyncio
async def test_unsinnige_freigabe_wird_abgewiesen(client, _auth_signer):
    besitzer, _ = await _make_token(_auth_signer)
    gid = await _guild(client, besitzer, "studio")
    kanal = await _voice_channel(client, besitzer, gid)
    did = (
        await client.post(
            f"/guilds/{gid}/devices",
            json={"channel_id": str(kanal), "name": "schnitt-1"},
            headers=_auth(besitzer),
        )
    ).json()["id"]

    # Unbekannte Art
    r = await client.put(
        f"/guilds/{gid}/devices/{did}/grants",
        json={"grants": [{"subject_type": "gruppe", "subject_id": "1"}]},
        headers=_auth(besitzer),
    )
    assert r.status_code == 422
    # user ohne Kennung
    r = await client.put(
        f"/guilds/{gid}/devices/{did}/grants",
        json={"grants": [{"subject_type": "user", "subject_id": None}]},
        headers=_auth(besitzer),
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_gedeckt_nutzer_rolle_jeder_und_abgelaufen():
    """Einheitstest der reinen Funktion ``gedeckt`` — handgebaute Zeilen, keine
    Datenbank, keine Route. Deckt die vier Unterscheidungen ab: Nutzer-Treffer
    (und -Fehltreffer), Rollen-Treffer über die Rollenmenge, ``everyone`` und
    den Ablauf. Dass eine Freigabe die Rechteprüfung am Standplatz NICHT
    ersetzt, prüft NICHT dieser Test, sondern die Tests im Abschnitt
    "Auflösung über den echten Handler-Pfad" unten — dort läuft die Anfrage
    durch ``handle_request``.
    """
    from datetime import UTC, datetime, timedelta

    from dcc_chat_gateway.device_grants import gedeckt
    from dcc_chat_gateway.models import SUBJECT_EVERYONE, SUBJECT_ROLE, SUBJECT_USER

    frisch = datetime.now(UTC) + timedelta(hours=1)
    alt = datetime.now(UTC) - timedelta(hours=1)

    def zeilen(*g):
        return list(g)

    def zeile(id, subject_type, subject_id, expires_at):
        return DeviceGrant(
            id=id,
            device_id=1,
            subject_type=subject_type,
            subject_id=subject_id,
            expires_at=expires_at,
            created_by_user_id=4,
        )

    # Nutzer-Freigabe trifft
    assert gedeckt(
        zeilen(zeile(1, SUBJECT_USER, 9, None)), anfragender_id=9, rollen=set()
    )
    # ... aber nicht für jemand anderen
    assert not gedeckt(
        zeilen(zeile(1, SUBJECT_USER, 9, None)), anfragender_id=10, rollen=set()
    )
    # Rolle trifft über die Rollenmenge
    assert gedeckt(
        zeilen(zeile(2, SUBJECT_ROLE, 77, None)), anfragender_id=10, rollen={77}
    )
    # „jeder" trifft immer
    assert gedeckt(
        zeilen(zeile(3, SUBJECT_EVERYONE, None, None)), anfragender_id=10, rollen=set()
    )
    # Abgelaufen trifft nie
    assert not gedeckt(
        zeilen(zeile(4, SUBJECT_EVERYONE, None, alt)), anfragender_id=10, rollen=set()
    )
    # Noch gültig trifft
    assert gedeckt(
        zeilen(zeile(5, SUBJECT_EVERYONE, None, frisch)), anfragender_id=10, rollen=set()
    )


# ── Auflösung über den echten Handler-Pfad ───────────────────────────────────
#
# Die Tests oben prüfen die reine Rechnung. Hier geht es um das, was
# ``gedeckt`` selbst nicht zusichern kann: dass ``handle_request`` sie erst
# NACH der eigenen Rechteprüfung des Rufers aufruft, dass ``freigabe`` nur bei
# einer Geräte-Anfrage überhaupt im Rahmen steht, und dass eine abgelaufene
# Zeile — echt aus der Datenbank gelesen, nicht handgebaut — nicht durchschlägt
# (der Nachweis für die aiosqlite-Falle in ``gedeckt``: naive ``datetime``
# gegen ``datetime.now(UTC)``).


class _Sock:
    """Eine Verbindung, die aufschreibt, was ihr geschickt wird — Muster aus
    ``tests/test_devices.py``, hier dupliziert statt geteilt (Repo-Konvention:
    Testhilfen sind je Datei selbsttragend)."""

    def __init__(self, app=None) -> None:
        self.sent: list[dict] = []
        self.app = app

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)


class _User:
    def __init__(self, uid: int) -> None:
        self.id = uid
        self.username = f"u{uid}"
        self.is_admin = False
        self.is_owner = False
        self.payload: dict = {}
        self.user_identifier = str(uid)
        self.is_self_host = False


class _Ctx:
    """Der Verbindungskontext, wie ihn die WS-Ops sehen."""

    def __init__(self, sock, user) -> None:
        self.websocket = sock
        self.user = user
        self.last_remote_request = 0.0
        self.last_device_announce = 0.0
        self.last_device_wake = 0.0


def _ctx(client, uid: int) -> _Ctx:
    return _Ctx(_Sock(client._transport.app), _User(uid))


def _register(client):
    return client._transport.app.state.connection_manager


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


async def _fernaufbau(client, _auth_signer):
    """Community-Besitzer, ein zweites Mitglied mit einem Gerät im Standplatz
    ``a``. Muster aus ``tests/test_devices.py::_fernaufbau``."""
    owner_token, owner_uid = await _make_token(_auth_signer)
    gid = await _guild(client, owner_token)
    a = await _voice_channel(client, owner_token, gid, "werkbank")
    host_token, host_uid = await _mitglied(client, owner_token, gid, _auth_signer)
    device = (
        await client.post(
            f"/guilds/{gid}/devices",
            json={"channel_id": str(a), "name": "werkstatt-pc"},
            headers=_auth(host_token),
        )
    ).json()
    return owner_token, owner_uid, host_token, host_uid, int(gid), int(a), device


def _geraet_verbinden(mgr, client, device_id: int, host_uid: int, gid: int, cid: int):
    """Eine Verbindung des Hosts, die sich als dieses Gerät angemeldet hat."""
    sock = _Sock(client._transport.app)
    mgr._ws_user[sock] = _User(host_uid)
    mgr._user_conns.setdefault(host_uid, set()).add(sock)
    mgr.device_announce(sock, device_id, gid, cid)
    return sock


async def _freigeben(session_factory, device_id: int, *, expires_at=None) -> None:
    """``everyone`` am Gerät freigeben — die einfachste Zeile, die jeden trifft,
    der die Standplatz-Rechte hat."""
    async with session_factory() as s:
        s.add(
            DeviceGrant(
                id=next_id(),
                device_id=device_id,
                subject_type=SUBJECT_EVERYONE,
                subject_id=None,
                expires_at=expires_at,
                created_by_user_id=1,
            )
        )
        await s.commit()


@pytest.mark.asyncio
async def test_freigabe_greift_im_rahmen_wenn_remote_control_da_ist(
    client, _auth_signer, session_factory
):
    """Freigabe vorhanden UND der Rufer hat REMOTE_CONTROL am Standplatz (als
    Besitzer ohnehin) → der weitergereichte Rahmen trägt ``freigabe: True``."""
    from dcc_chat_gateway.routes import ws_remote_handlers

    _, owner_uid, _, host_uid, gid, a, device = await _fernaufbau(client, _auth_signer)
    did = int(device["id"])
    await _freigeben(session_factory, did)
    mgr = _register(client)
    sock = _geraet_verbinden(mgr, client, did, host_uid, gid, a)

    ctx = _ctx(client, owner_uid)
    await ws_remote_handlers.handle_request(
        ctx,
        {"channel_id": str(a), "host_user_id": str(host_uid), "device_id": device["id"]},
        session_factory=session_factory,
    )
    einladung = [f for f in sock.sent if f.get("op") == "remote_request"]
    assert len(einladung) == 1
    assert einladung[0]["freigabe"] is True
    mgr.remote_cancel_timeout(mgr.remote_sessions_snapshot()[0].session_id)


@pytest.mark.asyncio
async def test_freigabe_rettet_fehlendes_remote_control_nicht(
    client, _auth_signer, session_factory
):
    """Freigabe vorhanden, aber der RUFER hat kein REMOTE_CONTROL am
    Standplatz: die eigene Rechteprüfung greift vor jeder Freigaben-Rechnung —
    die Anfrage kommt gar nicht bis zum Rahmenbau (4051), die Freigabe wird nie
    ausgewertet. Eine Dauerfreigabe am GERÄT ersetzt nie das Recht des
    RUFERS."""
    from dcc_chat_gateway.routes import ws_remote_handlers

    owner_token, _owner_uid, _, host_uid, gid, a, device = await _fernaufbau(
        client, _auth_signer
    )
    did = int(device["id"])
    await _freigeben(session_factory, did)
    mgr = _register(client)
    _geraet_verbinden(mgr, client, did, host_uid, gid, a)

    # Ein DRITTES Mitglied — ohne Overwrite hat es das Default-@everyone-Recht:
    # VIEW_CHANNEL ja, REMOTE_CONTROL nein (Bit 37 ist nicht im
    # DEFAULT_EVERYONE_PERMISSIONS-Satz).
    _fremd_token, fremd_uid = await _mitglied(client, owner_token, gid, _auth_signer)
    ctx = _ctx(client, fremd_uid)
    await ws_remote_handlers.handle_request(
        ctx,
        {"channel_id": str(a), "host_user_id": str(host_uid), "device_id": device["id"]},
        session_factory=session_factory,
    )
    assert ctx.websocket.sent[-1]["code"] == 4051
    assert mgr.remote_sessions_snapshot() == []


@pytest.mark.asyncio
async def test_anfrage_an_menschen_traegt_keine_freigabe(
    client, _auth_signer, session_factory
):
    """Eine Anfrage OHNE ``device_id`` (an einen Menschen) trägt im Rahmen gar
    kein ``freigabe``-Feld — das Feld gehört nur an eine Geräte-Anfrage."""
    from dcc_chat_gateway.routes import ws_remote_handlers

    owner_token, owner_uid = await _make_token(_auth_signer)
    gid = await _guild(client, owner_token)
    a = await _voice_channel(client, owner_token, gid, "werkbank")
    host_token, host_uid = await _mitglied(client, owner_token, gid, _auth_signer)
    mgr = _register(client)
    host_sock = _Sock(client._transport.app)
    mgr._ws_user[host_sock] = _User(host_uid)
    mgr._user_conns.setdefault(host_uid, set()).add(host_sock)

    ctx = _ctx(client, owner_uid)
    await ws_remote_handlers.handle_request(
        ctx,
        {"channel_id": str(a), "host_user_id": str(host_uid)},
        session_factory=session_factory,
    )
    einladung = [f for f in host_sock.sent if f.get("op") == "remote_request"]
    assert len(einladung) == 1
    assert "freigabe" not in einladung[0]
    assert "device_id" not in einladung[0]
    mgr.remote_cancel_timeout(mgr.remote_sessions_snapshot()[0].session_id)


@pytest.mark.asyncio
async def test_abgelaufene_freigabe_aus_der_datenbank_greift_nicht(
    client, _auth_signer, session_factory
):
    """Der Nachweis für K-1: eine abgelaufene Zeile wird ECHT aus der
    Datenbank gelesen (nicht handgebaut) — unter aiosqlite kommt
    ``expires_at`` dabei naiv zurück. ``gedeckt`` darf daran nicht mit einem
    ``TypeError`` scheitern; das Ergebnis muss ``False`` sein, nicht der
    Absturz des WS-Ops."""
    from datetime import UTC, datetime, timedelta

    from dcc_chat_gateway.routes import ws_remote_handlers

    _, owner_uid, _, host_uid, gid, a, device = await _fernaufbau(client, _auth_signer)
    did = int(device["id"])
    await _freigeben(session_factory, did, expires_at=datetime.now(UTC) - timedelta(hours=1))
    mgr = _register(client)
    sock = _geraet_verbinden(mgr, client, did, host_uid, gid, a)

    ctx = _ctx(client, owner_uid)
    await ws_remote_handlers.handle_request(
        ctx,
        {"channel_id": str(a), "host_user_id": str(host_uid), "device_id": device["id"]},
        session_factory=session_factory,
    )
    einladung = [f for f in sock.sent if f.get("op") == "remote_request"]
    assert len(einladung) == 1
    assert einladung[0]["freigabe"] is False
    mgr.remote_cancel_timeout(mgr.remote_sessions_snapshot()[0].session_id)


@pytest.mark.asyncio
async def test_community_wechsel_raeumt_rollen_freigaben(client, _auth_signer):
    besitzer, _ = await _make_token(_auth_signer)
    _, gast = await _make_token(_auth_signer)
    quelle = await _guild(client, besitzer, "projekt-nord")
    ziel = await _guild(client, besitzer, "projekt-sued")
    k_quelle = await _voice_channel(client, besitzer, quelle)
    k_ziel = await _voice_channel(client, besitzer, ziel, "schnitt-2")
    rolle = (
        await client.post(
            f"/guilds/{quelle}/roles", json={"name": "cutter"}, headers=_auth(besitzer)
        )
    ).json()["id"]
    did = (
        await client.post(
            f"/guilds/{quelle}/devices",
            json={"channel_id": str(k_quelle), "name": "schnitt-1"},
            headers=_auth(besitzer),
        )
    ).json()["id"]
    await client.put(
        f"/guilds/{quelle}/devices/{did}/grants",
        json={
            "grants": [
                {"subject_type": "role", "subject_id": str(rolle)},
                {"subject_type": "user", "subject_id": str(gast)},
            ]
        },
        headers=_auth(besitzer),
    )

    await client.patch(
        f"/guilds/{quelle}/devices/{did}",
        json={"guild_id": str(ziel), "channel_id": str(k_ziel)},
        headers=_auth(besitzer),
    )

    # Die Rolle ist weg, der Nutzer bleibt: Nutzerkennungen gelten serverweit,
    # Rollenkennungen nur in ihrer Community.
    r = await client.get(f"/guilds/{ziel}/devices/{did}/grants", headers=_auth(besitzer))
    arten = sorted(g["subject_type"] for g in r.json())
    assert arten == ["user"]


@pytest.mark.asyncio
async def test_community_wechsel_scheitert_laesst_rollen_freigaben_stehen(
    client, _auth_signer
):
    besitzer, _ = await _make_token(_auth_signer)
    quelle = await _guild(client, besitzer, "projekt-ost")
    ziel = await _guild(client, besitzer, "projekt-west")
    k_quelle = await _voice_channel(client, besitzer, quelle)
    k_ziel = await _voice_channel(client, besitzer, ziel, "schnitt-2")
    rolle = (
        await client.post(
            f"/guilds/{quelle}/roles", json={"name": "cutter"}, headers=_auth(besitzer)
        )
    ).json()["id"]
    did = (
        await client.post(
            f"/guilds/{quelle}/devices",
            json={"channel_id": str(k_quelle), "name": "schnitt-1"},
            headers=_auth(besitzer),
        )
    ).json()["id"]
    await client.put(
        f"/guilds/{quelle}/devices/{did}/grants",
        json={"grants": [{"subject_type": "role", "subject_id": str(rolle)}]},
        headers=_auth(besitzer),
    )
    # Namenskonflikt in der Zielcommunity: dort steht bereits ein Gerät mit
    # demselben Namen.
    await client.post(
        f"/guilds/{ziel}/devices",
        json={"channel_id": str(k_ziel), "name": "schnitt-1"},
        headers=_auth(besitzer),
    )

    r = await client.patch(
        f"/guilds/{quelle}/devices/{did}",
        json={"guild_id": str(ziel), "channel_id": str(k_ziel)},
        headers=_auth(besitzer),
    )
    assert r.status_code == 409

    r = await client.get(f"/guilds/{quelle}/devices/{did}/grants", headers=_auth(besitzer))
    arten = sorted(g["subject_type"] for g in r.json())
    assert arten == ["role"]
