"""Neuntes Glied: Spricht dieser Server schon den Ticket-Weg?

Kein Erreichbarkeitsglied — ein Server kann tadellos laufen und trotzdem noch
den alten Weg fahren. Der Schritt beantwortet die Frage, die während der
Übergangszeit sonst niemand ohne Anmeldung beantworten kann, und liefert die
Zahl, an der das Tor zwischen Phase 2 und Phase 3 hängt.
"""

from __future__ import annotations

import httpx
import pytest

from dcc_auth.selfhost_probe_anmeldeweg import pruefe_anmeldeweg
from dcc_auth.selfhost_probe_dienst import Ziel

ZIEL = Ziel("x.example.com", "203.0.113.10")


def _klient(status: int, rumpf=None, text: str | None = None) -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        if text is not None:
            return httpx.Response(status, text=text)
        return httpx.Response(status, json=rumpf if rumpf is not None else {})

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_server_der_die_faehigkeit_nennt():
    async with _klient(200, {"capabilities": ["token_refresh", "server-ticket"]}) as k:
        s = await pruefe_anmeldeweg(k, ZIEL)
    assert s.ok is True
    assert s.befund == "ticket_weg"


@pytest.mark.asyncio
async def test_zu_alter_server_ist_ein_mangel():
    """Ein Server ohne diese Faehigkeit nimmt niemanden mehr auf.

    Das war bis zum Bughunt als Uebergangszustand beschrieben (``ok=True``) —
    eine Behauptung aus einer frueheren Fassung des Plans, die nach dem
    ersatzlosen Wegfall des Zertifikats-Wegs nicht mehr stimmte. Jetzt ein
    Mangel, mit einem Handgriff im Text.
    """
    async with _klient(200, {"capabilities": []}) as k:
        s = await pruefe_anmeldeweg(k, ZIEL)
    assert s.ok is False
    assert s.befund == "zu_alt"


@pytest.mark.asyncio
async def test_spa_rueckfall_ist_kein_fehlalarm():
    """Fehlt die Proxy-Zeile, liefert der SPA-Rueckfall die Startseite.

    Dieselbe Falle hat die Cloud-Poller schon einmal erwischt (s. CLAUDE.md,
    well-known-Endpunkte) — sie scheiterten still mit einem JSONDecodeError.
    """
    async with _klient(200, text="<!doctype html><html>…") as k:
        s = await pruefe_anmeldeweg(k, ZIEL)
    assert s.befund == "keine_auskunft"


@pytest.mark.asyncio
async def test_fehlerantwort_sagt_nichts_ueber_den_anmeldeweg():
    async with _klient(502) as k:
        s = await pruefe_anmeldeweg(k, ZIEL)
    assert s.befund == "keine_auskunft"


@pytest.mark.asyncio
async def test_antwort_ohne_capabilities_feld():
    async with _klient(200, {"server_version": "0.8.0"}) as k:
        s = await pruefe_anmeldeweg(k, ZIEL)
    assert s.befund == "keine_auskunft"


@pytest.mark.asyncio
async def test_der_probe_liest_nur_und_schickt_nichts_mit():
    """Reine Auskunft: GET, kein Rumpf, kein Authorization-Kopf.

    Der Probe prueft einen FREMDEN Server, dessen Betreiber nicht zwingend
    vertrauenswuerdig ist. Der erste Anlauf stellte hier eine POST-Anfrage an
    die Anmelde-Route — ein schreibender Zugriff, um eine Auskunft zu bekommen.
    """
    gesehen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        gesehen["methode"] = request.method
        gesehen["auth"] = request.headers.get("authorization")
        gesehen["body"] = request.content
        return httpx.Response(200, json={"capabilities": []})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as k:
        await pruefe_anmeldeweg(k, ZIEL)

    assert gesehen["methode"] == "GET"
    assert gesehen["auth"] is None
    assert not gesehen["body"]
