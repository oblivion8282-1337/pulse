"""Tests für die Erreichbarkeitsprüfung eines Self-Hosts von aussen.

Zwei Dinge werden hier festgehalten, und beide sind teurer als sie aussehen:

1. **Wer fragen darf.** Die Prüfung öffnet ein Dutzend Verbindungen zu einem
   fremden Rechner und verrät nebenbei dessen IP-Adressen. Ein Unbeteiligter
   darf davon nichts bekommen — auch nicht die Auskunft, dass es die Instanz
   überhaupt gibt (404 statt 403).
2. **Wo die Kette abbricht.** Nach einem gescheiterten Schritt dürfen die
   nachgelagerten nicht mehr laufen: sie meldeten nur dieselbe Ursache ein
   zweites Mal und zögen den Blick vom eigentlichen Befund weg. Getestet wird
   das mit ausgetauschten Schritten, ohne echtes Netz.
"""

from __future__ import annotations

import asyncio
import secrets

import pytest
import pytest_asyncio

from dcc_auth import routes_selfhost_diagnose as diag
from dcc_auth import selfhost_probe_dienst as dienst
from dcc_auth.models_instances import RegisteredInstance
from dcc_auth.security import hash_password
from dcc_auth.selfhost_probe import Schritt, ist_oeffentlich

_REG_A = {
    "username": "diag_alice",
    "email": "diag_alice@dcc-test.example.com",
    "password": "correct horse battery staple",
    "display_name": "Alice",
}
_REG_B = {
    "username": "diag_bob",
    "email": "diag_bob@dcc-test.example.com",
    "password": "correct horse battery staple",
    "display_name": "Bob",
}
_INSTANCE_ID = 22000000000000001
_SECRET = "s3cret-instance-secret"


async def _reg_and_login(client, reg: dict) -> tuple[str, str]:
    await client.post("/register", json=reg)
    r = await client.post(
        "/login", json={"email_or_username": reg["email"], "password": reg["password"]}
    )
    assert r.status_code == 200, r.text
    sid = r.cookies.get("pulse_session")
    me = await client.get("/me", headers={"Cookie": f"pulse_session={sid}"})
    return f"pulse_session={sid}", me.json()["id"]


@pytest_asyncio.fixture
async def alice(client):
    cookie, uid = await _reg_and_login(client, _REG_A)
    return {"cookie": cookie, "id": uid}


@pytest_asyncio.fixture
async def bob(client):
    cookie, uid = await _reg_and_login(client, _REG_B)
    return {"cookie": cookie, "id": uid}


@pytest_asyncio.fixture
async def instance(session_factory, alice):
    client_id = f"ci_{secrets.token_hex(8)}"
    async with session_factory() as session:
        session.add(
            RegisteredInstance(
                id=_INSTANCE_ID,
                hostname="diagnose.example.com",
                client_id=client_id,
                client_secret=hash_password(_SECRET),
                worker_id_chat=410,
                worker_id_voice=411,
                worker_id_media=412,
                status="active",
                registered_by=int(alice["id"]),
            )
        )
        await session.commit()
    return {"id": str(_INSTANCE_ID), "client_id": client_id}


@pytest.fixture
def ohne_netz(monkeypatch):
    """Ersetzt die Prüfung durch eine feste Antwort — kein echtes Netz im Test."""

    def setze(schritte: list[Schritt]):
        async def gefaelscht(*_a, **_k):
            return schritte

        monkeypatch.setattr(diag, "_fuehre_pruefung", gefaelscht)

    return setze


# ---------------------------------------------------------------------------
# Wer fragen darf
# ---------------------------------------------------------------------------


async def test_besitzer_darf(client, alice, instance, ohne_netz):
    ohne_netz([Schritt("dns", True, "aufgeloest", "203.0.113.7")])
    r = await client.post(
        f"/selfhost/diagnose/{instance['id']}", headers={"Cookie": alice["cookie"]}
    )
    assert r.status_code == 200, r.text
    assert r.json()["gesamt"] == "ok"
    assert r.json()["hostname"] == "diagnose.example.com"


async def test_fremder_bekommt_404_nicht_403(client, bob, instance, ohne_netz):
    # 403 verriete, dass es die Instanz gibt. Für einen Unbeteiligten existiert
    # sie schlicht nicht.
    ohne_netz([])
    r = await client.post(
        f"/selfhost/diagnose/{instance['id']}", headers={"Cookie": bob["cookie"]}
    )
    assert r.status_code == 404


async def test_ohne_anmeldung_kein_zugang(client, instance, ohne_netz):
    ohne_netz([])
    r = await client.post(f"/selfhost/diagnose/{instance['id']}")
    assert r.status_code in (401, 404)


async def test_instanz_weist_sich_selbst_aus(client, instance, ohne_netz):
    # Der Weg des Installers: er hat client_id + secret aus dem Bootstrap und
    # keine Sitzung.
    ohne_netz([Schritt("dns", True, "aufgeloest")])
    r = await client.post(
        f"/selfhost/diagnose/{instance['id']}",
        headers={
            "X-Pulse-Client-Id": instance["client_id"],
            "X-Pulse-Client-Secret": _SECRET,
        },
    )
    assert r.status_code == 200, r.text


async def test_falsches_secret_ist_404(client, instance, ohne_netz):
    ohne_netz([])
    r = await client.post(
        f"/selfhost/diagnose/{instance['id']}",
        headers={
            "X-Pulse-Client-Id": instance["client_id"],
            "X-Pulse-Client-Secret": "falsch",
        },
    )
    assert r.status_code == 404


async def test_unbekannte_instanz_ist_404(client, alice, ohne_netz):
    ohne_netz([])
    for kennung in ("999999999999", "keine-zahl"):
        r = await client.post(
            f"/selfhost/diagnose/{kennung}", headers={"Cookie": alice["cookie"]}
        )
        assert r.status_code == 404, kennung


# ---------------------------------------------------------------------------
# Das Gesamturteil
# ---------------------------------------------------------------------------


async def test_gesamt_nennt_den_ERSTEN_fehlschlag(client, alice, instance, ohne_netz):
    # Nicht den letzten und nicht „fehler": der Betreiber soll wissen, WO die
    # Kette abriss — alles danach ist Folge, nicht Ursache.
    ohne_netz(
        [
            Schritt("dns", True, "aufgeloest"),
            Schritt("tcp443", True, "offen"),
            Schritt("tls", False, "abgelaufen"),
            Schritt("stun", False, "kein_durchkommen"),
        ]
    )
    r = await client.post(
        f"/selfhost/diagnose/{instance['id']}", headers={"Cookie": alice["cookie"]}
    )
    assert r.json()["gesamt"] == "tls"


async def test_alle_schritte_kommen_mit(client, alice, instance, ohne_netz):
    ohne_netz(
        [
            Schritt("dns", True, "aufgeloest", "203.0.113.7"),
            Schritt("websocket", False, "kein_upgrade", "HTTP/1.1 200 OK"),
        ]
    )
    r = await client.post(
        f"/selfhost/diagnose/{instance['id']}", headers={"Cookie": alice["cookie"]}
    )
    schritte = r.json()["schritte"]
    assert [s["schritt"] for s in schritte] == ["dns", "websocket"]
    assert schritte[1]["befund"] == "kein_upgrade"
    assert schritte[1]["einzelheit"] == "HTTP/1.1 200 OK"


# ---------------------------------------------------------------------------
# Der Abbruch der Kette
# ---------------------------------------------------------------------------


async def test_ohne_dns_wird_nichts_weiter_versucht(monkeypatch):
    gerufen: list[str] = []

    async def dns(_host):
        gerufen.append("dns")
        return Schritt("dns", False, "name_unbekannt")

    async def darf_nicht(*_a, **_k):
        gerufen.append("verboten")
        return Schritt("x", True, "x")

    monkeypatch.setattr(diag, "pruefe_dns", dns)
    monkeypatch.setattr(diag, "pruefe_tcp", darf_nicht)
    monkeypatch.setattr(diag, "pruefe_tls", darf_nicht)
    monkeypatch.setattr(diag, "pruefe_stun", darf_nicht)

    schritte = await diag._fuehre_pruefung("x.example.com", "1", "https://cloud")
    assert gerufen == ["dns"]
    assert len(schritte) == 1


async def test_ohne_gueltiges_zertifikat_keine_http_schritte(monkeypatch):
    """Health, Identität, CORS und der WebSocket reiten alle auf demselben TLS.

    Scheitert das Zertifikat, meldeten sie vier Fehlschläge für EINE Ursache.
    Ton und Bild (STUN, RTMPS) hängen an eigenen Ports und laufen weiter — sie
    haben eine eigene Firewall-Regel und damit einen eigenen Befund.
    """
    gerufen: list[str] = []

    async def dns(_host):
        return Schritt("dns", True, "aufgeloest", adressen=["203.0.113.7"])

    async def tcp(_adr, port, name="tcp"):
        gerufen.append(name)
        return Schritt(name, True, "offen")

    async def tls(*_a):
        return Schritt("tls", False, "abgelaufen")

    async def stun(_adr, port=3478):
        gerufen.append("stun")
        return Schritt("stun", True, "antwortet")

    async def http_darf_nicht(*_a, **_k):
        gerufen.append("http")
        return Schritt("health", True, "gesund")

    monkeypatch.setattr(diag, "pruefe_dns", dns)
    monkeypatch.setattr(diag, "pruefe_tcp", tcp)
    monkeypatch.setattr(diag, "pruefe_tls", tls)
    monkeypatch.setattr(diag, "pruefe_stun", stun)
    monkeypatch.setattr(diag, "pruefe_health", http_darf_nicht)
    monkeypatch.setattr(diag, "pruefe_identitaet", http_darf_nicht)
    monkeypatch.setattr(diag, "pruefe_cors", http_darf_nicht)
    monkeypatch.setattr(diag, "pruefe_websocket", http_darf_nicht)

    schritte = await diag._fuehre_pruefung("x.example.com", "1", "https://cloud")
    assert "http" not in gerufen
    assert "stun" in gerufen and "rtmps" in gerufen
    assert [s.schritt for s in schritte] == ["dns", "tcp443", "tls", "stun", "rtmps"]


# ---------------------------------------------------------------------------
# SSRF-Schranke
# ---------------------------------------------------------------------------


def test_interne_adressen_gelten_nie_als_oeffentlich():
    for adr in (
        "10.1.2.3",
        "172.16.0.1",
        "192.168.1.1",
        "127.0.0.1",
        "169.254.1.1",
        "100.70.0.1",  # CGNAT
        "::1",
        "fe80::1",
        "fc00::1",
        "keine-adresse",
    ):
        assert not ist_oeffentlich(adr), adr


def test_oeffentliche_adressen_kommen_durch():
    for adr in ("203.0.113.7", "8.8.8.8", "2606:4700::1111"):
        assert ist_oeffentlich(adr), adr


# ---------------------------------------------------------------------------
# Der Close-Rahmen, von Hand gelesen
# ---------------------------------------------------------------------------


class _Leser:
    """Minimaler StreamReader-Ersatz — gibt vorgegebene Bytes stückweise heraus."""

    def __init__(self, daten: bytes) -> None:
        self._daten = daten
        self._pos = 0

    async def readexactly(self, n: int) -> bytes:
        if self._pos + n > len(self._daten):
            raise asyncio.IncompleteReadError(self._daten[self._pos :], n)
        stueck = self._daten[self._pos : self._pos + n]
        self._pos += n
        return stueck


async def test_schliesscode_wird_aus_dem_rahmen_gelesen():
    # 0x88 = FIN + Opcode 8 (Close), Länge 2, dann der Code in Netz-Reihenfolge.
    assert await dienst._lies_schliesscode(_Leser(b"\x88\x02\x0f\xa1")) == 4001
    assert await dienst._lies_schliesscode(_Leser(b"\x88\x02\x0f\xce")) == 4046
    assert await dienst._lies_schliesscode(_Leser(b"\x88\x02\x0f\xe6")) == 4070


async def test_schliesscode_mit_grundtext_dahinter():
    # Der Server hängt den Grund als Text an — nur die ersten zwei Byte zählen.
    rahmen = b"\x88\x0e\x0f\xa1" + b"unauthorized"
    assert await dienst._lies_schliesscode(_Leser(rahmen)) == 4001


async def test_kein_close_rahmen_ergibt_keinen_code():
    # Ein Text-Rahmen (Opcode 1) ist kein Schliessen — daraus einen Code zu
    # lesen hiesse, zwei Byte Nutzlast als Diagnose auszugeben.
    assert await dienst._lies_schliesscode(_Leser(b"\x81\x05hallo")) is None
    # Close ohne Code (Länge 0) sagt nichts.
    assert await dienst._lies_schliesscode(_Leser(b"\x88\x00")) is None
    # Abgeschnitten mitten im Rahmen: keine Aussage, kein Absturz.
    assert await dienst._lies_schliesscode(_Leser(b"\x88")) is None
    assert await dienst._lies_schliesscode(_Leser(b"\x88\x02\x0f")) is None


# ---------------------------------------------------------------------------
# Die Festnagelung auf die geprüfte Adresse
# ---------------------------------------------------------------------------
#
# ``pruefe_dns`` hält die aufgelösten Adressen gegen die internen Netze. Löste
# ein späterer Aufruf den Namen ERNEUT auf, wäre diese Prüfung eine
# Momentaufnahme ohne Wirkung: wer die Zone kontrolliert, liefert beim ersten
# Mal eine öffentliche Adresse und beim zweiten 127.0.0.1. Blind wäre das nicht
# einmal — der CORS-Schritt gibt einen Antwort-Kopf zurück, der Identitäts-
# Schritt ein Feld aus dem Körper.


def test_ziel_verbindet_zur_ip_und_nennt_den_namen():
    z = dienst.Ziel("chat.firma.de", "203.0.113.7")
    assert z.url("/health") == "https://203.0.113.7/health"
    assert z.kopf()["Host"] == "chat.firma.de"
    # Der TLS-Name bleibt der echte — nur so prüft das Zertifikat noch etwas.
    assert z.sni == {"sni_hostname": "chat.firma.de"}


def test_ziel_klammert_ipv6():
    z = dienst.Ziel("chat.firma.de", "2606:4700::1111")
    assert z.url("/health") == "https://[2606:4700::1111]/health"


def test_ziel_haengt_zusatzkoepfe_an_ohne_host_zu_verlieren():
    z = dienst.Ziel("chat.firma.de", "203.0.113.7")
    kopf = z.kopf({"Origin": "https://cloud"})
    assert kopf["Host"] == "chat.firma.de"
    assert kopf["Origin"] == "https://cloud"


async def test_http_schritte_loesen_den_namen_nicht_erneut_auf():
    """Kein Schritt darf den Hostnamen in die URL setzen."""

    gesehen: list[tuple[str, dict, dict]] = []

    class _Klient:
        async def get(self, url, headers=None, extensions=None):
            gesehen.append((url, headers or {}, extensions or {}))
            raise RuntimeError("Antwort egal — geprüft wird die Anfrage")

        async def options(self, url, headers=None, extensions=None):
            gesehen.append((url, headers or {}, extensions or {}))
            raise RuntimeError("Antwort egal — geprüft wird die Anfrage")

    z = dienst.Ziel("chat.firma.de", "203.0.113.7")
    k = _Klient()
    await dienst.pruefe_health(k, z)
    await dienst.pruefe_identitaet(k, z, "1")
    await dienst.pruefe_cors(k, z, "https://cloud")

    assert len(gesehen) == 3
    for url, kopf, ext in gesehen:
        assert "chat.firma.de" not in url, f"Name in der URL: {url}"
        assert url.startswith("https://203.0.113.7/")
        assert kopf["Host"] == "chat.firma.de"
        assert ext["sni_hostname"] == "chat.firma.de"
