"""Die Kategorien des Community-Verzeichnisses.

Feste Liste im Code, keine Tabelle und keine freien Schlagworte: die
Filter-Chips im Entdecken-Bildschirm zeigen genau diese fuenf. Freie Tags
waeren Wildwuchs (drei Schreibweisen fuer dasselbe) und braeuchten eine
Verwaltungsoberflaeche, die niemand pflegt.

Die ANZEIGENAMEN stehen nicht hier, sondern im Sprachkatalog des Klienten —
der Server kennt nur die Kennung.
"""

from __future__ import annotations

COMMUNITY_CATEGORIES: frozenset[str] = frozenset(
    {"gaming", "music", "tech", "creative", "other"}
)


def is_valid_category(wert: str | None) -> bool:
    """``None`` (keine Kategorie) ist gueltig — nicht jede Community ist eine."""
    return wert is None or wert in COMMUNITY_CATEGORIES
