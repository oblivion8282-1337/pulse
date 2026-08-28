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


def _klient(status: int, rumpf: dict | None = None) -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=rumpf if rumpf is not None else {})

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_neuer_server_weist_das_unbrauchbare_ticket_ab():
    """403 mit einem ``ticket_*``-Code heisst: Die Route ist da und tut ihre Arbeit."""
    async with _klient(403, {"detail": "ticket_malformed"}) as k:
        s = await pruefe_anmeldeweg(k, ZIEL)
    assert s.ok is True
    assert s.befund == "ticket_weg"


@pytest.mark.asyncio
async def test_alter_server_kennt_die_route_nicht():
    """404 ist waehrend der Uebergangszeit KEIN Fehler — deshalb ``ok=True``.

    Wer hier einen Fehlalarm baut, treibt Betreiber dazu, an einem Server
    herumzuschrauben, an dem nichts fehlt.
    """
    async with _klient(404) as k:
        s = await pruefe_anmeldeweg(k, ZIEL)
    assert s.ok is True
    assert s.befund == "zertifikats_weg"


@pytest.mark.asyncio
async def test_unerwartete_antwort_ist_kein_fehlalarm():
    """Ein Proxy, der 502 liefert, sagt nichts ueber den Anmeldeweg."""
    async with _klient(502) as k:
        s = await pruefe_anmeldeweg(k, ZIEL)
    assert s.befund == "keine_auskunft"


@pytest.mark.asyncio
async def test_200_ohne_json_ist_der_spa_rueckfall():
    """Fehlt die Proxy-Zeile, liefert der SPA-Rueckfall die Startseite.

    Dieselbe Falle hat die Cloud-Poller schon einmal erwischt (s. CLAUDE.md,
    well-known-Endpunkte) — sie scheiterten still mit einem JSONDecodeError.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="<!doctype html><html>…")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as k:
        s = await pruefe_anmeldeweg(k, ZIEL)
    assert s.befund == "keine_auskunft"


@pytest.mark.asyncio
async def test_403_ohne_ticket_code_ist_keine_auskunft():
    """Ein 403 aus einem anderen Grund (etwa eine Firewall) beweist nichts."""
    async with _klient(403, {"detail": "forbidden"}) as k:
        s = await pruefe_anmeldeweg(k, ZIEL)
    assert s.befund == "keine_auskunft"


@pytest.mark.asyncio
async def test_es_reist_kein_geheimnis_mit():
    """Der Probe legt ein offensichtlich unbrauchbares Ticket vor.

    Er darf keinen echten Ausweis verschicken — er prueft einen FREMDEN Server,
    und der Betreiber ist nicht zwingend vertrauenswuerdig.
    """
    gesehen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        gesehen["body"] = request.content.decode()
        gesehen["auth"] = request.headers.get("authorization")
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as k:
        await pruefe_anmeldeweg(k, ZIEL)

    assert gesehen["auth"] is None, "der Probe schickt einen Authorization-Kopf"
    assert "keins" in str(gesehen["body"])
