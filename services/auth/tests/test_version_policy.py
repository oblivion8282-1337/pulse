"""Die Versions-Richtlinie muss ueberhaupt ausgeliefert werden.

Bis zum 2026-08-28 gab es diese Route nicht: Die nginx-Regel leitete den Pfad
zwar hierher, aber im auth-svc kam der Name nirgends vor. Jeder Self-Host der
Welt fragte ihn alle 6 Stunden ab und bekam 404 — sechs Monate lang, ohne dass
es jemandem auffiel, weil der Poller fail-soft ist und nur eine Warnung schreibt.

Der wichtigste Test hier ist der letzte: ``min_version`` darf NICHT der
aktuellen Version folgen.
"""

from __future__ import annotations

import pytest


@pytest.mark.asyncio
async def test_richtlinie_wird_ausgeliefert(client):
    r = await client.get("/.well-known/pulse-version-policy.json")
    assert r.status_code == 200, "die Route fehlt — genau der Zustand vor dem 2026-08-28"


@pytest.mark.asyncio
async def test_felder_passen_zu_dem_was_der_poller_liest(client):
    """Gegenstueck zu ``dcc_chat_gateway/cloud_policy_poller.py``.

    Der Poller liest ``current_version`` und ``min_version`` per ``.get()`` —
    fehlende Felder wuerden also still zu ``None`` und erst viel spaeter weh
    tun. Deshalb hier ausdruecklich geprueft.
    """
    r = await client.get("/.well-known/pulse-version-policy.json")
    daten = r.json()
    assert daten["version"] == 1
    assert isinstance(daten["current_version"], str) and daten["current_version"]
    assert isinstance(daten["min_version"], str) and daten["min_version"]
    assert "updated_at" in daten


@pytest.mark.asyncio
async def test_ohne_anmeldung_erreichbar(client):
    """Wie ``jwks.json`` daneben: Ein Server, der sich noch nie angemeldet hat,
    muss die Richtlinie lesen koennen — sonst waere sie fuer genau die Faelle
    unerreichbar, fuer die sie gedacht ist."""
    r = await client.get("/.well-known/pulse-version-policy.json")
    assert r.status_code == 200
    assert "authorization" not in {k.lower() for k in r.request.headers}


@pytest.mark.asyncio
async def test_min_version_ist_von_haus_aus_keine_untergrenze(client):
    """Die Vorgabe MUSS permissiv sein.

    Spiegelte ``min_version`` die aktuelle Version, waere die Wirkung in dem
    Moment, in dem jemand den Vergleich baut, eine Aussperrung jedes nicht
    taggleich aktualisierten Servers — ohne dass das je jemand entschieden hat.
    """
    daten = (await client.get("/.well-known/pulse-version-policy.json")).json()
    assert daten["min_version"] == "0.0.0"
    assert daten["min_version"] != daten["current_version"], (
        "min_version folgt der aktuellen Version — das sperrt spaeter jeden "
        "Bestandsserver aus, sobald der Vergleich gebaut wird"
    )
