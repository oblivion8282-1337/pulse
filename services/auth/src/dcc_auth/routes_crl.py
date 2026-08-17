"""Public CRL (Certificate Revocation List) endpoints.

GET /.well-known/revoked-credentials  — öffentlich, ETag-cached
GET /.well-known/pulse-version-policy.json — Diagnose, öffentlich

Redis-Konvention (geteilt mit 1.C routes_credentials.py):
  Key  ``auth:revoked_certs``         ZSET  member=cert_id  score=expires_at_unix
  Key  ``auth:revoked_certs:etag``    STRING  SHA-256 der sortierten cert_id-Liste

1.C schreibt bei jeder Revocation in das ZSET und aktualisiert den ETag-Key.
Dieses Modul liest das ZSET (+ Auto-Prune abgelaufener Einträge) und bedient
If-None-Match-Anfragen mit 304 ohne DB-Round-Trip.

Wenn Redis nicht erreichbar ist (z. B. im Test-Setup ohne Redis), fällt der
Endpoint auf eine direkte DB-Abfrage zurück und berechnet den ETag on-the-fly.

Dauerhafte Quelle ist die Datenbank, nicht das ZSET: jeder Widerruf legt einen
Grabstein in ``auth.revoked_credentials`` (Migration 0048), der auch eine
Kontolöschung überlebt. Ein leer vorgefundenes ZSET wird daraus nachgefüllt —
sonst ließe ein Redis-Neustart ohne Persistenz jedes widerrufene Zertifikat
für den Rest seiner Laufzeit wieder aufleben.
"""

from __future__ import annotations

import hashlib
import logging
import os
import time
from time import monotonic
from typing import Annotated

from fastapi import APIRouter, Header, Request, Response, status
from sqlalchemy import select, text

from dcc_auth.credential_revocation import as_utc
from dcc_auth.db import SessionDep
from dcc_auth.models import IssuedCredential, RevokedCredential
from dcc_auth.routes import _check_rate, _client_ip  # noqa: F401 – re-use bucket

log = logging.getLogger(__name__)

router = APIRouter()

# Redis key names — authoritative definition; routes_credentials.py mirrors these.
ZSET_KEY = "auth:revoked_certs"
ETAG_KEY = "auth:revoked_certs:etag"

# Safety-net TTL (seconds) for the derived ETag cache. The ZSET itself is the
# source of truth (entries self-prune by score); the ETag is only a hint and
# must not survive forever if a recompute is ever missed. 1h >> 60s max-age.
_ETAG_TTL_SECONDS = 3600

# Nachfuellen eines leergelaufenen ZSET aus der Datenbank: hoechstens einmal je
# Minute je Prozess. Ohne den Deckel liefe auf jeder Instanz ohne Widerruf bei
# jedem Poll (10 s je Self-Host) eine unnoetige DB-Abfrage mit.
_RESEED_MIN_INTERVAL_S = 60
_last_reseed: float | None = None

# Version string: PULSE_VERSION env → pyproject.toml fallback.
_VERSION: str | None = None


def _get_version() -> str:
    global _VERSION
    if _VERSION is not None:
        return _VERSION
    v = os.environ.get("PULSE_VERSION")
    if not v:
        try:
            from importlib.metadata import version

            v = version("dcc-auth")
        except Exception:  # noqa: BLE001
            v = "0.0.0"
    _VERSION = v
    return _VERSION


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _compute_etag(cert_ids: list[str]) -> str:
    """SHA-256 of the newline-joined *sorted* cert_id list, hex-encoded."""
    payload = "\n".join(sorted(cert_ids)).encode()
    return hashlib.sha256(payload).hexdigest()


def _quoted(etag: str) -> str:
    return f'"{etag}"'


async def _get_redis(request: Request):
    """Return app.state.redis if present and connected, else None."""
    redis = getattr(request.app.state, "redis", None)
    if redis is None:
        return None
    try:
        await redis.ping()
        return redis
    except Exception:  # noqa: BLE001
        return None


async def _prune_and_fetch_from_redis(redis) -> list[str]:
    """Remove expired certs from ZSET and return surviving cert_ids."""
    now_score = int(time.time())
    # Remove entries whose expires_at (score) is in the past.
    await redis.zremrangebyscore(ZSET_KEY, "-inf", now_score - 1)
    raw = await redis.zrange(ZSET_KEY, 0, -1)
    return [m.decode() if isinstance(m, bytes) else m for m in raw]


async def _fetch_from_db_with_expiry(session) -> dict[str, int]:
    """Widerrufene, noch nicht abgelaufene Zertifikate aus der Datenbank.

    Zwei Quellen, absichtlich vereinigt:

    * ``revoked_credentials`` — der Grabstein. Er ueberlebt die Kaskade der
      Kontoloeschung und ist damit die **dauerhafte** Quelle.
    * ``issued_credentials WHERE revoked_at IS NOT NULL`` — die lebende Zeile.
      Sie deckt Widerrufe ab, die vor Migration 0048 entstanden sind (die
      Migration fuellt die Grabsteine nach, aber ein Rueckfall in beide
      Richtungen kostet nichts und kann nur mehr Sperren liefern, nie weniger).

    Der Wert ist ``expires_at`` als Unix-Sekunde — der Score des Redis-ZSET,
    damit dieselbe Liste ein leergelaufenes ZSET wieder befuellen kann.
    """
    out: dict[str, int] = {}
    tomb = select(RevokedCredential.cert_id, RevokedCredential.expires_at).where(
        RevokedCredential.expires_at > text("(CURRENT_TIMESTAMP)")
    )
    live = select(IssuedCredential.cert_id, IssuedCredential.expires_at).where(
        IssuedCredential.revoked_at.isnot(None),
        IssuedCredential.expires_at > text("(CURRENT_TIMESTAMP)"),
    )
    for stmt in (tomb, live):
        for cert_id, expires_at in (await session.execute(stmt)).all():
            out[str(cert_id)] = int(as_utc(expires_at).timestamp())
    return out


async def _fetch_from_db(session) -> list[str]:
    """Fallback: query DB directly for currently-revoked, not-yet-expired certs."""
    return list(await _fetch_from_db_with_expiry(session))


async def _reseed_from_db(redis, session) -> list[str]:
    """Ein leeres ZSET aus den Grabsteinen nachfuellen.

    Warum ueberhaupt: die Datenbank ist die dauerhafte Quelle, das ZSET nur der
    schnelle Weg. Faellt Redis aus und kommt leer zurueck (Neustart ohne
    Persistenz, FLUSHDB, frischer Container), wuerde der schnelle Weg eine
    **leere** Sperrliste veroeffentlichen — jedes widerrufene Zertifikat lebte
    fuer den Rest seiner Laufzeit wieder auf. Genau das soll der Grabstein
    verhindern, also muss er hier auch ankommen.

    Nur der leere Zustand loest das aus (ein teilweiser Verlust ist von aussen
    nicht erkennbar), und hoechstens einmal je ``_RESEED_MIN_INTERVAL_S`` — auf
    einer Instanz ohne einen einzigen Widerruf ist das ZSET dauerhaft leer, und
    die Self-Hosts fragen im 10-Sekunden-Takt.
    """
    global _last_reseed
    now = monotonic()
    if _last_reseed is not None and now - _last_reseed < _RESEED_MIN_INTERVAL_S:
        return []
    _last_reseed = now
    entries = await _fetch_from_db_with_expiry(session)
    if not entries:
        return []
    try:
        await redis.zadd(ZSET_KEY, entries)
    except Exception:  # noqa: BLE001
        log.warning("crl: reseed of %d entries from DB failed", len(entries))
        return list(entries)
    log.info("crl_reseeded_from_db count=%d", len(entries))
    return list(entries)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/.well-known/revoked-credentials")
async def revoked_credentials(
    request: Request,
    response: Response,
    session: SessionDep,
    if_none_match: Annotated[str | None, Header(alias="If-None-Match")] = None,
):
    """Return all revoked credentials that haven't expired yet.

    Rate-limited: 60/minute per IP.
    ETag: SHA-256 of sorted cert_id list, quoted per RFC 7232.
    304 when If-None-Match matches current ETag.
    """
    from dcc_auth.config import get_settings

    settings = get_settings()
    await _check_rate(request, "crl_fetch", "60/minute")

    redis = await _get_redis(request)

    if redis is not None:
        # Fast path: Redis available.
        cached_etag = await redis.get(ETAG_KEY)
        if cached_etag is not None:
            etag_str = cached_etag.decode() if isinstance(cached_etag, bytes) else cached_etag
            if if_none_match and if_none_match.strip('"') == etag_str:
                return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers={"ETag": _quoted(etag_str)})

        cert_ids = await _prune_and_fetch_from_redis(redis)
        if not cert_ids:
            cert_ids = await _reseed_from_db(redis, session)
        etag_str = _compute_etag(cert_ids)
        # Persist updated ETag (auto-prune may have shrunk the list).
        await redis.set(ETAG_KEY, etag_str, ex=_ETAG_TTL_SECONDS)
    else:
        # Slow path: no Redis, hit the DB.
        cert_ids = await _fetch_from_db(session)
        etag_str = _compute_etag(cert_ids)

    quoted = _quoted(etag_str)
    if if_none_match and if_none_match.strip('"') == etag_str:
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers={"ETag": quoted})

    response.headers["ETag"] = quoted
    response.headers["Cache-Control"] = "public, max-age=60"
    return {"version": 1, "cert_ids": sorted(cert_ids)}


@router.get("/.well-known/pulse-version-policy.json")
async def version_policy(request: Request):
    """Return the current service version. No auth, rate-limited 60/min/IP."""
    await _check_rate(request, "crl_version", "60/minute")
    return {"current_version": _get_version()}


# ---------------------------------------------------------------------------
# Storage helpers called by routes_credentials.py (1.C)
# ---------------------------------------------------------------------------


async def crl_add(redis, cert_id: str, expires_at_unix: int) -> None:
    """Add a newly-revoked cert to the ZSET and invalidate the ETag cache.

    Called from routes_credentials.py after marking revoked_at in the DB.
    score = expires_at unix timestamp so ZREMRANGEBYSCORE can prune by time.
    """
    try:
        await redis.zadd(ZSET_KEY, {cert_id: expires_at_unix})
        # Recompute ETag: fetch all surviving members and re-hash.
        await _invalidate_etag_cache(redis)
    except Exception:  # noqa: BLE001
        log.warning("crl_add: Redis write failed for cert_id=%s", cert_id)


async def _invalidate_etag_cache(redis) -> None:
    """Recompute and store the ETag after any mutation to the ZSET."""
    try:
        now_score = int(time.time())
        await redis.zremrangebyscore(ZSET_KEY, "-inf", now_score - 1)
        raw = await redis.zrange(ZSET_KEY, 0, -1)
        cert_ids = [m.decode() if isinstance(m, bytes) else m for m in raw]
        etag = _compute_etag(cert_ids)
        await redis.set(ETAG_KEY, etag, ex=_ETAG_TTL_SECONDS)
    except Exception:  # noqa: BLE001
        log.warning("crl: ETag cache invalidation failed")
