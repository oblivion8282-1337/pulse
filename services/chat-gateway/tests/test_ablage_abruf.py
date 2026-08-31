"""Weiterreich-Route eines Ablage-Kanals (Etappe E7, Design §4.0-4.2).

Jede Regel aus §4.2 einzeln als Sicherheitstest — die Reihenfolge folgt der
Aufzaehlung im Auftrag: ``..``, kodiertes ``..``, absoluter Pfad, ``file://``,
Umleitung auf 127.0.0.1, Umleitung auf einen privat aufloesenden Namen, zu
grosse Antwort, Nicht-Mitglied. Dazu der gute Fall und die PUT-Route, die die
Adresse setzt (nur der Ersteller darf sie ersetzen).

Die eigentliche TCP-Verbindung wird nie aufgebaut: ``httpx.AsyncClient`` wird
fuer die Dauer jedes Tests durch einen ``httpx.MockTransport`` ersetzt (echte
Aufloesung/Normalisierung/SSRF-Pruefung laufen trotzdem — nur die Leitung ist
simuliert), und die Namensaufloesung laeuft ueber einen festen Testresolver
statt echtem DNS.
"""

from __future__ import annotations

import random

import dcc_chat_gateway.ablage_ssrf as ablage_ssrf
import dcc_chat_gateway.config as chat_config
import httpx
import pytest

BASIS = "https://cloud.example/pub"


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register_user(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


async def _guild_mit_ablage_kanal(client, _auth_signer, basis: str = BASIS):
    """Owner + ein zweites Mitglied; ein dritter Token bleibt bewusst
    aussen vor (Nicht-Mitglied-Fall)."""
    t_owner, _ = await _register_user(_auth_signer)
    t_mitglied, uid_mitglied = await _register_user(_auth_signer)
    t_fremd, _ = await _register_user(_auth_signer)

    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t_owner))).json()
    await client.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": str(uid_mitglied)},
        headers=auth(t_owner),
    )
    c = (
        await client.post(
            f"/guilds/{g['id']}/channels",
            json={"name": "ablage-raum", "ablage": True},
            headers=auth(t_owner),
        )
    ).json()

    r = await client.put(
        f"/channels/{c['id']}/ablage/laufwerk",
        json={"freigabe_adresse": basis},
        headers=auth(t_owner),
    )
    assert r.status_code == 204, r.text

    return t_owner, t_mitglied, t_fremd, c["id"]


@pytest.fixture
def kein_dns(monkeypatch):
    """Feste Namensaufloesung statt echtem DNS: ``cloud.example`` (die
    Basis-Adresse) loest oeffentlich auf, ``boese.example`` (fuer den
    Umleitungs-Test) privat."""

    async def _resolver(host: str) -> list[str]:
        zuordnung = {
            "cloud.example": ["203.0.113.10"],  # RFC-5737-Doku-Adresse, oeffentlich
            "boese.example": ["10.1.2.3"],  # 10/8 -> privat
        }
        if host not in zuordnung:
            raise OSError(f"unerwarteter Host im Test: {host}")
        return zuordnung[host]

    monkeypatch.setattr(ablage_ssrf, "standard_resolver", _resolver)
    return _resolver


@pytest.fixture
def upstream(monkeypatch):
    """Ersetzt die TCP-Ebene NUR fuer ``ablage_ssrf.hole`` (ueber dessen
    eigenen ``client_ctor``-Namen, s. dort) — der Test-HTTP-Client, mit dem
    dieser Test selbst die App anspricht, bleibt unberuehrt. ``setze(handler)``
    legt fest, was die simulierte Gegenstelle antwortet."""
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


@pytest.fixture(autouse=True)
def _abruf_grenzen_zuruecksetzen():
    yield
    chat_config.get_settings().ablage_abruf_max_bytes = 8 * 1024 * 1024


# ---------------------------------------------------------------------------
# Guter Fall
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_guter_fall_liefert_das_chiffrat(client, _auth_signer, kein_dns, upstream):
    def handler(request: httpx.Request) -> httpx.Response:
        # Die Verbindung geht an die GEPRUEFTE IP (DNS-Rebinding-Schutz,
        # s. ablage_ssrf._url_auf_adresse_verankern), Host-Kopfzeile und
        # Pfad zeigen trotzdem weiter auf den urspruenglichen Namen.
        assert request.url.host == "203.0.113.10"
        assert request.headers["host"] == "cloud.example"
        assert request.extensions.get("sni_hostname") == "cloud.example"
        assert request.url.path == "/pub/segmente/0001.bin"
        return httpx.Response(200, content=b"chiffrat-bytes", headers={"content-type": "application/octet-stream"})

    upstream(handler)
    _, t_mitglied, _, cid = await _guild_mit_ablage_kanal(client, _auth_signer)

    r = await client.get(
        f"/channels/{cid}/ablage/abruf",
        params={"pfad": "segmente/0001.bin"},
        headers=auth(t_mitglied),
    )
    assert r.status_code == 200, r.text
    assert r.content == b"chiffrat-bytes"
    assert r.headers["content-type"] == "application/octet-stream"
    # Die Freigabe-Adresse darf in keiner Antwort auftauchen.
    assert "cloud.example" not in r.text


@pytest.mark.asyncio
async def test_nicht_mitglied_wird_abgewiesen(client, _auth_signer, kein_dns, upstream):
    upstream(lambda req: httpx.Response(200, content=b"x"))
    _, _, t_fremd, cid = await _guild_mit_ablage_kanal(client, _auth_signer)

    r = await client.get(
        f"/channels/{cid}/ablage/abruf",
        params={"pfad": "segmente/0001.bin"},
        headers=auth(t_fremd),
    )
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# Pfad-Ausbrueche
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "pfad",
    [
        "../geheim",
        "a/../../geheim",
        "%2e%2e/geheim",  # kodiertes ".."
        "%252e%252e/geheim",  # doppelt kodiertes ".."
        "/etc/passwd",  # absoluter Pfad
        "file:///etc/passwd",  # Schema-Wechsel
        "http://andere-stelle.example/x",  # Schema-Wechsel (versteckte URL)
    ],
)
@pytest.mark.asyncio
async def test_pfad_ausbrueche_werden_abgewiesen(client, _auth_signer, kein_dns, upstream, pfad):
    aufgerufen = False

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal aufgerufen
        aufgerufen = True
        return httpx.Response(200, content=b"sollte-nie-passieren")

    upstream(handler)
    _, t_mitglied, _, cid = await _guild_mit_ablage_kanal(client, _auth_signer)

    r = await client.get(
        f"/channels/{cid}/ablage/abruf",
        params={"pfad": pfad},
        headers=auth(t_mitglied),
    )
    assert r.status_code == 422, r.text
    assert not aufgerufen, "die Ausbruch-Pfade duerfen nie eine Anfrage ausloesen"


# ---------------------------------------------------------------------------
# Umleitungen ins private Netz
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_umleitung_auf_127_0_0_1_wird_abgewiesen(client, _auth_signer, kein_dns, upstream):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.headers["host"] == "cloud.example":
            return httpx.Response(302, headers={"location": "http://127.0.0.1:9999/geheim"})
        raise AssertionError("die Umleitung haette nie verfolgt werden duerfen")

    upstream(handler)
    _, t_mitglied, _, cid = await _guild_mit_ablage_kanal(client, _auth_signer)

    r = await client.get(
        f"/channels/{cid}/ablage/abruf",
        params={"pfad": "x"},
        headers=auth(t_mitglied),
    )
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_umleitung_auf_privat_aufloesenden_namen_wird_abgewiesen(
    client, _auth_signer, kein_dns, upstream
):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.headers["host"] == "cloud.example":
            return httpx.Response(302, headers={"location": "https://boese.example/geheim"})
        raise AssertionError("die Umleitung haette nie verfolgt werden duerfen")

    upstream(handler)
    _, t_mitglied, _, cid = await _guild_mit_ablage_kanal(client, _auth_signer)

    r = await client.get(
        f"/channels/{cid}/ablage/abruf",
        params={"pfad": "x"},
        headers=auth(t_mitglied),
    )
    assert r.status_code == 403, r.text


# ---------------------------------------------------------------------------
# DNS-Rebinding: die Verbindung muss an die GEPRUEFTE Adresse gebunden sein,
# nicht an einen Namen, der beim tatsaechlichen Verbindungsaufbau ein zweites
# Mal (und diesmal anders) aufgeloest werden koennte.
# ---------------------------------------------------------------------------


@pytest.fixture
def wackelnder_resolver(monkeypatch):
    """Simuliert einen vom Angreifer kontrollierten Nameserver mit sehr
    kurzer Gueltigkeit: der ERSTE Aufruf liefert eine oeffentliche Adresse
    (besteht die Pruefung), jeder WEITERE eine private (das eigentliche
    Ziel). Ohne Bindung an die geprueften Adresse wuerde ein Verbindungs-
    aufbau, der den Namen selbst noch einmal aufloest, auf der privaten
    Adresse landen."""
    aufrufe = {"n": 0}

    async def _resolver(host: str) -> list[str]:
        aufrufe["n"] += 1
        if host != "wackel.example":
            raise OSError(f"unerwarteter Host im Test: {host}")
        if aufrufe["n"] == 1:
            return ["203.0.113.20"]  # oeffentlich - besteht die Pruefung
        return ["10.9.9.9"]  # 10/8 - das eigentliche, private Ziel

    monkeypatch.setattr(ablage_ssrf, "standard_resolver", _resolver)
    return aufrufe


@pytest.mark.asyncio
async def test_dns_rebinding_wird_nicht_ausgenutzt(
    client, _auth_signer, wackelnder_resolver, upstream
):
    def handler(request: httpx.Request) -> httpx.Response:
        # Die tatsaechliche Verbindung geht an die beim einzigen Resolver-
        # Aufruf geprueften Adresse - niemals an die private, die ein
        # zweiter Lookup geliefert haette.
        assert request.url.host == "203.0.113.20"
        assert request.headers["host"] == "wackel.example"
        return httpx.Response(200, content=b"chiffrat-bytes")

    upstream(handler)
    _, t_mitglied, _, cid = await _guild_mit_ablage_kanal(
        client, _auth_signer, basis="https://wackel.example/pub"
    )

    r = await client.get(
        f"/channels/{cid}/ablage/abruf",
        params={"pfad": "x"},
        headers=auth(t_mitglied),
    )
    assert r.status_code == 200, r.text
    assert r.content == b"chiffrat-bytes"
    # Genau EIN Resolver-Aufruf fuer die gesamte Anfrage: kein zweiter
    # Lookup beim Verbindungsaufbau, der die private Adresse haette liefern
    # koennen.
    assert wackelnder_resolver["n"] == 1


# ---------------------------------------------------------------------------
# Groessenlimit
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_zu_grosse_antwort_wird_abgewiesen(client, _auth_signer, kein_dns, upstream):
    chat_config.get_settings().ablage_abruf_max_bytes = 8

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"x" * 4096)

    upstream(handler)
    _, t_mitglied, _, cid = await _guild_mit_ablage_kanal(client, _auth_signer)

    r = await client.get(
        f"/channels/{cid}/ablage/abruf",
        params={"pfad": "x"},
        headers=auth(t_mitglied),
    )
    assert r.status_code == 413, r.text


# ---------------------------------------------------------------------------
# Die Freigabe-Adresse: nur der Ersteller darf sie setzen/ersetzen
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_nur_ersteller_darf_die_adresse_ersetzen(client, _auth_signer):
    t_owner, t_mitglied, _, cid = await _guild_mit_ablage_kanal(client, _auth_signer)

    r = await client.put(
        f"/channels/{cid}/ablage/laufwerk",
        json={"freigabe_adresse": "https://andere.example/pub"},
        headers=auth(t_mitglied),
    )
    assert r.status_code == 403
    # Und keine Spur der urspruenglichen ODER der versuchten Adresse in der
    # Antwort.
    assert "cloud.example" not in r.text
    assert "andere.example" not in r.text

    r = await client.put(
        f"/channels/{cid}/ablage/laufwerk",
        json={"freigabe_adresse": "https://cloud.example/pub2"},
        headers=auth(t_owner),
    )
    assert r.status_code == 204


@pytest.mark.asyncio
async def test_laufwerk_route_lehnt_nicht_ablage_kanal_ab(client, _auth_signer):
    t_owner, _ = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t_owner))).json()
    c = (
        await client.post(
            f"/guilds/{g['id']}/channels", json={"name": "normal"}, headers=auth(t_owner)
        )
    ).json()

    r = await client.put(
        f"/channels/{c['id']}/ablage/laufwerk",
        json={"freigabe_adresse": "https://cloud.example/pub"},
        headers=auth(t_owner),
    )
    assert r.status_code == 404
