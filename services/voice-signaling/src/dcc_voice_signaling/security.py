"""JWKS-based access-token verification (mirrors chat-gateway)."""

from __future__ import annotations

import asyncio
import json as _json
import time
from dataclasses import dataclass
from typing import Annotated, Any

import httpx
import jwt
from fastapi import Depends, Header, HTTPException, status
from jwt.algorithms import RSAAlgorithm

from dcc_voice_signaling.config import get_settings


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
    See chat-gateway/security.py for the rationale."""
    global _cache, _cache_generation
    settings = get_settings()
    observed_gen = _cache_generation
    async with _get_lock():
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
    # Reject tokens without a kid *before* touching the cache. Otherwise an
    # attacker could flood the endpoint with kid-less self-signed JWTs and
    # force one JWKS-fetch per request (the cache invalidation below would
    # otherwise fire on every miss).
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
    return AuthenticatedUser(id=uid, username=payload.get("username", ""))


CurrentUser = Annotated[AuthenticatedUser, Depends(get_current_user)]
