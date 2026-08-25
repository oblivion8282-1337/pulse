"""Tests für die zentrale Logging-Einrichtung.

Der eigentliche Fehler, gegen den hier geprüft wird, war kein Absturz: eine
Diagnose lief 29 Tage lang ins Leere, weil ihre Zeilen auf ``info`` standen und
niemand das Logging konfiguriert hatte. Ein solcher Fehler meldet sich nie von
selbst — er sieht aus wie „da ist eben nichts passiert".

Deshalb prüft die letzte Gruppe unten nicht die Funktion, sondern die
**Verbindung zwischen zwei Dateien**: was der Container als Log-Stufe vorgibt
und was die Diagnose an Stufe braucht. Genau diese Verbindung ist gerissen,
ohne dass ein Test rot wurde.
"""

from __future__ import annotations

import logging
import pathlib
import re

import pytest

from dcc_shared.logging_setup import STUFEN, konfiguriere_logging, stufe_aus_umgebung


@pytest.fixture(autouse=True)
def wurzel_wiederherstellen():
    """Der Wurzel-Logger ist globaler Zustand — sonst faerbt ein Test die anderen."""
    wurzel = logging.getLogger()
    alte_stufe = wurzel.level
    alte_handler = list(wurzel.handlers)
    yield
    wurzel.setLevel(alte_stufe)
    wurzel.handlers[:] = alte_handler


def test_vorgabe_ist_warning_ohne_umgebungsvariable(monkeypatch):
    """Ohne Schalter aendert sich nichts — Cloud und Dev-Stack bleiben leise."""
    monkeypatch.delenv("PULSE_LOG_LEVEL", raising=False)
    assert konfiguriere_logging() == logging.WARNING


@pytest.mark.parametrize("wert,erwartet", [(name, stufe) for name, stufe in STUFEN.items()])
def test_jede_stufe_wird_uebernommen(monkeypatch, wert, erwartet):
    monkeypatch.setenv("PULSE_LOG_LEVEL", wert)
    assert konfiguriere_logging() == erwartet


def test_schreibweise_ist_egal(monkeypatch):
    monkeypatch.setenv("PULSE_LOG_LEVEL", "  INFO ")
    assert konfiguriere_logging() == logging.INFO


def test_unsinn_faellt_auf_die_vorgabe_statt_zu_krachen(monkeypatch):
    """Ein Tippfehler im Schalter darf keinen Dienst am Start hindern."""
    monkeypatch.setenv("PULSE_LOG_LEVEL", "verbose")
    assert konfiguriere_logging() == logging.WARNING
    monkeypatch.setenv("PULSE_LOG_LEVEL", "")
    assert konfiguriere_logging() == logging.WARNING


def test_zweiter_aufruf_legt_keinen_zweiten_handler_an(monkeypatch):
    """Sonst stuende nach zwei Importen jede Zeile doppelt im Protokoll."""
    monkeypatch.setenv("PULSE_LOG_LEVEL", "info")
    konfiguriere_logging()
    konfiguriere_logging()
    konfiguriere_logging()
    unsere = [h for h in logging.getLogger().handlers if getattr(h, "name", None) == "pulse-root"]
    assert len(unsere) == 1


def test_zweiter_aufruf_zieht_die_stufe_nach(monkeypatch):
    monkeypatch.setenv("PULSE_LOG_LEVEL", "warning")
    konfiguriere_logging()
    monkeypatch.setenv("PULSE_LOG_LEVEL", "debug")
    assert konfiguriere_logging() == logging.DEBUG
    unsere = [h for h in logging.getLogger().handlers if getattr(h, "name", None) == "pulse-root"]
    assert unsere[0].level == logging.DEBUG


def test_fremde_logger_bleiben_unberuehrt(monkeypatch):
    """Angefasst wird ausschliesslich der Wurzel-Logger.

    uvicorn richtet seine drei Logger mit ``propagate: False`` ein. Wer daran
    dreht, bekommt jede uvicorn-Zeile doppelt — einmal von deren Handler,
    einmal ueber unseren am Wurzel-Logger. Hier wird deshalb festgehalten,
    dass die Funktion neben der Wurzel nichts anruehrt.
    """
    namen = ("uvicorn", "uvicorn.error", "uvicorn.access", "sqlalchemy.engine")
    vorher = {
        n: (
            logging.getLogger(n).level,
            list(logging.getLogger(n).handlers),
            logging.getLogger(n).propagate,
        )
        for n in namen
    }
    monkeypatch.setenv("PULSE_LOG_LEVEL", "info")
    konfiguriere_logging()
    for n in namen:
        logger = logging.getLogger(n)
        assert (logger.level, list(logger.handlers), logger.propagate) == vorher[n]


def _handler_neu_binden():
    """Vorhandenen Handler wegnehmen, damit der naechste an DAS aktuelle stderr geht.

    ``logging.StreamHandler(sys.stderr)`` merkt sich den Strom bei der
    Erzeugung. Im Volllauf hat ein frueheres Testmodul beim Importieren von
    ``dcc_chat_gateway.app`` bereits ``konfiguriere_logging()`` ausgefuehrt —
    der Handler haengt dann am echten stderr, waehrend ``capsys`` ein anderes
    untergeschoben hat, und der Test saehe nichts. Allein lief er gruen, im
    Volllauf rot; das ist kein Flake, sondern diese Bindung.

    Im Betrieb spielt das keine Rolle: dort wird stderr nicht ausgetauscht.
    """
    logging.getLogger().handlers[:] = []


def test_ein_modul_logger_wird_wirklich_sichtbar(monkeypatch, capsys):
    """Der Kern: die Zeile muss am Ende auch irgendwo herauskommen."""
    monkeypatch.setenv("PULSE_LOG_LEVEL", "info")
    _handler_neu_binden()
    konfiguriere_logging()
    logging.getLogger("dcc_chat_gateway.owner_admin_log").info("Cert-User 4711 — Admin")
    assert "Cert-User 4711 — Admin" in capsys.readouterr().err


def test_bei_warning_bleibt_info_unsichtbar(monkeypatch, capsys):
    """Die Gegenprobe — sonst prueft der Test darueber nichts."""
    monkeypatch.setenv("PULSE_LOG_LEVEL", "warning")
    _handler_neu_binden()
    konfiguriere_logging()
    logging.getLogger("dcc_chat_gateway.owner_admin_log").info("darf nicht erscheinen")
    assert "darf nicht erscheinen" not in capsys.readouterr().err


# ---------------------------------------------------------------------------
# Der Prüfstein: Container-Vorgabe gegen den Bedarf der Diagnose
# ---------------------------------------------------------------------------

_ENV_SKRIPT = (
    pathlib.Path(__file__).resolve().parents[2]
    / "infra/self-host/s6/etc/s6-overlay/scripts/07-render-env.sh"
)


def _container_vorgabe() -> str | None:
    """Die Log-Stufe, mit der ein Self-Host-Container tatsächlich läuft."""
    if not _ENV_SKRIPT.is_file():
        return None
    treffer = re.search(
        r"PULSE_LOG_LEVEL:-([a-z]+)", _ENV_SKRIPT.read_text(encoding="utf-8")
    )
    return treffer.group(1) if treffer else None


@pytest.mark.skipif(not _ENV_SKRIPT.is_file(), reason="ausserhalb des Repos gebaut")
def test_container_vorgabe_ist_eine_bekannte_stufe():
    vorgabe = _container_vorgabe()
    assert vorgabe in STUFEN, f"07-render-env.sh gibt {vorgabe!r} vor — das kennt niemand"


@pytest.mark.skipif(not _ENV_SKRIPT.is_file(), reason="ausserhalb des Repos gebaut")
def test_die_owner_diagnose_ist_im_container_sichtbar(monkeypatch):
    """Der Test, der 29 Tage lang gefehlt hat.

    ``owner_admin_log`` beantwortet mit ``log.info`` die Frage „warum ist der
    Betreiber kein Admin?". Senkt jemand die Vorgabe in ``07-render-env.sh``
    auf ``warning``, ist diese Antwort wieder unsichtbar — und niemand merkt
    es, weil eine fehlende Protokollzeile wie ein ruhiger Server aussieht.
    """
    vorgabe = _container_vorgabe()
    monkeypatch.setenv("PULSE_LOG_LEVEL", vorgabe)
    konfiguriere_logging()
    diagnose = logging.getLogger("dcc_chat_gateway.owner_admin_log")
    assert diagnose.isEnabledFor(logging.INFO), (
        f"Container laeuft auf {vorgabe!r} — die Owner-Diagnose steht auf info "
        "und waere damit unsichtbar (genau der Fehler vom 2026-07-27)"
    )


def test_stufe_aus_umgebung_ohne_seiteneffekt(monkeypatch):
    """Reine Auskunft — sie darf den Wurzel-Logger nicht anfassen."""
    monkeypatch.setenv("PULSE_LOG_LEVEL", "debug")
    vorher = logging.getLogger().level
    assert stufe_aus_umgebung() == logging.DEBUG
    assert logging.getLogger().level == vorher
