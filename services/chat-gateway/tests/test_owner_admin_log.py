"""Tests für die Owner-Admin-Diagnose.

Bis zum 2026-08-25 hatte dieses Modul **keinen einzigen Test** — es wurde am
2026-07-27 gebaut, um eine Supportfrage zu beantworten, und niemand hat je
geprüft, ob es das tut.

**Was ein Test hier NICHT leisten kann, und das ist die Pointe:** ``caplog``
haengt einen eigenen Handler auf Stufe 0 ein und faengt deshalb auch dann eine
``info``-Zeile, wenn sie im echten Betrieb unsichtbar waere. Ein Test mit
``caplog`` allein haette den eigentlichen Fehler — Wurzel-Logger auf
``warning``, Zeile auf ``info`` — **nicht** gefunden. Die Sichtbarkeit prueft
deshalb ``shared/tests/test_logging_setup.py`` gegen die Vorgabe des
Containers; hier geht es nur um den Inhalt.
"""

from __future__ import annotations

import logging
from types import SimpleNamespace

import pytest

from dcc_chat_gateway import owner_admin_log
from dcc_chat_gateway.owner_admin_log import (
    log_owner_admin_decision,
    log_owner_konfiguration,
)

_MODUL = "dcc_chat_gateway.owner_admin_log"


def _einstellungen(*, modus: str = "self-host", owner: int = 4711) -> SimpleNamespace:
    return SimpleNamespace(pulse_instance_mode=modus, pulse_instance_owner_id=owner)


@pytest.fixture(autouse=True)
def gemeldete_leeren():
    """Die Sperre gegen Wiederholungen ist Prozess-Zustand — sonst schweigt der
    zweite Test, weil der erste den Schluessel schon verbraucht hat."""
    owner_admin_log._gemeldet.clear()
    yield
    owner_admin_log._gemeldet.clear()


# ---------------------------------------------------------------------------
# Beim Start
# ---------------------------------------------------------------------------


def test_startzeile_nennt_den_konfigurierten_besitzer(caplog):
    with caplog.at_level(logging.INFO, logger=_MODUL):
        log_owner_konfiguration(_einstellungen(owner=4711))
    assert "4711" in caplog.text


def test_startzeile_warnt_wenn_kein_besitzer_konfiguriert_ist(caplog):
    with caplog.at_level(logging.INFO, logger=_MODUL):
        log_owner_konfiguration(_einstellungen(owner=0))
    assert "PULSE_INSTANCE_OWNER_ID" in caplog.text
    # WARNING, nicht INFO: hier kann niemand die Instanz verwalten, und der
    # Betreiber soll das auch auf der leisesten Stufe sehen.
    assert any(e.levelno == logging.WARNING for e in caplog.records)


def test_in_der_cloud_bleibt_es_still(caplog):
    """Die Cloud hat keinen Instanz-Besitzer — die Zeile waere sinnlos."""
    with caplog.at_level(logging.INFO, logger=_MODUL):
        log_owner_konfiguration(_einstellungen(modus="cloud", owner=0))
    assert caplog.text == ""


# ---------------------------------------------------------------------------
# Bei der Anmeldung
# ---------------------------------------------------------------------------


def test_owner_wird_als_admin_vermerkt(caplog):
    with caplog.at_level(logging.INFO, logger=_MODUL):
        log_owner_admin_decision(_einstellungen(), 4711, True)
    assert "4711" in caplog.text
    # Ohne Ruecksicht auf Gross-/Kleinschreibung: geprueft wird, DASS der
    # Ausgang vermerkt ist, nicht wie das Wort gesetzt ist. Die Meldungen sind
    # seit 2026-08-28 englisch ("… — admin"), weil sie im Log eines fremden
    # Betreibers landen.
    assert "admin" in caplog.text.lower()


def test_fremder_nutzer_bekommt_BEIDE_kennungen_zu_sehen(caplog):
    """Der eigentliche Zweck des Moduls.

    Eine Zeile, die nur „kein Admin" sagt, hilft niemandem — der Betreiber
    muss die beiden Zahlen VERGLEICHEN koennen, sonst weiss er nicht, ob er
    sich mit dem falschen Konto angemeldet hat oder ob der Server falsch
    konfiguriert ist.
    """
    with caplog.at_level(logging.INFO, logger=_MODUL):
        log_owner_admin_decision(_einstellungen(owner=4711), 9999, False)
    assert "9999" in caplog.text, "die vorgelegte Kennung fehlt"
    assert "4711" in caplog.text, "die konfigurierte Kennung fehlt"


def test_je_nutzer_nur_einmal(caplog):
    """Der Cert-Login laeuft bei jedem Session-Refresh (5 Min) erneut."""
    with caplog.at_level(logging.INFO, logger=_MODUL):
        for _ in range(5):
            log_owner_admin_decision(_einstellungen(), 4711, True)
    assert len(caplog.records) == 1


def test_verschiedene_nutzer_bekommen_eigene_zeilen(caplog):
    with caplog.at_level(logging.INFO, logger=_MODUL):
        log_owner_admin_decision(_einstellungen(), 4711, True)
        log_owner_admin_decision(_einstellungen(), 9999, False)
    assert len(caplog.records) == 2


def test_die_entscheidung_schweigt_in_der_cloud(caplog):
    with caplog.at_level(logging.INFO, logger=_MODUL):
        log_owner_admin_decision(_einstellungen(modus="cloud"), 4711, False)
    assert caplog.text == ""
