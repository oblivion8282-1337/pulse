"""Die Startmeldung zum VAPID-Schluessel muss sagen, was WIRKLICH passiert ist.

Bis zum 2026-08-28 stand dort eine einzige Warnung: „every restart will
invalidate all push subscriptions" — auch dann, wenn der Schluessel gerade
erfolgreich auf die Platte geschrieben worden war. Das ist der Normalfall: Der
Self-Host-Container zeigt ``VAPID_KEY_FILE`` auf ``/data/jwt_keys/vapid.json``,
und ``/data`` ist das Docker-Volume. Jeder Betreiber las die Zeile bei jeder
frischen Installation und suchte einen Fehler, den es nicht gab.

Der Test haelt beide Richtungen fest, weil nur das Paar die Aussage traegt:
eine Meldung, die immer warnt, ist von einer, die richtig warnt, an einem
einzelnen Fall nicht zu unterscheiden.
"""

from __future__ import annotations

import logging

import pytest

from dcc_chat_gateway import vapid as vapid_modul


@pytest.fixture(autouse=True)
def _frischer_cache():
    vapid_modul.reset_vapid_cache_for_tests()
    yield
    vapid_modul.reset_vapid_cache_for_tests()


class Konfig:
    """Nur die drei Felder, die ``ensure_vapid`` liest."""

    vapid_private_key = ""
    vapid_public_key = ""

    def __init__(self, key_file):
        self.vapid_key_file = str(key_file)


def test_erfolgreich_abgelegt_ist_keine_warnung(tmp_path, caplog):
    ziel = tmp_path / "keys" / "vapid.json"
    with caplog.at_level(logging.INFO, logger="dcc_chat_gateway.vapid"):
        keys = vapid_modul.ensure_vapid(Konfig(ziel))

    assert keys is not None
    assert ziel.exists(), "der Schluessel wurde gar nicht erst geschrieben"
    assert not [e for e in caplog.records if e.levelno >= logging.WARNING], (
        "eine Warnung, obwohl der Schluessel dauerhaft liegt — genau der Fall, "
        "der Betreiber auf die falsche Faehrte schickte"
    )
    assert str(ziel) in caplog.text, "der Pfad fehlt; ohne ihn kann niemand pruefen, ob er haltbar ist"


def test_nicht_ablegbar_warnt_weiterhin(tmp_path, caplog, monkeypatch):
    """Die Gegenprobe: faellt das Schreiben aus, MUSS die Warnung kommen.

    Ohne sie waere die Aenderung oben bloss ein Stummschalten.
    """

    def _scheitert(_path, _keys):
        raise OSError("read-only")

    monkeypatch.setattr(vapid_modul, "_persist_keypair_to_disk", _scheitert)

    with caplog.at_level(logging.INFO, logger="dcc_chat_gateway.vapid"):
        keys = vapid_modul.ensure_vapid(Konfig(tmp_path / "vapid.json"))

    assert keys is not None, "ohne Ablage muss der Dienst trotzdem laufen"
    warnungen = [e for e in caplog.records if e.levelno >= logging.WARNING]
    assert warnungen, "kein Hinweis darauf, dass der Schluessel jeden Neustart wechselt"
    assert "COULD NOT" in caplog.text
