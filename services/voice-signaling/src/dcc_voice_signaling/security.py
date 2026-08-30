"""Token verification — mirrors chat-gateway's two-shape dispatch.

Two distinct token shapes flow through this module:

* **Cloud Access-JWT** — RS256, ``kid`` header, ``typ=access``. Validated
  against the JWKS pulled from auth-svc (``auth_jwks_url``).
* **Self-Host Session-JWT** — EdDSA, no ``kid``, ``typ=session``,
  ``iss=pulse-self-host``. Minted by chat-gateway after a Cert-Auth handshake.
  Validated here via :mod:`dcc_shared.session_tokens` so the dispatch matches
  chat-gateway exactly — without it, ``POST /token`` 401s with "missing kid"
  on a self-host instance and voice is unusable (F14).

Dispatch is keyed off cryptographic structure (``kid`` header presence), not a
payload claim: a Cloud token (with ``kid``) never reaches the self-host
validator and vice versa. A kid-less token is only accepted in self-host mode;
in cloud mode it still 401s with "missing kid" exactly as before.
"""

from __future__ import annotations

import asyncio
import json as _json
import time
from dataclasses import dataclass
from typing import Annotated, Any

import httpx
import jwt
from dcc_shared.session_tokens import (
    validate_session_token,
)
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


async def _decode_cloud_token(token: str, kid: str) -> dict[str, Any]:
    """Validate a Cloud-issued RS256 Access-JWT against the JWKS cache."""
    settings = get_settings()
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


def _decode_self_host_session_token(token: str) -> dict[str, Any]:
    """Validate a locally-issued Self-Host Session-JWT (EdDSA, no ``kid``).

    Synthesises a Cloud-Access-JWT-shaped payload — identical to chat-gateway's
    ``_decode_self_host_session_token`` — so ``get_current_user`` and the token
    route can read ``sub``/``username`` without a per-mode branch. ``sub`` is
    the synthetic 63-bit int (decimal string) derived from the pairwise-sub;
    the pairwise-sub stays available under ``pairwise_sub``.
    """
    settings = get_settings()
    claims = validate_session_token(token, key_path=settings.session_signing_key_file)
    if claims is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid token")
    # Die Kennung IST die Zahl (seit 2026-08-28, Ticket-Weg). Ein Token mit
    # nicht-numerischer Kennung ist verformt — 401 statt eines 500 aus ``int()``.
    try:
        synthetic_id = int(claims.user_identifier)
    except (TypeError, ValueError) as exc:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="invalid token"
        ) from exc
    return {
        "sub": str(synthetic_id),
        "username": "",
        "admin": claims.admin,
        "typ": "access",
        "iat": claims.iat,
        "exp": claims.exp,
        "cert_id": claims.cert_id,
        "pairwise_sub": claims.user_identifier,
        "self_host": True,
    }


async def decode_token(token: str) -> dict[str, Any]:
    """Decode + validate a bearer token (Cloud RS256 *or* Self-Host EdDSA).

    Dispatch is keyed off the ``kid`` header: present → Cloud RS256/JWKS path;
    absent → Self-Host session-JWT path, but only in self-host mode. A kid-less
    token in cloud mode keeps the historical "missing kid" rejection (and
    avoids the JWKS-flood attack the original guard was protecting against).
    """
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid token") from exc
    kid = header.get("kid")
    if kid:
        return await _decode_cloud_token(token, kid)

    # No ``kid`` → could be a Self-Host session-JWT. Only accept in self-host
    # mode; otherwise reject with "missing kid" exactly like before (also stops
    # an attacker from flooding the JWKS-fetch path with kid-less tokens).
    settings = get_settings()
    if settings.pulse_instance_mode != "self-host":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="missing kid")
    return _decode_self_host_session_token(token)


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
    # Email-verification gate: auth-svc stamps ``email_blocked`` on tokens of
    # unverified accounts once SMTP is configured — no voice until verified.
    if payload.get("email_blocked"):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, detail="email verification required"
        )
    try:
        uid = int(payload["sub"])
    except (KeyError, ValueError) as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid sub") from exc
    return AuthenticatedUser(id=uid, username=payload.get("username", ""))


CurrentUser = Annotated[AuthenticatedUser, Depends(get_current_user)]
