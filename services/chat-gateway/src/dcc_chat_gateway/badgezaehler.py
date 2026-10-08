"""Die Zahl am App-Icon (iOS) — Fortschreibung je Konto in Redis.

**Warum der Server sie überhaupt führt.** iOS friert die JS-Engine der
WebView im Hintergrund ein. Der Klient kann die Zahl am Icon also nicht
bewegen, solange die App zu ist — genau dann, wenn man darauf schaut. Nur der
Push selbst kann sie tragen (``aps.badge``), und füllen muss sie der Server.

**Warum es eine Fortschreibung ist und keine Rechnung.** Für verschlüsselte
DMs — den Normalweg — kann der Server die Ungelesen-Zahl nicht berechnen:
``dm_lesestand.last_read_message_id`` trägt im E2E-Weg eine *klientenlokale*
Kennung, mit der der Server nichts vergleichen kann, und die
``dm_zustellungen``-Zeilen verschwinden beim Abholen (abgeholt ≠ gelesen).
Also zählt er mit, was er selbst hinausschickt, und lässt sich vom wachen
Klienten korrigieren (``POST /fcm/badge`` → :func:`setzen`). Der Klient hat
den Klartext und ist damit die Wahrheit; dieser Zähler ist nur die
Überbrückung für die Zeit, in der niemand rechnen kann.

**Fail-open, immer.** Keine Funktion hier darf werfen: ein Redis-Ausfall darf
den Nachrichtenweg nicht anfassen. :func:`erhoehen` liefert dann ``None``, und
ein ``None`` heisst im Push *schweigen* — ein fehlendes ``badge`` lässt die
Zahl am Gerät stehen, eine ``0`` würde sie löschen. Der Unterschied ist die
ganze Absicherung.
"""

from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger(__name__)

#: Schlüssel-Präfix. Der Zähler hängt am KONTO, nicht am Gerät — ein Konto hat
#: einen Ungelesen-Stand, auch wenn drei Geräte Pushes bekommen.
SCHLUESSEL_PRAEFIX = "badge:unread:"

#: Obergrenze gegen absurde Zahlen am Icon (durchgedrehter oder böswilliger
#: Klient). Die Oberfläche kappt ihre eigene Anzeige bei 99+; hier geht es nur
#: darum, dass nichts Unsinniges in den Push gerät.
OBERGRENZE = 9999

#: Haltbarkeit des Zählers. Lang genug, dass ein Konto nach Wochen Pause noch
#: seinen Stand hat; endlich, damit verwaiste Konten den Speicher nicht halten.
HALTBARKEIT_S = 60 * 60 * 24 * 60


def schluessel(user_id: int) -> str:
    return f"{SCHLUESSEL_PRAEFIX}{user_id}"


def begrenzen(anzahl: int) -> int:
    """Auf einen sinnvollen Bereich ziehen. Negatives ist keine Anzahl."""
    if anzahl < 0:
        return 0
    return min(anzahl, OBERGRENZE)


async def erhoehen(redis: Any, user_id: int) -> int | None:
    """Um eins hochzählen und den neuen Stand liefern.

    ``None`` heisst „unbekannt" (Redis antwortet nicht) — der Aufrufer lässt
    das ``badge`` im Push dann WEG, statt eine Zahl zu behaupten.
    """
    key = schluessel(user_id)
    try:
        wert = await redis.incr(key)
        await redis.expire(key, HALTBARKEIT_S)
        return begrenzen(int(wert))
    except Exception:  # noqa: BLE001 — Push ist best-effort, s. Modulkopf
        log.warning("badge_erhoehen_fehlgeschlagen user=%s", user_id)
        return None


async def lesen(redis: Any, user_id: int) -> int:
    """Aktuellen Stand lesen; 0 für unbekannte Konten und bei Störung."""
    try:
        wert = await redis.get(schluessel(user_id))
        # Ein unlesbarer Wert (fremder Schreiber, kaputter Schlüssel) fällt in
        # dasselbe `except` wie eine Störung — beides heisst hier 0.
        return 0 if wert is None else begrenzen(int(wert))
    except Exception:  # noqa: BLE001
        return 0


async def setzen(redis: Any, user_id: int, anzahl: int) -> None:
    """Stand des wachen Klienten übernehmen (überschreibt die Fortschreibung).

    0 löscht den Schlüssel statt eine Null zu speichern: beides liest sich als
    0, aber der gelöschte Schlüssel kostet keinen Speicher und läuft nicht ab.
    """
    begrenzt = begrenzen(anzahl)
    try:
        if begrenzt == 0:
            await redis.delete(schluessel(user_id))
        else:
            await redis.set(schluessel(user_id), begrenzt, ex=HALTBARKEIT_S)
    except Exception:  # noqa: BLE001
        log.warning("badge_setzen_fehlgeschlagen user=%s", user_id)


__all__ = [
    "HALTBARKEIT_S",
    "OBERGRENZE",
    "begrenzen",
    "erhoehen",
    "lesen",
    "schluessel",
    "setzen",
]
