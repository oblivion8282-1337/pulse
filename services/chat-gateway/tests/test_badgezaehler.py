"""Icon-Badge: die Zahl reist im Push mit (``aps.badge``).

**Warum das überhaupt serverseitig gehört:** iOS friert die JS-Engine der
WebView im Hintergrund ein. Der Klient kann die Zahl am App-Icon also nicht
bewegen, solange die App zu ist — genau dann, wenn man aufs Icon schaut. Nur
der Push selbst kann sie tragen, und tragen muss sie der Server.

Der Zähler ist eine **Fortschreibung, keine Rechnung**: für verschlüsselte
DMs kann der Server die Ungelesen-Zahl nicht berechnen (``dm_lesestand``
trägt im E2E-Weg eine klientenlokale ID, und ``dm_zustellungen`` verschwinden
beim Abholen). Er zählt deshalb mit, was er selbst hinausschickt, und lässt
sich vom wachen Klienten korrigieren.
"""

import pytest

from dcc_chat_gateway import badgezaehler



# ---------------------------------------------------------------------------
# Reine Rechnung — ohne Redis, ohne App


def test_begrenzen_haelt_die_zahl_im_sinnvollen_bereich():
    assert badgezaehler.begrenzen(0) == 0
    assert badgezaehler.begrenzen(7) == 7
    # Ein durchgedrehter oder böswilliger Klient darf keine absurde Zahl ans
    # Icon schreiben; negative Werte sind gar keine Anzahl.
    assert badgezaehler.begrenzen(-1) == 0
    assert badgezaehler.begrenzen(10**9) == badgezaehler.OBERGRENZE


def test_schluessel_haengt_am_konto():
    assert badgezaehler.schluessel(42) != badgezaehler.schluessel(43)
    assert "42" in badgezaehler.schluessel(42)


# ---------------------------------------------------------------------------
# Zähler gegen echtes Redis


async def test_erhoehen_zaehlt_je_konto_getrennt(app):
    r = app.state.redis
    await badgezaehler.setzen(r, 7001, 0)
    await badgezaehler.setzen(r, 7002, 0)
    assert await badgezaehler.erhoehen(r, 7001) == 1
    assert await badgezaehler.erhoehen(r, 7001) == 2
    assert await badgezaehler.erhoehen(r, 7002) == 1
    assert await badgezaehler.lesen(r, 7001) == 2


async def test_unbekanntes_konto_steht_auf_null(app):
    assert await badgezaehler.lesen(app.state.redis, 7099) == 0


async def test_setzen_ueberschreibt_die_fortschreibung(app):
    """Der wache Klient ist die Wahrheit — er kennt den Klartext."""
    r = app.state.redis
    await badgezaehler.setzen(r, 7003, 0)
    await badgezaehler.erhoehen(r, 7003)
    await badgezaehler.erhoehen(r, 7003)
    await badgezaehler.setzen(r, 7003, 1)
    assert await badgezaehler.lesen(r, 7003) == 1
    await badgezaehler.setzen(r, 7003, 0)
    assert await badgezaehler.lesen(r, 7003) == 0


async def test_zaehler_faellt_nie_aus(app, monkeypatch):
    """Redis weg darf den Nachrichtenweg nicht brechen — nur das Badge fehlt."""

    class _Kaputt:
        async def incr(self, *a, **k):
            raise RuntimeError("redis weg")

        async def get(self, *a, **k):
            raise RuntimeError("redis weg")

        async def set(self, *a, **k):
            raise RuntimeError("redis weg")

        async def delete(self, *a, **k):
            raise RuntimeError("redis weg")

        async def expire(self, *a, **k):
            raise RuntimeError("redis weg")

    kaputt = _Kaputt()
    assert await badgezaehler.erhoehen(kaputt, 7004) is None
    assert await badgezaehler.lesen(kaputt, 7004) == 0
    await badgezaehler.setzen(kaputt, 7004, 3)  # kein Wurf
