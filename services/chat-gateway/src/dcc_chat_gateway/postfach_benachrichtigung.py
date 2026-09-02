"""Die zwei Weckrufe nach einem erfolgreichen Einliefern (Etappe D).

Herausgeloest aus ``routes/postfach.py``, weil die Datei sonst ueber die
Groessen-Policy gewachsen waere (350 Z., s. CLAUDE.md). **Reiner Umzug, kein
Verhalten geaendert** — Reihenfolge, Fehlerbehandlung und der Umstand, dass
beide Wege best-effort sind, stehen unveraendert unten.

Gemeinsam ist beiden Wegen die Grenze, die sie NICHT ueberschreiten: der
Server kennt den Inhalt eines Umschlags nie, also traegt weder das
WS-Ereignis noch die Push-Benachrichtigung Nachrichtentext, Dateinamen oder
Anhang-Angaben — nur Kanal, Anzahl und Absendername.
"""

from __future__ import annotations

import logging

from dcc_shared.events import PostfachNeuEvent

from dcc_chat_gateway.push import fan_out_dm_push_encrypted

log = logging.getLogger(__name__)


async def wecke_und_pushe(
    manager: object | None,
    *,
    channel_id: int,
    zustellungen: int,
    push_empfaenger: set[int],
    absender_name: str,
) -> None:
    """Weckruf an offene Tabs (WS) + Push an geschlossene Browser."""
    # Weckruf — inhaltslos, traegt Kanal und Anzahl, NIE einen Umschlag
    # (sonst laege der Inhalt wieder in Redis). Best-effort, wie die
    # entsprechenden Publishes in ws_op_send.py: die Zustellungen sind
    # bereits persistiert, ein Redis-Hiccup darf die Antwort nicht kippen.
    if zustellungen > 0 and manager is not None:
        try:
            await manager.publish(  # type: ignore[attr-defined]
                str(channel_id),
                PostfachNeuEvent(channel_id=str(channel_id), anzahl=zustellungen),
            )
        except Exception:
            log.exception("postfach wake publish failed for channel %s", channel_id)

    # Geschlossene-Browser-Benachrichtigung — der WS-Weckruf oben erreicht
    # nur offene Tabs. Der Server kennt den Inhalt nie; der Push traegt
    # deshalb weder Nachrichteninhalt noch Dateiname, nur Absender und Kanal
    # (dieselbe Grenze wie beim Klartext-Push). Best-effort — kein ``try``
    # noetig, ``_fan_out_payload`` faengt selbst jede Ausnahme ab.
    if push_empfaenger:
        await fan_out_dm_push_encrypted(
            recipient_ids=push_empfaenger,
            author_name=absender_name,
            channel_id=channel_id,
        )


__all__ = ["wecke_und_pushe"]
