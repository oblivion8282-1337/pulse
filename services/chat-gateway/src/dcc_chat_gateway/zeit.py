"""Zeitstempel aus der Datenbank vergleichbar machen.

Eine einzige Funktion, aber sie stand vorher zweimal da (``kopplung_zugriff``
und der Gast-Kern) — und eine Regel, die an zwei Stellen steht, gilt
irgendwann an einer davon nicht mehr.
"""

from __future__ import annotations

from datetime import UTC, datetime


def als_utc(wert: datetime) -> datetime:
    """Einen Zeitstempel mit UTC beschriften, falls er nackt ankommt.

    SQLite (Tests) gibt ``DateTime(timezone=True)`` naiv zurück, Postgres
    nicht. Ohne diese Anpassung wirft der Vergleich mit ``datetime.now(UTC)``
    im Test ``TypeError`` und im Betrieb nicht — der Unterschied fiele dann
    erst auf der Prod-Datenbank auf, also am spätestmöglichen Ort.

    Gespeichert wird immer UTC; ein fehlender Zonenanteil ist deshalb kein
    fehlendes Wissen, sondern nur eine fehlende Beschriftung.
    """
    return wert if wert.tzinfo is not None else wert.replace(tzinfo=UTC)
