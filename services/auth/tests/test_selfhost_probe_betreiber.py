"""Tests für den Betreiber-Schritt der Erreichbarkeitsprüfung.

Der Schritt beantwortet die Frage, an der am 2026-08-27 ein ganzer Abend hing:
Erkennt dieser Server den Fragenden als seinen Betreiber? Sieben Glieder waren
grün, der Server lief, und trotzdem konnte sein Betreiber dort nichts anlegen —
sichtbar war das allein in einer Log-Zeile auf der Maschine.

Geprüft wird hier die Cloud-Seite: dass sie ein gültiges, an genau diese Instanz
gebundenes Token schickt, und dass sie jede Antwort in den Befund übersetzt, der
den passenden Handgriff auslöst.
"""

from __future__ import annotations

import httpx
import jwt
import pytest

from dcc_auth.selfhost_probe_betreiber import ZWECK, pruefe_betreiber
from dcc_auth.selfhost_probe_dienst import Ziel

INSTANZ = 86083174400004096
KONTO = 73315227868860416


def _ziel() -> Ziel:
    return Ziel("pulse.example.com", "203.0.113.7")


def _klient(antwort: httpx.Response, gesehen: list[httpx.Request] | None = None):
    def handler(request: httpx.Request) -> httpx.Response:
        if gesehen is not None:
            gesehen.append(request)
        return antwort

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _json(daten: dict) -> httpx.Response:
    return httpx.Response(200, json=daten)


_GESUND = {"modus_self_host": True, "owner_konfiguriert": True, "stimmt_ueberein": True}


# --- Befunde --------------------------------------------------------------


@pytest.mark.asyncio
async def test_erkannt():
    async with _klient(_json(_GESUND)) as klient:
        schritt = await pruefe_betreiber(klient, _ziel(), INSTANZ, KONTO)
    assert schritt.ok
    assert schritt.befund == "erkannt"


@pytest.mark.asyncio
async def test_andere_kennung():
    """Der Fall vom 2026-08-27: irgendeine Kennung ist konfiguriert, nur nicht
    die des Betreibers."""
    async with _klient(_json({**_GESUND, "stimmt_ueberein": False})) as klient:
        schritt = await pruefe_betreiber(klient, _ziel(), INSTANZ, KONTO)
    assert not schritt.ok
    assert schritt.befund == "andere_kennung"


@pytest.mark.asyncio
async def test_nicht_konfiguriert():
    antwort = _json({**_GESUND, "owner_konfiguriert": False, "stimmt_ueberein": False})
    async with _klient(antwort) as klient:
        schritt = await pruefe_betreiber(klient, _ziel(), INSTANZ, KONTO)
    assert schritt.befund == "nicht_konfiguriert"


@pytest.mark.asyncio
async def test_kein_self_host_gewinnt_gegen_die_kennung():
    """Steht die Betriebsart falsch, wird niemand Admin — auch mit der richtigen
    Kennung. Der Befund muss deshalb DIESEN Grund nennen, nicht den anderen."""
    antwort = _json({**_GESUND, "modus_self_host": False})
    async with _klient(antwort) as klient:
        schritt = await pruefe_betreiber(klient, _ziel(), INSTANZ, KONTO)
    assert schritt.befund == "kein_self_host"


@pytest.mark.asyncio
async def test_aelterer_server_ist_kein_fehlalarm():
    """Ein Server ohne diesen Endpunkt antwortet 404. Das ist KEIN Fehler seiner
    Konfiguration — der Befund muss sich davon unterscheiden, sonst schickt die
    Prüfung Betreiber auf die Suche nach einem Problem, das es nicht gibt."""
    async with _klient(httpx.Response(404)) as klient:
        schritt = await pruefe_betreiber(klient, _ziel(), INSTANZ, KONTO)
    assert schritt.befund == "keine_auskunft"


@pytest.mark.asyncio
async def test_spa_rueckfall_ist_auch_keine_auskunft():
    """Fehlt die Proxy-Zeile, liefert der SPA-Rückfall HTML mit Status 200 —
    dieselbe Falle, die die Cloud-Poller schon einmal erwischt hat."""
    antwort = httpx.Response(200, text="<!doctype html><title>Pulse</title>")
    async with _klient(antwort) as klient:
        schritt = await pruefe_betreiber(klient, _ziel(), INSTANZ, KONTO)
    assert schritt.befund == "keine_auskunft"


@pytest.mark.asyncio
async def test_abgelehnte_signatur_hat_einen_eigenen_befund():
    """401 heisst: der Server konnte unsere Signatur nicht prüfen — meist, weil
    er die Cloud noch nie erreicht hat. Das ist ein anderer Handgriff als eine
    falsche Kennung."""
    async with _klient(httpx.Response(401)) as klient:
        schritt = await pruefe_betreiber(klient, _ziel(), INSTANZ, KONTO)
    assert schritt.befund == "signatur_abgelehnt"


@pytest.mark.asyncio
async def test_keine_antwort():
    def kaputt(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("weg")

    async with httpx.AsyncClient(transport=httpx.MockTransport(kaputt)) as klient:
        schritt = await pruefe_betreiber(klient, _ziel(), INSTANZ, KONTO)
    assert schritt.befund == "keine_auskunft"


# --- Das Token ------------------------------------------------------------


@pytest.mark.asyncio
async def test_token_traegt_zweck_instanz_und_erwartete_kennung():
    """Die erwartete Kennung steht IM Token, nicht im Aufruf — nur so ist sie
    nicht fälschbar und der Endpunkt kein Orakel."""
    gesehen: list[httpx.Request] = []
    async with _klient(_json(_GESUND), gesehen) as klient:
        await pruefe_betreiber(klient, _ziel(), INSTANZ, KONTO)

    assert len(gesehen) == 1
    kopf = gesehen[0].headers["Authorization"]
    assert kopf.startswith("Bearer ")
    claims = jwt.decode(kopf.split(" ", 1)[1], options={"verify_signature": False})
    assert claims["purpose"] == ZWECK
    assert claims["instance_id"] == str(INSTANZ)
    assert claims["owner_user_id"] == str(KONTO)
    assert claims["exp"] > claims["iat"]


@pytest.mark.asyncio
async def test_token_ist_kurzlebig():
    """Es reist zu einem fremden Server. Läuft es lange, ist es ein Nachschlüssel
    für jeden, der es dort abgreift."""
    gesehen: list[httpx.Request] = []
    async with _klient(_json(_GESUND), gesehen) as klient:
        await pruefe_betreiber(klient, _ziel(), INSTANZ, KONTO)

    claims = jwt.decode(
        gesehen[0].headers["Authorization"].split(" ", 1)[1],
        options={"verify_signature": False},
    )
    assert claims["exp"] - claims["iat"] <= 60


@pytest.mark.asyncio
async def test_anfrage_geht_an_die_geprueft_adresse_mit_richtigem_namen():
    """Wie jeder andere HTTP-Schritt: Verbindung zur bereits geprüften IP, der
    echte Name nur im Host-Kopf. Sonst löst der Aufruf den Namen erneut auf und
    die SSRF-Prüfung aus ``pruefe_dns`` wäre wirkungslos."""
    gesehen: list[httpx.Request] = []
    async with _klient(_json(_GESUND), gesehen) as klient:
        await pruefe_betreiber(klient, _ziel(), INSTANZ, KONTO)

    assert gesehen[0].url.host == "203.0.113.7"
    assert gesehen[0].headers["Host"] == "pulse.example.com"
    assert gesehen[0].url.path == "/.well-known/pulse-owner-check"
