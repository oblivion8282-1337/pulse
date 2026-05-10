"""JWT verification with JWKS caching."""

from __future__ import annotations

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
_static_jwks: dict[str, Any] | None = None


def install_static_jwks(jwks: dict[str, Any]) -> None:
    """Used in tests to bypass the HTTP fetch."""
    global _static_jwks, _cache
    _static_jwks = jwks
    _cache = None


def reset_cache() -> None:
    global _cache, _static_jwks
    _cache = None
    _static_jwks = None


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
    global _cache
    settings = get_settings()
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
    return keys


async def decode_token(token: str) -> dict[str, Any]:
    settings = get_settings()
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc
    kid = header.get("kid")
    keys = await _get_keys()
    if not kid or kid not in keys:
        # try a refresh in case kid is new
        global _cache
        _cache = None
        keys = await _get_keys()
        if not kid or kid not in keys:
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
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc
    if payload.get("typ") != "access":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="not an access token")
    return payload


@dataclass(frozen=True)
class AuthenticatedUser:
    id: int
    username: str
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
    return AuthenticatedUser(id=uid, username=payload.get("username", ""), payload=payload)


CurrentUser = Annotated[AuthenticatedUser, Depends(get_current_user)]
