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

from dcc_shared.streaming import read_cache_scan_pattern, token_key

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


async def lese_token_loeschen(redis: Any, gast_id: str) -> int:
    """Die WHEP-Lese-Token eines Gastes wegnehmen. Gibt die Zahl der
    gefallenen Schlüssel zurück.

    **Warum ein Rauswurf ohne das unvollständig ist.** Das Lese-Token hängt an
    Kanal und Streamer, nicht am Zuschauer, und der mediamtx-auth-hook nimmt
    es die volle Stunde lang an, ohne es zu verbrauchen — er sieht keine
    Identität, er *kann* nicht prüfen, wer da abruft. Ein rausgeworfener Gast
    bekäme also keine neue Adresse mehr (die Gast-Route sperrt ihn), aber die
    bereits geholte liefe weiter. Dieselbe Lücke wie beim gebannten Mitglied,
    dieselbe Antwort: das Token aktiv wegnehmen.

    Anders als beim Bann (``chat_gateway.stream_revoke``) braucht es hier
    **keine Eingrenzung auf die Community**: das Ticket eines Gastes nennt
    genau einen Kanal, mehr Token kann er gar nicht haben. Deshalb kommt diese
    Fassung ohne Datenbank aus — und nur deshalb kann voice-signaling sie beim
    Rauswurf rufen.

    Best-effort: ein Rauswurf darf nicht daran scheitern, dass Redis klemmt.
    """
    if redis is None:
        return 0
    try:
        cache_keys = [
            key
            async for key in redis.scan_iter(
                match=read_cache_scan_pattern(gast_id), count=100
            )
        ]
        if not cache_keys:
            return 0
        # Die Token-Werte holen, BEVOR die Nachschlage-Schlüssel fallen —
        # sonst bleiben die Datensätze als Waisen liegen und gelten weiter.
        werte = await redis.mget(cache_keys)
        token_keys = [
            token_key(w.decode() if isinstance(w, bytes) else w) for w in werte if w
        ]
        return int(await redis.delete(*cache_keys, *token_keys))
    except Exception:  # noqa: BLE001 — Redis-Transportfehler
        return 0
