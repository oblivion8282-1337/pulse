"""Hält die Cloud-JWKS eines Self-Hosts warm.

Ein Self-Host prüft von der Cloud signierte Token (Serverticket, Betreiber-Check)
und braucht dafür deren öffentliche Schlüssel. Er holt sie regelmässig und legt
sie in Redis ab; ``credential_validator._get_jwks_keys`` liest von dort.

Bis zum 2026-08-28 hiess dieses Modul ``crl_poller`` und tat zweierlei: Es holte
die Sperrliste der Gerätezertifikate UND die JWKS. Die Zertifikate sind entfallen
— mit ihnen die Sperrliste, denn es gibt nichts mehr zu sperren. Ein Ticket
lebt 60 Sekunden; wer es zurückziehen will, wartet eine Minute.

**Fail-open ist Absicht.** Ist die Cloud nicht erreichbar, bleibt der zuletzt
bekannte Schlüsselstand stehen, statt dass der Server niemanden mehr hereinlässt.
Ein Cloud-Ausfall darf keinen Self-Host lahmlegen — dieselbe Linie wie beim
Sperr-Poller.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

log = logging.getLogger(__name__)

#: Muss mit ``credential_validator.REDIS_CLOUD_JWKS_KEY`` übereinstimmen.
REDIS_CLOUD_JWKS_KEY = "auth:cloud_jwks:cached"

POLL_INTERVAL_S = 30.0
FETCH_TIMEOUT_S = 5.0


async def hole_cloud_jwks(redis: Any, cloud_origin: str, client: httpx.AsyncClient) -> None:
    """Holt die Cloud-JWKS und legt sie in Redis ab. Fehler bleiben folgenlos."""
    url = f"{cloud_origin.rstrip('/')}/.well-known/jwks.json"
    try:
        resp = await client.get(url, timeout=FETCH_TIMEOUT_S)
        resp.raise_for_status()
        await redis.set(REDIS_CLOUD_JWKS_KEY, resp.text)
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "cloud-jwks fetch failed (%s: %s) — keeping last-known-good",
            type(exc).__name__,
            exc,
        )


async def jwks_poller_loop(redis: Any, cloud_origin: str) -> None:
    """Läuft, solange der Dienst läuft."""
    async with httpx.AsyncClient() as client:
        while True:
            await hole_cloud_jwks(redis, cloud_origin, client)
            await asyncio.sleep(POLL_INTERVAL_S)
