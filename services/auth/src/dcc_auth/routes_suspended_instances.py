"""Public suspended-instances list + internal broadcast-update endpoint.

GET  /.well-known/pulse-suspended-instances  — public, ETag-cached.
POST /admin/instances/_broadcast-update      — internal-secret auth.

Redis-Konvention:
  Key  ``auth:suspended_instances:etag``   STRING  SHA-256 des Inhalts
  Key  ``auth:suspended_instances:body``   STRING  serialisierter JSON-Body

Phase-2.3-Helfer: ``suspended_list_add`` + ``suspended_list_remove`` invalidieren den
Cache. Phase-2.3 importiert diese nach dem Merge.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import time
from typing import Annotated

import httpx
from fastapi import APIRouter, Header, HTTPException, Request, Response, status
from sqlalchemy import select

from dcc_auth.db import SessionDep
from dcc_auth.models_instances import RegisteredInstance, SuspendedInstance
from dcc_auth.routes import _check_rate

log = logging.getLogger(__name__)

router = APIRouter()

# Redis key names
_ETAG_KEY = "auth:suspended_instances:etag"
_BODY_KEY = "auth:suspended_instances:body"


# ---------------------------------------------------------------------------
# Redis helpers
# ---------------------------------------------------------------------------


async def _get_redis(request: Request):
    redis = getattr(request.app.state, "redis", None)
    if redis is None:
        return None
    try:
        await redis.ping()
        return redis
    except Exception:  # noqa: BLE001
        return None


def _quoted(etag: str) -> str:
    return f'"{etag}"'


# ---------------------------------------------------------------------------
# Cache-Invalidation — callable by Phase 2.3
# ---------------------------------------------------------------------------


async def suspended_list_add(redis, instance_id: int, reason: str | None = None) -> None:
    """Invalidate the suspended-instances cache after a suspend operation.

    Phase 2.3 calls this after setting ``registered_instances.status='suspended'``
    and inserting into ``suspended_instances``.
    """
    try:
        await _invalidate_cache(redis)
    except Exception:  # noqa: BLE001
        log.warning("suspended_list_add: cache invalidation failed for instance_id=%s", instance_id)


async def suspended_list_remove(redis, instance_id: int) -> None:
    """Invalidate the suspended-instances cache after an unsuspend operation.

    Phase 2.3 calls this after removing from ``suspended_instances`` and
    setting ``registered_instances.status='active'``.
    """
    try:
        await _invalidate_cache(redis)
    except Exception:  # noqa: BLE001
        log.warning(
            "suspended_list_remove: cache invalidation failed for instance_id=%s", instance_id
        )


async def _invalidate_cache(redis) -> None:
    """Delete the cached ETag + body so the next request recomputes from DB."""
    try:
        await redis.delete(_ETAG_KEY, _BODY_KEY)
    except Exception:  # noqa: BLE001
        log.warning("suspended_instances: cache invalidation failed")


# ---------------------------------------------------------------------------
# DB helper
# ---------------------------------------------------------------------------


_EPOCH = "1970-01-01T00:00:00+00:00"


async def _fetch_from_db(session) -> tuple[list[str], str]:
    """Return (sorted instance_id strings, ISO updated_at) from DB."""
    rows = (
        await session.execute(
            select(SuspendedInstance).order_by(SuspendedInstance.suspended_at.desc())
        )
    ).scalars().all()
    ids = sorted(str(r.instance_id) for r in rows)
    # Use a stable epoch timestamp when empty so ETag is deterministic across calls.
    updated_at = max(r.suspended_at for r in rows).isoformat() if rows else _EPOCH
    return ids, updated_at


def _compute_etag(ids: list[str], updated_at: str) -> str:
    payload = ("\n".join(sorted(ids)) + updated_at).encode()
    return hashlib.sha256(payload).hexdigest()


def _build_body(ids: list[str], updated_at: str) -> dict:
    return {"version": 1, "instance_ids": ids, "updated_at": updated_at}


# ---------------------------------------------------------------------------
# Public endpoint
# ---------------------------------------------------------------------------


@router.get("/.well-known/pulse-suspended-instances")
async def suspended_instances(
    request: Request,
    response: Response,
    session: SessionDep,
    if_none_match: Annotated[str | None, Header(alias="If-None-Match")] = None,
):
    """Return all currently-suspended instance IDs.

    Public, no auth. ETag-cached; 304 when unchanged.
    Rate-limited: 60/minute per IP.
    """
    await _check_rate(request, "suspended_instances_fetch", "60/minute")

    redis = await _get_redis(request)

    if redis is not None:
        cached_etag = await redis.get(_ETAG_KEY)
        if cached_etag is not None:
            etag_str = cached_etag.decode() if isinstance(cached_etag, bytes) else cached_etag
            quoted = _quoted(etag_str)
            if if_none_match and (if_none_match == quoted or if_none_match.strip('"') == etag_str):
                return Response(status_code=status.HTTP_304_NOT_MODIFIED)
            # Try cached body first
            cached_body = await redis.get(_BODY_KEY)
            if cached_body is not None:
                raw = cached_body.decode() if isinstance(cached_body, bytes) else cached_body
                response.headers["ETag"] = quoted
                response.headers["Cache-Control"] = "public, max-age=60"
                return json.loads(raw)

        # Recompute from DB
        ids, updated_at = await _fetch_from_db(session)
        etag_str = _compute_etag(ids, updated_at)
        body = _build_body(ids, updated_at)
        await redis.set(_ETAG_KEY, etag_str)
        await redis.set(_BODY_KEY, json.dumps(body))
    else:
        # No Redis — compute from DB every time
        ids, updated_at = await _fetch_from_db(session)
        etag_str = _compute_etag(ids, updated_at)
        body = _build_body(ids, updated_at)

    quoted = _quoted(etag_str)
    if if_none_match and (if_none_match == quoted or if_none_match.strip('"') == etag_str):
        return Response(status_code=status.HTTP_304_NOT_MODIFIED)

    response.headers["ETag"] = quoted
    response.headers["Cache-Control"] = "public, max-age=60"
    return body


# ---------------------------------------------------------------------------
# Internal: broadcast-update
# ---------------------------------------------------------------------------


def _require_internal_secret(authorization: str | None = Header(default=None)) -> None:
    """Dependency: reject requests without a matching INTERNAL_SERVICE_SECRET."""
    from dcc_auth.config import get_settings

    secret = get_settings().internal_service_secret
    if not secret:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="INTERNAL_SERVICE_SECRET not configured",
        )
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="missing bearer token")
    token = authorization.split(" ", 1)[1].strip()
    if not hmac.compare_digest(token, secret):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid internal secret")


@router.post("/admin/instances/_broadcast-update")
async def broadcast_update(
    session: SessionDep,
    _auth: None = Header(default=None),  # placeholder; real check via Depends below
    authorization: str | None = Header(default=None),
):
    """Notify all active instances to pull a software update.

    Auth: INTERNAL_SERVICE_SECRET Bearer token.

    For each active RegisteredInstance sends a signed short-lived JWT
    (purpose=watchtower-update, exp=now+60s) to
    ``https://<hostname>/internal/trigger-update``.

    Returns {ok: [hostname, ...], failed: [{hostname, reason}, ...]}.
    Does NOT persist per-instance secrets — the JWT is signed with the
    cloud's RS256 key and each instance verifies it via the JWKS endpoint.
    """
    # Inline auth check (can't use Depends cleanly when also needing session)
    from dcc_auth.config import get_settings
    from dcc_auth.security import get_signer

    settings = get_settings()
    secret = settings.internal_service_secret
    if not secret:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="INTERNAL_SERVICE_SECRET not configured",
        )
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="missing bearer token")
    token = authorization.split(" ", 1)[1].strip()
    if not hmac.compare_digest(token, secret):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid internal secret")

    # Fetch all active instances
    rows = (
        await session.execute(
            select(RegisteredInstance).where(RegisteredInstance.status == "active")
        )
    ).scalars().all()

    if not rows:
        return {"ok": [], "failed": []}

    signer = get_signer()
    now = int(time.time())

    import jwt as pyjwt

    ok_list: list[str] = []
    failed_list: list[dict] = []

    async def _notify(instance: RegisteredInstance, hx: httpx.AsyncClient) -> None:
        # Sign a short-lived watchtower JWT
        payload = {
            "purpose": "watchtower-update",
            "instance_id": str(instance.id),
            "iat": now,
            "exp": now + 60,
        }
        tok = pyjwt.encode(
            payload,
            signer._private_key,
            algorithm="RS256",
            headers={"kid": settings.jwt_key_id},
        )
        url = f"https://{instance.hostname}/internal/trigger-update"
        try:
            async with asyncio.timeout(5.0):
                resp = await hx.post(url, headers={"Authorization": f"Bearer {tok}"})
            if resp.status_code < 400:
                ok_list.append(instance.hostname)
            else:
                failed_list.append(
                    {"hostname": instance.hostname, "reason": f"HTTP {resp.status_code}"}
                )
        except Exception as exc:  # noqa: BLE001
            failed_list.append({"hostname": instance.hostname, "reason": str(exc)})

    async with httpx.AsyncClient(verify=True) as hx:
        await asyncio.gather(*(_notify(r, hx) for r in rows))
    return {"ok": ok_list, "failed": failed_list}
