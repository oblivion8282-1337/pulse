"""Sperr-Poller: erfährt, wenn die Cloud DIESE Instanz gesperrt oder gelöscht hat.

Die Cloud veröffentlicht `/.well-known/pulse-suspended-instances` seit Phase 2.3,
und `routes_admin_app_host_revoke.py` beschreibt die Liste als das Mittel, das
"einen noch laufenden Container stoppt". Gefragt hat sie bis 2026-07-27 aber
**niemand** ab: der Self-Host hatte genau zwei Poller (CRL alle 10 s,
Versions-Policy alle 6 h), und die Instanz-Sperrliste war bei keinem dabei.

Praktische Folge, am 2026-07-27 am eigenen Testserver beobachtet: Nach
"Server löschen" in der App lief die Instanz unbeirrt weiter — Cloud-seitig
`status=deleted`, Kill-Switch-Eintrag gesetzt, Mitgliedschaften weg, und der
Server bediente seine Nutzer trotzdem unbegrenzt weiter. Die Löschung war für
den Betreiber wirkungslos.

**Was durchgesetzt wird und was nicht.** Der Poller verweigert neue Anmeldungen
und trennt bestehende Verbindungen; er fasst die Daten NICHT an und stoppt den
Container NICHT. Gründe: eine Sperre ist umkehrbar (`suspended` kann
zurückgenommen werden), und ein Prozess, der sich selbst beendet, landet mit
`restart: unless-stopped` in einer Neustartschleife. Ohne Anmeldung ist die
Instanz für Nutzer tot; das genügt.

**Fail-open ist Absicht.** Ist die Cloud nicht erreichbar, bleibt der zuletzt
bekannte Zustand stehen. Andernfalls würde ein Cloud-Ausfall jeden Self-Host
der Welt gleichzeitig aussperren — der Schaden wäre größer als der Nutzen.

Redis, damit alle Worker denselben Stand sehen:
  ``auth:instance:suspended``  ""|"suspended"|"deleted"
  ``auth:instance:suspended:etag``
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

log = logging.getLogger(__name__)

REDIS_SUSPENDED_KEY = "auth:instance:suspended"
REDIS_SUSPENDED_ETAG_KEY = "auth:instance:suspended:etag"

# Eine Minute. Die CRL fährt 10 s, weil ein gestohlenes Zertifikat jede Sekunde
# zählt; eine Instanz-Sperre ist kein Wettlauf. Der Endpunkt ist ETag-gecacht
# und auf 60/Minute je IP begrenzt — ein Abruf je Minute ist beides nicht.
SUSPEND_POLL_INTERVAL = 60
SUSPEND_FETCH_TIMEOUT = 10.0

#: Werte von ``auth:instance:suspended``
STATE_ACTIVE = ""
STATE_SUSPENDED = "suspended"
STATE_DELETED = "deleted"


async def read_state(redis: Any) -> str:
    """Aktueller Sperrzustand; leer = nicht gesperrt (auch ohne Redis)."""
    if redis is None:
        return STATE_ACTIVE
    try:
        raw = await redis.get(REDIS_SUSPENDED_KEY)
    except Exception:  # noqa: BLE001
        # Redis weg ist ein anderes Problem als "gesperrt" — nicht aussperren.
        return STATE_ACTIVE
    if not raw:
        return STATE_ACTIVE
    wert = raw.decode() if isinstance(raw, bytes) else str(raw)
    # NUR bekannte Werte sperren. Steht dort etwas Unerwartetes — ein
    # Schluesselkonflikt, ein Test-Mock, ein spaeterer Umbau —, gilt "nicht
    # gesperrt". Alles andere hiesse: ein Tippfehler im Wert sperrt jeden
    # Nutzer der Instanz aus, und zwar stumm.
    return wert if wert in {STATE_SUSPENDED, STATE_DELETED} else STATE_ACTIVE


async def raise_if_suspended(redis: Any) -> None:
    """403, wenn diese Instanz gesperrt oder geloescht ist — sonst nichts.

    Als Helfer hier statt inline im Cert-Login: die Route ist ohnehin ueber der
    Groessen-Grenze, und die Entscheidung "was heisst gesperrt" gehoert zum
    Poller, nicht zur Anmeldung.
    """
    from fastapi import HTTPException  # lokal: haelt das Modul frei von FastAPI

    zustand = await read_state(redis)
    if zustand:
        raise HTTPException(
            status_code=403,
            detail="instance_deleted" if zustand == STATE_DELETED else "instance_suspended",
        )


async def _fetch(
    client: httpx.AsyncClient, url: str, etag: str | None
) -> tuple[dict | None, str | None]:
    """``(body, etag)``; ``(None, None)`` bei 304."""
    headers = {"If-None-Match": etag} if etag else {}
    resp = await client.get(url, headers=headers, timeout=SUSPEND_FETCH_TIMEOUT)
    if resp.status_code == 304:
        return None, None
    resp.raise_for_status()
    return resp.json(), resp.headers.get("ETag")


def _state_for(body: dict, instance_id: int) -> str:
    """Zustand DIESER Instanz aus der Liste ableiten.

    ``deleted_instance_ids`` ist eine Teilmenge von ``instance_ids`` (s. der
    Endpunkt). Die feinere Angabe gewinnt, weil sie die Meldung an den Nutzer
    bestimmt: eine Sperre kann zurückgenommen werden, eine Löschung nicht.
    Verglichen wird als STRING — die Liste liefert Snowflakes als Text, und
    `int()` auf fremde Eingaben waere eine Fehlerquelle ohne Gewinn.
    """
    mine = str(instance_id)
    if mine in {str(x) for x in body.get("deleted_instance_ids", [])}:
        return STATE_DELETED
    if mine in {str(x) for x in body.get("instance_ids", [])}:
        return STATE_SUSPENDED
    return STATE_ACTIVE


async def suspend_poll_once(
    redis: Any, cloud_origin: str, instance_id: int, client: httpx.AsyncClient
) -> None:
    """Ein Abruf. Bei jedem Fehler bleibt der letzte Stand stehen (fail-open)."""
    url = f"{cloud_origin.rstrip('/')}/.well-known/pulse-suspended-instances"
    raw_etag = await redis.get(REDIS_SUSPENDED_ETAG_KEY)
    etag = (raw_etag.decode() if isinstance(raw_etag, bytes) else raw_etag) if raw_etag else None

    try:
        body, new_etag = await _fetch(client, url, etag)
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "Sperrliste nicht abrufbar (%s: %s) — letzter Stand bleibt",
            type(exc).__name__,
            exc,
        )
        return

    if body is None:
        return  # 304

    neu = _state_for(body, instance_id)
    alt = await read_state(redis)
    pipe = redis.pipeline()
    pipe.set(REDIS_SUSPENDED_KEY, neu)
    if new_etag:
        pipe.set(REDIS_SUSPENDED_ETAG_KEY, new_etag)
    await pipe.execute()

    if neu != alt:
        if neu == STATE_ACTIVE:
            log.warning("Instanz ist wieder freigegeben — Anmeldungen sind erlaubt")
        else:
            log.error(
                "Instanz von der Cloud als '%s' markiert — neue Anmeldungen werden "
                "abgelehnt, bestehende Sitzungen laufen binnen 5 Minuten aus",
                neu,
            )


async def suspend_poller_loop(redis: Any, cloud_origin: str, instance_id: int) -> None:
    """Hintergrundaufgabe; wird in der chat-gateway-Lifespan gestartet."""
    log.info(
        "Sperr-Poller gestartet (Instanz=%s, Intervall=%ds)", instance_id, SUSPEND_POLL_INTERVAL
    )
    async with httpx.AsyncClient() as client:
        while True:
            try:
                await suspend_poll_once(redis, cloud_origin, instance_id, client)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                log.exception("Unerwarteter Fehler im Sperr-Poller")
            await asyncio.sleep(SUSPEND_POLL_INTERVAL)
