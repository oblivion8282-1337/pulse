"""JWT verification with JWKS caching."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Annotated, Any

import httpx
import jwt
from fastapi import Depends, Header, HTTPException, status
from jwt.algorithms import RSAAlgorithm

from dcc_chat_gateway.config import get_settings


@dataclass
class _JwksEntry:
    keys_by_kid: dict[str, Any]
    expires_at: float


_cache: _JwksEntry | None = None
_cache_generation: int = 0
_static_jwks: dict[str, Any] | None = None
_fetch_lock: asyncio.Lock | None = None


def _get_lock() -> asyncio.Lock:
    global _fetch_lock
    if _fetch_lock is None:
        _fetch_lock = asyncio.Lock()
    return _fetch_lock


def install_static_jwks(jwks: dict[str, Any]) -> None:
    """Used in tests to bypass the HTTP fetch."""
    global _static_jwks, _cache, _cache_generation
    _static_jwks = jwks
    _cache = None
    _cache_generation += 1


def reset_cache() -> None:
    global _cache, _static_jwks, _fetch_lock, _cache_generation
    _cache = None
    _static_jwks = None
    _fetch_lock = None
    _cache_generation = 0


def _build_keys(jwks: dict[str, Any]) -> dict[str, Any]:
    keys: dict[str, Any] = {}
    import json as _json

    for key_dict in jwks.get("keys", []):
        kid = key_dict.get("kid")
        if not kid:
            continue
        keys[kid] = RSAAlgorithm.from_jwk(_json.dumps(key_dict))
    return keys


async def _get_keys() -> dict[str, Any]:
    global _cache, _cache_generation
    settings = get_settings()
    now = time.monotonic()
    if _cache and _cache.expires_at > now:
        return _cache.keys_by_kid

    # Single-flight: serialize concurrent cache misses so only one JWKS fetch
    # fires per key-rollover event instead of N parallel fetches.
    async with _get_lock():
        now = time.monotonic()
        if _cache and _cache.expires_at > now:
            return _cache.keys_by_kid

        if _static_jwks is not None:
            jwks = _static_jwks
        else:
            async with httpx.AsyncClient(timeout=5.0) as http:
                resp = await http.get(settings.auth_jwks_url)
                resp.raise_for_status()
                jwks = resp.json()
        keys = _build_keys(jwks)
        _cache = _JwksEntry(keys_by_kid=keys, expires_at=now + settings.jwks_cache_seconds)
        _cache_generation += 1
        return keys


async def _force_refresh_keys() -> dict[str, Any]:
    """Force a fresh JWKS fetch for a previously-unknown ``kid``, single-flight.

    Unlike ``_get_keys()`` which short-circuits on a valid cache, this is the
    miss-path: an attacker can flood with random ``kid`` headers and previously
    each request invalidated the cache *outside* the lock and re-entered, so N
    concurrent unknown kids triggered N parallel JWKS fetches against auth-svc.
    Now we capture the generation we observed, acquire the lock, and only fetch
    if no one else refreshed in between."""
    global _cache, _cache_generation
    settings = get_settings()
    observed_gen = _cache_generation
    async with _get_lock():
        # Did another coroutine already refresh while we waited for the lock?
        if _cache is not None and _cache_generation > observed_gen:
            return _cache.keys_by_kid

        if _static_jwks is not None:
            jwks = _static_jwks
        else:
            async with httpx.AsyncClient(timeout=5.0) as http:
                resp = await http.get(settings.auth_jwks_url)
                resp.raise_for_status()
                jwks = resp.json()
        keys = _build_keys(jwks)
        _cache = _JwksEntry(
            keys_by_kid=keys,
            expires_at=time.monotonic() + settings.jwks_cache_seconds,
        )
        _cache_generation += 1
        return keys


async def decode_token(token: str) -> dict[str, Any]:
    settings = get_settings()
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid token") from exc
    kid = header.get("kid")
    # Reject tokens without a kid *before* touching the cache so an attacker
    # can't flood us with kid-less self-signed JWTs that each force a JWKS
    # refetch against auth-svc.
    if not kid:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="missing kid")
    keys = await _get_keys()
    if kid not in keys:
        # Possibly a key rollover — force-refresh once (single-flight inside).
        keys = await _force_refresh_keys()
        if kid not in keys:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="unknown signing key")

    try:
        payload = jwt.decode(
            token,
            keys[kid],
            algorithms=["RS256"],
            audience=settings.jwt_audience,
            issuer=settings.jwt_issuer,
        )
    except jwt.PyJWTError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid token") from exc
    if payload.get("typ") != "access":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="not an access token")
    return payload


@dataclass(frozen=True)
class AuthenticatedUser:
    id: int
    username: str
    is_admin: bool
    payload: dict[str, Any]


async def get_current_user(
    authorization: str | None = Header(default=None),
) -> AuthenticatedUser:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="missing bearer token")
    token = authorization.split(" ", 1)[1].strip()
    payload = await decode_token(token)
    try:
        uid = int(payload["sub"])
    except (KeyError, ValueError) as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid sub") from exc
    return AuthenticatedUser(
        id=uid,
        username=payload.get("username", ""),
        is_admin=bool(payload.get("admin", False)),
        payload=payload,
    )


CurrentUser = Annotated[AuthenticatedUser, Depends(get_current_user)]


async def require_admin(current: CurrentUser) -> AuthenticatedUser:
    """Gate admin-only routes. Trusts the JWT ``admin`` claim — the token has a
    short TTL (≤15 min), so freshly-revoked admins lose access within that
    window. Auth-svc owns the source of truth and is the only place that can
    *grant* admin (so a revoked admin can't mint themselves a new token)."""
    if not current.is_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="admin only")
    return current


AdminUser = Annotated[AuthenticatedUser, Depends(require_admin)]
