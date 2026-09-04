"""Gast-Zustand in Redis — die Schlüssel und die Leser.

Ein Gast (Besprechungslink, kein Konto) hinterlässt keine Zeile in einer
Datenbank. Was von ihm existiert, lebt in Redis und stirbt mit seinem Ticket:

    gast:<gast_id>           HASH {name, link_id, guild_id, channel_id}
    gast:gesperrt:<gast_id>  "1"           (rausgeworfen, bis Ticket-Ablauf)
    gast:link:<link_id>      SET gast_id   (wen die Entwertung treffen muss)

**Warum das hier steht und nicht je Dienst:** chat-gateway schreibt,
voice-signaling liest — beide dieselben Schlüssel. Zwei Fassungen davon wären
eine stille Fehlerquelle (der Name des Gastes verschwände aus der Präsenz, die
Rauswurf-Sperre griffe ins Leere), und zwar eine, die kein Test bemerkt, der
nur einen der beiden Dienste kennt. Dieselbe Lehre wie bei
``dcc_shared.streaming``.

Alle Schreibvorgänge liegen in ``dcc_chat_gateway.gaeste`` — nur dort entsteht
ein Gast.
"""

from __future__ import annotations

from typing import Any

GAST_KEY = "gast:{gast_id}"
GAST_SPERRE_KEY = "gast:gesperrt:{gast_id}"
GAST_LINK_KEY = "gast:link:{link_id}"

#: Präfix der LiveKit-Identität eines Gastes (``gast-<snowflake>``). Das
#: Gegenstück zu ``user-`` — die Präsenzschicht unterscheidet die beiden
#: allein daran.
GAST_IDENTITY_PREFIX = "gast-"

#: Höchstlaufzeit eines Gast-Tickets (auth-svc deckelt darauf). Eine Sperre,
#: die so lange lebt, überdauert damit jedes ausgestellte Ticket — länger muss
#: sie nie sein, kürzer darf sie nicht: dann käme ein Rausgeworfener mit
#: seinem alten Ticket zurück.
TICKET_MAX_TTL_S = 4 * 3600


def ist_gast(kennung: str) -> bool:
    """True für eine Gast-Kennung (``gast-<id>``), False für eine Nutzer-ID."""
    return kennung.startswith(GAST_IDENTITY_PREFIX)


async def gast_name(redis: Any, gast_id: str) -> str | None:
    """Der selbst getippte Name eines Gastes, oder ``None``.

    ``None`` heisst „nicht (mehr) bekannt" — der Eintrag ist abgelaufen oder
    Redis war beim Beitritt gestört. Der Aufrufer fällt dann auf die Kennung
    zurück, statt zu werfen: ein fehlender Name ist ein Schönheitsfehler,
    kein Grund, eine laufende Besprechung zu stören.
    """
    if redis is None:
        return None
    try:
        roh = await redis.hget(GAST_KEY.format(gast_id=gast_id), "name")
    except Exception:  # noqa: BLE001 — Redis-Transportfehler
        return None
    if roh is None:
        return None
    return roh.decode() if isinstance(roh, bytes) else str(roh)


async def ist_gesperrt(redis: Any, gast_id: str) -> bool:
    """True, wenn dieser Gast rausgeworfen wurde.

    Fail-open bei Redis-Ausfall: die Sperre ist eine Ergänzung zur
    Ticket-Frist, nicht ihr Ersatz. Ein Redis-Ausfall darf keine Besprechung
    verhindern — er lässt einen Rausgeworfenen bis zum Ticket-Ablauf zurück,
    und das ist das kleinere Übel.
    """
    if redis is None:
        return False
    try:
        return bool(await redis.exists(GAST_SPERRE_KEY.format(gast_id=gast_id)))
    except Exception:  # noqa: BLE001
        return False


async def sperren(redis: Any, gast_id: str, ttl_s: int = TICKET_MAX_TTL_S) -> None:
    """Einen Gast aussperren (Rauswurf oder Entwertung seines Links).

    Still bei Redis-Ausfall: der LiveKit-Rauswurf daneben wirkt ohnehin
    sofort, die Sperre verhindert nur die Rückkehr mit demselben Ticket. Eine
    Ausnahme hier brächte einen halb erledigten Rauswurf zum Absturz.
    """
    if redis is None:
        return
    try:
        await redis.set(
            GAST_SPERRE_KEY.format(gast_id=gast_id), "1", ex=max(int(ttl_s), 1)
        )
    except Exception:  # noqa: BLE001
        pass
