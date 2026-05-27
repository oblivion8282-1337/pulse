"""Health-Endpoints für den chat-gateway.

Zwei Endpoints:

GET /health — öffentlich, kein Auth.
    Prüft DB + Redis + JWKS-Ready.
    200 wenn alles OK · 200 "warming_up" wenn nur die JWKS noch warten ·
    503 nur bei echter Degradation (DB/Redis weg).
    Kein User-Bezug, kein Privacy-Leak — safe für externen Monitoring.

GET /internal/health-probe — JWT-validiert (purpose=health-probe).
    Für Cloud-Health-Probe nach Update-Webhook (DE 10c).
    Detailliertes JSON: version, services, last_migration, jwks_status, disk_usage.
    Validiert via INTERNAL_SERVICE_SECRET (gleicher Mechanismus wie /internal/users/purge).
"""

from __future__ import annotations

import asyncio
import hmac
import logging
import os
import shutil
from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, Request, status
from fastapi.responses import JSONResponse
from sqlalchemy import text

from dcc_chat_gateway import config as chat_cfg
from dcc_chat_gateway.db import SessionLocal

router = APIRouter()
log = logging.getLogger(__name__)

# Timeout in Sekunden für DB- und Redis-Checks.
_CHECK_TIMEOUT_S = 1.0

# /data-Verzeichnis — im Single-Container-Deployment das persistente Volume.
_DATA_DIR = os.environ.get("PULSE_DATA_PATH", "/data")


async def _check_db() -> bool:
    """Öffnet eine DB-Session und führt SELECT 1 aus.  True = OK."""
    try:
        async with asyncio.timeout(_CHECK_TIMEOUT_S):
            async with SessionLocal() as session:
                await session.execute(text("SELECT 1"))
        return True
    except Exception:
        log.debug("health db-check failed", exc_info=True)
        return False


async def _check_redis(request: Request) -> bool:
    """Pingt Redis.  True = OK."""
    redis = getattr(request.app.state, "redis", None)
    if redis is None:
        # skip_redis=True im Test-Modus — als OK werten.
        return True
    try:
        async with asyncio.timeout(_CHECK_TIMEOUT_S):
            await redis.ping()
        return True
    except Exception:
        log.debug("health redis-check failed", exc_info=True)
        return False


def _check_jwks(request: Request) -> bool:
    return bool(getattr(request.app.state, "jwks_ready", True))


def _disk_usage(path: str) -> dict[str, int | str] | None:
    """Gibt disk_total/used/free/percent zurück, oder None wenn Pfad fehlt."""
    try:
        usage = shutil.disk_usage(path)
        percent_used = round(usage.used / usage.total * 100, 1)
        return {
            "path": path,
            "total_mb": usage.total // (1024 * 1024),
            "used_mb": usage.used // (1024 * 1024),
            "free_mb": usage.free // (1024 * 1024),
            "percent_used": percent_used,
        }
    except Exception:
        return None


def _disk_warning(disk: dict | None) -> bool:
    """True wenn freier Platz < 20 %."""
    if disk is None:
        return False
    percent_used = disk.get("percent_used", 0)
    return float(percent_used) > 80.0


def _check_internal_secret(provided: str | None) -> None:
    """Constant-time Compare gegen INTERNAL_SERVICE_SECRET.

    Fehlt der Secret auf Server-Seite → 401 (fail-closed, kein Info-Leak).
    """
    expected = chat_cfg.get_settings().internal_service_secret
    if not expected:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            detail="internal endpoint disabled — set INTERNAL_SERVICE_SECRET",
        )
    if not provided or not hmac.compare_digest(provided, expected):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid internal secret")


# ---------------------------------------------------------------------------
# GET /health — öffentlich
# ---------------------------------------------------------------------------


@router.get("/health")
async def health(request: Request) -> JSONResponse:
    """Liveness-Check, Warm-Up-aware.

    200  {"status": "ok"}                                — alles bereit
    200  {"status": "warming_up", "warming": ["jwks"]}   — JWKS-Cache cold start
    503  {"status": "degraded", "failed": ["db", ...]}   — echte Service-Pfanne

    JWKS ist ein Redis-Cache, den ein async Poller (jwks_pinning) beim Start
    füllt. Solange er leer ist, läuft alles ausser WS-Auth (WS schliesst
    selber mit 4046). Containers + Load-Balancer dürfen den Pod nicht
    flappen lassen — daher 200 mit Hint, kein 503.
    """
    db_ok, redis_ok = await asyncio.gather(_check_db(), _check_redis(request))
    jwks_ok = _check_jwks(request)

    failed = []
    if not db_ok:
        failed.append("db")
    if not redis_ok:
        failed.append("redis")

    if failed:
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content={"status": "degraded", "failed": failed},
        )
    if not jwks_ok:
        return JSONResponse(
            status_code=status.HTTP_200_OK,
            content={"status": "warming_up", "warming": ["jwks"]},
        )
    return JSONResponse(status_code=status.HTTP_200_OK, content={"status": "ok"})


# ---------------------------------------------------------------------------
# GET /internal/health-probe — JWT-validiert (via INTERNAL_SERVICE_SECRET)
# ---------------------------------------------------------------------------


@router.get("/internal/health-probe")
async def health_probe(
    request: Request,
    x_pulse_internal_secret: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    """Detaillierter Health-Probe für Cloud nach Update (DE 10c).

    Nur mit gültigem X-Pulse-Internal-Secret-Header erreichbar.
    Returnt version, services, jwks_status, disk_usage.
    """
    _check_internal_secret(x_pulse_internal_secret)

    settings = chat_cfg.get_settings()
    db_ok, redis_ok = await asyncio.gather(_check_db(), _check_redis(request))
    jwks_ok = _check_jwks(request)
    disk = _disk_usage(_DATA_DIR)

    services: dict[str, str] = {
        "db": "ok" if db_ok else "error",
        "redis": "ok" if redis_ok else "error",
        "jwks": "ok" if jwks_ok else "not_ready",
    }

    overall = "ok" if all(v == "ok" for v in services.values()) else "degraded"

    return JSONResponse(
        status_code=status.HTTP_200_OK,
        content={
            "status": overall,
            "version": "0.1.0",
            "instance_mode": settings.pulse_instance_mode,
            "services": services,
            "jwks_status": {
                "ready": jwks_ok,
                "changed_unexpectedly": getattr(
                    request.app.state, "jwks_changed_unexpectedly", False
                ),
            },
            "disk_usage": disk,
            "disk_warning": _disk_warning(disk),
        },
    )
