"""Was ein wiederholt vorgelegter Refresh-Token ausloest — und was NICHT.

Warum es diese Datei gibt
-------------------------
Am 2026-08-26 stand in der Produktionsdatenbank, dass ein einzelner Nutzer in
17 Tagen **28-mal** aus seiner Sitzung geworfen wurde: seine Token-Kette endete
jeweils mitten im 15-Minuten-Takt, ohne Nachfolger. Ein Vorfall (08:18:20) riss
sechs Ketten auf einmal mit, darunter zwei aus der Vorwoche und eine aus einem
zweiten Browser, in dem der Nutzer gerade gar nicht arbeitete.

Ursache waren zwei Eigenschaften des Reuse-Zweigs in ``routes.refresh``:

* Er unterschied nicht, **warum** ein Token zweimal kam. Geht die Antwort einer
  Rotation unterwegs verloren — Standby des Rechners, Netzwechsel, eingefrorener
  Tab —, behaelt der Browser den alten Token und legt ihn zwangslaeufig erneut
  vor. Das ist kein Diebstahl, sondern der Normalfall eines abgebrochenen
  Roundtrips.
* Er widerrief die Token des **ganzen Kontos**. Ein Stolpern in einem Browser
  meldete damit jedes andere Geraet desselben Nutzers gleich mit ab.

Die Tests hier halten beide Korrekturen fest. Sie pruefen ausdruecklich auch,
dass die Diebstahl-Erkennung erhalten bleibt: sobald der Nachfolger tatsaechlich
eingeloest wurde, sind zwei Parteien im Umlauf — dann stirbt die Kette.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime

import pytest
from dcc_auth.refresh_kette import protokolliere_abweisung, protokolliere_nachgereicht
from dcc_shared.logging_setup import konfiguriere_logging

REG = {
    "username": "wilma",
    "email": "wilma@example.com",
    "password": "correct horse battery staple",
    "display_name": "Wilma",
}


async def _anmelden(client) -> dict:
    """Eine frische Anmeldung — also eine eigene Token-Kette."""
    r = await client.post(
        "/login",
        json={"email_or_username": REG["username"], "password": REG["password"]},
    )
    assert r.status_code == 200, r.text
    return r.json()


@pytest.mark.asyncio
async def test_verlorene_antwort_liefert_denselben_nachfolger(client):
    """Kam die Antwort nie an, gibt derselbe Token denselben Nachfolger.

    Der Klient legt den alten Token erneut vor, weil er den neuen nie gesehen
    hat. Er bekommt exakt den, der fuer ihn schon ausgestellt wurde — nicht
    einen zweiten daneben, sonst gaebelte sich die Kette.
    """
    erste = (await client.post("/register", json=REG)).json()

    gedreht = await client.post("/refresh", json={"refresh_token": erste["refresh_token"]})
    assert gedreht.status_code == 200
    nachfolger = gedreht.json()["refresh_token"]

    # Der Klient hat die Antwort nicht bekommen und versucht es noch einmal.
    zweiter_versuch = await client.post("/refresh", json={"refresh_token": erste["refresh_token"]})
    assert zweiter_versuch.status_code == 200, zweiter_versuch.text
    assert zweiter_versuch.json()["refresh_token"] == nachfolger


@pytest.mark.asyncio
async def test_geheilter_nachfolger_bleibt_benutzbar(client):
    """Das Heilen darf den Nachfolger nicht verbrauchen.

    Ohne diese Zusicherung waere die Reparatur wertlos: der Klient bekaeme
    einen Token gereicht, der im selben Atemzug entwertet wurde.
    """
    erste = (await client.post("/register", json=REG)).json()
    nachfolger = (
        await client.post("/refresh", json={"refresh_token": erste["refresh_token"]})
    ).json()["refresh_token"]

    await client.post("/refresh", json={"refresh_token": erste["refresh_token"]})

    weiter = await client.post("/refresh", json={"refresh_token": nachfolger})
    assert weiter.status_code == 200, weiter.text


@pytest.mark.asyncio
async def test_eingeloester_nachfolger_bleibt_diebstahlsverdacht(client):
    """Wurde der Nachfolger benutzt, sind zwei Parteien im Umlauf.

    Das ist der Fall, gegen den die Erkennung gebaut wurde, und er bleibt
    unveraendert: die Kette stirbt, samt dem zuletzt ausgegebenen Token.
    """
    erste = (await client.post("/register", json=REG)).json()
    zweite = (
        await client.post("/refresh", json={"refresh_token": erste["refresh_token"]})
    ).json()
    dritte = (
        await client.post("/refresh", json={"refresh_token": zweite["refresh_token"]})
    ).json()

    # Der alte Token taucht wieder auf, obwohl sein Nachfolger laengst weiter
    # gedreht wurde — das kann kein verlorener Roundtrip mehr sein.
    replay = await client.post("/refresh", json={"refresh_token": erste["refresh_token"]})
    assert replay.status_code == 401

    tot = await client.post("/refresh", json={"refresh_token": dritte["refresh_token"]})
    assert tot.status_code == 401


@pytest.mark.asyncio
async def test_reuse_toetet_nur_die_eigene_kette(client):
    """Ein Stolpern in einem Browser laesst die anderen Geraete in Ruhe.

    Zwei Anmeldungen desselben Kontos sind zwei Ketten. Bis 2026-08-26 hing an
    der Erkennung das ganze Konto — deshalb flog jemand aus seiner Arbeits-
    sitzung, weil ein zweiter Browser irgendwo anders stolperte.
    """
    kette_a = (await client.post("/register", json=REG)).json()
    kette_b = await _anmelden(client)

    # Kette A stolpert: alter Token, Nachfolger bereits weitergedreht.
    a2 = (await client.post("/refresh", json={"refresh_token": kette_a["refresh_token"]})).json()
    await client.post("/refresh", json={"refresh_token": a2["refresh_token"]})
    replay = await client.post("/refresh", json={"refresh_token": kette_a["refresh_token"]})
    assert replay.status_code == 401

    # Kette B hat damit nichts zu tun und muss weiterlaufen.
    b_weiter = await client.post("/refresh", json={"refresh_token": kette_b["refresh_token"]})
    assert b_weiter.status_code == 200, b_weiter.text


@pytest.mark.asyncio
async def test_rotation_vererbt_die_kette(client, session_factory):
    """Der Nachfolger gehoert zur selben Kette wie sein Vorgaenger.

    Sonst zerfiele jede Sitzung mit jeder Rotation in lauter Einzelketten, und
    die Erkennung traefe am Ende nur noch einen einzigen Token — sie waere
    faktisch abgeschaltet.
    """
    from dcc_auth.models import RefreshToken
    from sqlalchemy import select

    erste = (await client.post("/register", json=REG)).json()
    await client.post("/refresh", json={"refresh_token": erste["refresh_token"]})

    async with session_factory() as session:
        zeilen = (await session.execute(select(RefreshToken))).scalars().all()

    assert len(zeilen) == 2
    assert zeilen[0].family_id == zeilen[1].family_id
    assert zeilen[0].family_id is not None


# ---------------------------------------------------------------------------
# Der Pruefstein: die Diagnose muss im BETRIEB sichtbar sein
# ---------------------------------------------------------------------------
#
# Eine Diagnose, die niemand sieht, ist keine. Genau diese Fehlerklasse hat
# ``owner_admin_log`` 29 Tage lang stumm geschaltet: die Zeilen standen auf
# ``info``, die Vorgabe fuer ``PULSE_LOG_LEVEL`` ist ``warning``, und niemandem
# fiel etwas auf — ein nicht geschriebenes Protokoll sieht aus wie ein ruhiger
# Betrieb. ``caplog`` kann das NICHT fangen (es haengt einen eigenen Handler auf
# Stufe 0 ein und saehe die Zeile auch dann, wenn sie im Betrieb verschwaende),
# deshalb wird hier gegen die echte Einrichtung geprueft.


def _zeile(**felder):
    """Ein Refresh-Token-Doppel, so weit die Protokollfunktionen es lesen."""
    from dcc_auth.models import RefreshToken

    grund = {
        "user_id": 4711,
        "family_id": uuid.UUID("11111111-2222-3333-4444-555555555555"),
        "revoked_at": datetime(2026, 8, 26, 8, 18, 0, tzinfo=UTC),
        "user_agent": "Edge/151",
    }
    return RefreshToken(**{**grund, **felder})


def _frisch_einrichten(monkeypatch):
    """Wurzel-Handler neu binden, damit er an DAS aktuelle stderr geht.

    ``StreamHandler`` merkt sich den Strom beim Erzeugen; im Volllauf hat ein
    frueheres Modul den Handler laengst am echten stderr befestigt, waehrend
    ``capsys`` ein anderes untergeschoben hat. Gleiche Begruendung wie in
    ``shared/tests/test_logging_setup.py``.
    """
    monkeypatch.delenv("PULSE_LOG_LEVEL", raising=False)  # die Cloud setzt nichts
    logging.getLogger().handlers[:] = []
    konfiguriere_logging()


def test_verdacht_erscheint_bei_der_vorgabe_der_cloud(monkeypatch, capsys):
    """Ohne gesetzten Schalter — also so, wie die Cloud laeuft."""
    _frisch_einrichten(monkeypatch)
    protokolliere_abweisung(
        _zeile(replaced_by=uuid.uuid4()), jetzt=datetime(2026, 8, 26, 8, 30, 0, tzinfo=UTC),
        widerrufen=6, ua_jetzt="Firefox/153",
    )
    ausgabe = capsys.readouterr().err
    assert "refresh_verdacht" in ausgabe
    assert "user=4711" in ausgabe
    assert "betroffen=6" in ausgabe
    # Der Abstand trennt „eben erst abgerissen" von „alte Sitzung".
    assert "widerrufen_vor=720s" in ausgabe


def test_nachgereicht_erscheint_bei_der_vorgabe_der_cloud(monkeypatch, capsys):
    """Der haeufige Fall ist der interessante — er darf nicht leiser sein."""
    _frisch_einrichten(monkeypatch)
    protokolliere_nachgereicht(_zeile(), jetzt=datetime(2026, 8, 26, 8, 30, 0, tzinfo=UTC))
    assert "refresh_nachgereicht" in capsys.readouterr().err


def test_die_gegenprobe_ist_eine_info_zeile(monkeypatch, capsys):
    """Ohne die saehe man nicht, dass die Tests oben ueberhaupt etwas messen."""
    _frisch_einrichten(monkeypatch)
    logging.getLogger("dcc_auth.refresh_kette").info("auf info faellt es unter den Tisch")
    assert "unter den Tisch" not in capsys.readouterr().err


def test_kein_ausweis_steht_im_protokoll(monkeypatch, capsys):
    """Weder der Token noch die volle Kettenkennung.

    Die Kennung wird auf acht Zeichen gekuerzt: genug, um zwei Zeilen einander
    zuzuordnen, zu wenig, um daraus etwas zu bauen.
    """
    _frisch_einrichten(monkeypatch)
    zeile = _zeile()
    protokolliere_abweisung(
        zeile, jetzt=datetime(2026, 8, 26, 8, 30, 0, tzinfo=UTC),
        widerrufen=1, ua_jetzt=None,
    )
    ausgabe = capsys.readouterr().err
    assert str(zeile.family_id) not in ausgabe
    assert "11111111" in ausgabe


@pytest.mark.asyncio
async def test_abmelden_erzeugt_keine_diebstahlswarnung(client, monkeypatch, capsys):
    """Wer sich abmeldet und dessen alter Token nochmal auftaucht, ist kein Dieb.

    ``/logout`` widerruft die Zeile, ohne je zu rotieren — genauso der
    Sitzungs-Widerruf und eine Kontosperre. Ein danach vorgelegter Token landet
    zwangslaeufig im selben Zweig wie eine echte Wiederverwendung. Das darf er,
    die Antwort ist in beiden Faellen 401; er darf nur nicht als Diebstahl
    protokolliert werden, sonst ist die Warnung beim Auswerten wertlos.
    """
    tokens = (await client.post("/register", json=REG)).json()
    await client.post("/logout", json={"refresh_token": tokens["refresh_token"]})

    _frisch_einrichten(monkeypatch)
    replay = await client.post("/refresh", json={"refresh_token": tokens["refresh_token"]})
    assert replay.status_code == 401

    ausgabe = capsys.readouterr().err
    assert "refresh_verdacht" not in ausgabe, "eine Abmeldung ist kein Diebstahlsverdacht"
    assert "refresh_abgewiesen" in ausgabe
