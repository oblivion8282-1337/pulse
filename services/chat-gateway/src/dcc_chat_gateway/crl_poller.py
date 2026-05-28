"""CRL background poller for Self-Host instances (DE 9 + DE 10).

Polls ``{cloud_origin}/.well-known/revoked-credentials`` every 30 seconds.
Uses ETag / If-None-Match for efficient conditional requests.

On update:
- Replaces ``auth:revoked:certs`` (Redis Set) with the new cert_id list
- Deletes any ``auth:valid:cert:<cert_id>`` validation-cache keys for newly
  revoked certs (Plan §383 — prevents stale cache letting revoked certs through)

Fail-soft: Cloud outage → WARN log, keep last-known-good in Redis.
Hard-required: no opt-out (DE 10).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

log = logging.getLogger(__name__)

# Redis keys (mirrors credential_validator.py)
REDIS_REVOKED_SET = "auth:revoked:certs"
REDIS_VALID_CERT_PREFIX = "auth:valid:cert:"
REDIS_CRL_ETAG_KEY = "auth:crl:etag"
# Cloud JWKS used to validate Cloud-signed Identity-Certs on self-host
# (mirrors credential_validator.REDIS_CLOUD_JWKS_KEY).
REDIS_CLOUD_JWKS_KEY = "auth:cloud_jwks:cached"

# Poll interval (seconds) — DE 9 mandates 30s
CRL_POLL_INTERVAL = 30

# HTTP timeout for CRL fetch
CRL_FETCH_TIMEOUT = 10.0


async def _fetch_crl(
    client: httpx.AsyncClient,
    url: str,
    etag: str | None,
) -> tuple[list[str] | None, str | None]:
    """Fetch the CRL from the cloud.

    Returns ``(cert_ids, new_etag)`` on 200, ``(None, None)`` on 304 (not modified),
    or raises on HTTP error (caller handles fail-soft).
    """
    headers: dict[str, str] = {}
    if etag:
        headers["If-None-Match"] = etag

    resp = await client.get(url, headers=headers, timeout=CRL_FETCH_TIMEOUT)

    if resp.status_code == 304:
        return None, None

    resp.raise_for_status()
    data = resp.json()
    cert_ids: list[str] = data.get("cert_ids", [])
    new_etag = resp.headers.get("ETag")
    return cert_ids, new_etag


async def _update_redis(redis: Any, cert_ids: list[str], new_etag: str | None) -> None:
    """Atomically replace the revoked-certs set and invalidate validation cache."""
    pipe = redis.pipeline()

    # Replace the set atomically (delete + add in one pipeline)
    pipe.delete(REDIS_REVOKED_SET)
    if cert_ids:
        pipe.sadd(REDIS_REVOKED_SET, *cert_ids)

    # Invalidate per-cert validation cache for newly revoked certs (Plan §383)
    for cert_id in cert_ids:
        pipe.delete(f"{REDIS_VALID_CERT_PREFIX}{cert_id}")

    if new_etag:
        pipe.set(REDIS_CRL_ETAG_KEY, new_etag)

    await pipe.execute()


async def _fetch_cloud_jwks(redis: Any, cloud_origin: str, client: httpx.AsyncClient) -> None:
    """Warm the Cloud-JWKS cache used to validate Cloud-signed Identity-Certs.

    Self-host can't validate certs from the local auth-svc JWKS (the cert is
    Cloud-signed), so credential_validator reads ``auth:cloud_jwks:cached``.
    Best-effort: on failure keep the last-known-good cache.
    """
    url = f"{cloud_origin.rstrip('/')}/.well-known/jwks.json"
    try:
        resp = await client.get(url, timeout=CRL_FETCH_TIMEOUT)
        resp.raise_for_status()
        await redis.set(REDIS_CLOUD_JWKS_KEY, resp.text)
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "cloud-jwks fetch failed (%s: %s) — keeping last-known-good",
            type(exc).__name__,
            exc,
        )


async def crl_poll_once(
    redis: Any,
    cloud_origin: str,
    client: httpx.AsyncClient,
) -> None:
    """Run a single CRL poll cycle. Called from the background loop."""
    # On self-host, also keep the Cloud-JWKS cache warm for cert validation
    # (the cert validator can't use the local JWKS for Cloud-signed certs).
    from dcc_chat_gateway.config import get_settings

    if get_settings().pulse_instance_mode == "self-host":
        await _fetch_cloud_jwks(redis, cloud_origin, client)

    url = f"{cloud_origin.rstrip('/')}/.well-known/revoked-credentials"

    # Load last ETag from Redis
    raw_etag = await redis.get(REDIS_CRL_ETAG_KEY)
    etag: str | None = None
    if raw_etag:
        etag = raw_etag.decode() if isinstance(raw_etag, bytes) else raw_etag

    try:
        cert_ids, new_etag = await _fetch_crl(client, url, etag)
    except httpx.HTTPStatusError as exc:
        log.warning(
            "CRL fetch returned HTTP %s — keeping last-known-good", exc.response.status_code
        )
        return
    except (httpx.RequestError, Exception) as exc:  # noqa: BLE001
        log.warning("CRL fetch failed (%s: %s) — keeping last-known-good", type(exc).__name__, exc)
        return

    if cert_ids is None:
        # 304 Not Modified — nothing to do
        log.debug("CRL poll: 304 Not Modified, no changes")
        return

    await _update_redis(redis, cert_ids, new_etag)
    log.info("CRL poll: updated %d revoked cert(s)", len(cert_ids))


async def crl_poller_loop(redis: Any, cloud_origin: str) -> None:
    """Background task: poll the CRL every 30 seconds indefinitely.

    Designed to be launched as an asyncio.Task in the chat-gateway lifespan.
    Cancellation (CancelledError) bubbles out cleanly.
    """
    log.info("CRL poller started (origin=%s, interval=%ds)", cloud_origin, CRL_POLL_INTERVAL)
    async with httpx.AsyncClient() as client:
        while True:
            try:
                await crl_poll_once(redis, cloud_origin, client)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                log.exception("Unexpected error in CRL poll cycle")
            try:
                await asyncio.sleep(CRL_POLL_INTERVAL)
            except asyncio.CancelledError:
                raise
