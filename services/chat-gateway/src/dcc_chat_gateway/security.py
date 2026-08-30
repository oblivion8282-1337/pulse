"""JWT verification with JWKS caching.

Two distinct token shapes flow through this module:

* **Cloud Access-JWT** — RS256, ``kid`` header, ``typ=access``, ``iss=jwt_issuer``.
  Validated against the JWKS pulled from auth-svc (``auth_jwks_url``).
* **Self-Host Session-JWT** — EdDSA, no ``kid``, ``typ=session``,
  ``iss=pulse-self-host``. Minted locally by ``session_tokens.issue_session_token``
  after a successful Cert-Auth handshake.

Routing logic in :func:`decode_token`:
  1. If the token carries a ``kid`` header → try Cloud-RS256 path.
  2. Otherwise: if ``pulse_instance_mode == "self-host"`` → try local
     EdDSA validation; the token's ``sub`` claim is a pairwise-sub
     (Base64url string).  We synthesise a stable 63-bit numeric user_id
     from it so the existing ``BIGINT user_id`` FK columns keep working
     without a schema migration (Plan §C — incremental path; full TEXT
     migration deferred).
  3. Anything else → 401.

A Cloud-token (with ``kid``) NEVER reaches the Self-Host validator and
vice versa — the dispatch is keyed off cryptographic structure
(``kid`` header presence + signing algorithm), not off a payload claim
that could be attacker-controlled.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Annotated, Any

import httpx
import jwt

from fastapi import Depends, Header, HTTPException, Query, status
from jwt.algorithms import RSAAlgorithm

from dcc_chat_gateway.config import get_settings
from dcc_chat_gateway.session_tokens import validate_session_token


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

    for key_dict in jwks.get("keys", []):
        kid = key_dict.get("kid")
        if not kid:
            continue
        keys[kid] = RSAAlgorithm.from_jwk(key_dict)
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


async def _decode_cloud_token(token: str) -> dict[str, Any]:
    """Validate a Cloud-issued RS256 Access-JWT against the JWKS cache."""
    settings = get_settings()
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid token") from exc
    kid = header.get("kid")
    if not kid:
        # Caller (``decode_token``) only routes here when ``kid`` is set, so
        # this is defensive — keeps the historical 401 reason intact for any
        # direct caller that bypasses the dispatcher.
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


def _decode_self_host_session_token(token: str) -> dict[str, Any]:
    """Validate a locally-issued Self-Host Session-JWT.

    Synthesises a Cloud-Access-JWT-shaped payload so downstream routes that
    pull ``payload["sub"]`` / ``payload["exp"]`` directly (presence,
    ws.websocket_endpoint, …) keep working without per-route mode checks.

    The pairwise-sub stays available as the dedicated ``pairwise_sub`` claim
    and on ``AuthenticatedUser.user_identifier``; ``sub`` is overwritten with
    the synthetic int (decimal string, like the Cloud Access-JWT carries).
    """
    settings = get_settings()
    key_path = settings.session_signing_key_file
    claims = validate_session_token(token, key_path=key_path)
    if claims is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid token")
    # Die Kennung IST die Zahl — es gibt seit dem Ticket-Weg nur noch eine
    # Identität. Hier stand bis zum 2026-08-28 eine Uebersetzung aus einem
    # Base64url-Pseudonym in einen BIGINT.
    #
    # Ein Token mit nicht-numerischer Kennung ist verformt (die Cloud setzt dort
    # immer eine Nutzer-ID). Ohne diesen Fang bräche ``int()`` mit einem 500 ab,
    # wo ein 401 hingehört — der Aufrufer soll einen Auth-Fehler sehen, keinen
    # Serverfehler.
    try:
        synthetic_id = int(claims.user_identifier)
    except (TypeError, ValueError) as exc:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="invalid token"
        ) from exc
    # Shape-compatible with the Cloud Access-JWT path: ``sub`` is a decimal
    # int-string, ``typ`` mirrors the historical access-token shape so any
    # downstream code that asserts ``typ == "access"`` keeps working.  The
    # original ``typ=session`` from the raw JWT is dropped on purpose — by
    # the time we mint this payload we've already proven the token is a
    # valid Self-Host session-JWT (EdDSA signature + iss/aud match), and
    # exposing it as ``session`` here would force every route to handle
    # two ``typ`` values.
    return {
        "sub": str(synthetic_id),
        "username": "",
        # Self-host admin = the instance owner, marked when the session is issued and
        # carried in the session token (see issue_session_token ``admin``).
        "admin": claims.admin,
        "typ": "access",
        "iat": claims.iat,
        "exp": claims.exp,
        "cert_id": claims.cert_id,
        "pairwise_sub": claims.user_identifier,
        "self_host": True,
    }


async def decode_token(token: str) -> dict[str, Any]:
    """Decode + validate a bearer token.

    Cloud-mode and Self-Host-mode tokens live side by side here. The dispatch
    is driven purely by *cryptographic structure*: a Cloud Access-JWT carries
    a ``kid`` header (it has to — JWKS lookup needs it); a Self-Host Session-
    JWT does not. An attacker can't mint a Cloud-token without an auth-svc
    private key and can't mint a Self-Host token without the local Ed25519
    key file — so the two paths are not confusable.
    """
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid token") from exc

    if header.get("kid"):
        # Cloud path — always available regardless of instance_mode (a Self-
        # Host can in theory accept Cloud tokens too if it's misconfigured to
        # point its JWKS URL at the Cloud, but the audience/issuer checks
        # gate that). The historical ``missing kid`` rejection still applies
        # to kid-less tokens in Cloud mode, see below.
        return await _decode_cloud_token(token)

    # No ``kid`` → could be a Self-Host session-JWT. Only accept if we
    # actually run in self-host mode; otherwise behave exactly like the
    # original implementation (reject with ``missing kid``) so an attacker
    # on a Cloud deployment can't probe for a self-host fallback.
    settings = get_settings()
    if settings.pulse_instance_mode != "self-host":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="missing kid")
    return _decode_self_host_session_token(token)


@dataclass(frozen=True)
class AuthenticatedUser:
    id: int
    username: str
    is_admin: bool
    payload: dict[str, Any]
    # Stable cross-mode identifier — Cloud: ``str(id)`` (decimal user_id);
    # Self-Host: the pairwise-sub (Base64url-truncated HMAC). Use this for
    # cache keys / external surfaces; use ``id`` for FK columns.
    user_identifier: str = ""
    # True iff the token was issued by the local Self-Host (DE 9 session-JWT).
    is_self_host: bool = field(default=False)
    # True iff the Cloud operator (auth-svc ``is_owner``, JWT ``owner`` claim).
    # Cloud-only — forced False for Self-Host tokens (their owner is a
    # per-instance admin, not the platform owner). Gates cloud-wide community
    # oversight + emergency reported-content access. Defaulted so the many test
    # constructions that predate it keep working.
    is_owner: bool = False


async def _user_from_token(token: str | None) -> AuthenticatedUser:
    """Shared verify-and-build path for the auth dependencies.

    Takes an already-extracted bearer token (from header or query) and
    returns the authenticated user. Both call-sites share the same
    email-verification gate + admin-derivation so behaviour can't drift
    between header- and query-authenticated routes.
    """
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="missing bearer token")
    payload = await decode_token(token)
    # Email-verification gate: auth-svc stamps ``email_blocked`` on tokens of
    # unverified accounts once SMTP is configured. The whole chat-gateway is
    # off-limits until the address is confirmed (auth-svc itself stays open so
    # the user can still verify / fix their email).
    if payload.get("email_blocked"):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, detail="email verification required"
        )
    try:
        uid = int(payload["sub"])
    except (KeyError, ValueError) as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid sub") from exc
    settings = get_settings()
    is_self_host = settings.pulse_instance_mode == "self-host"
    # Cross-mode identifier: Cloud → ``str(id)``; Self-Host → the pairwise-sub
    # carried in ``payload["pairwise_sub"]`` (set by
    # ``_decode_self_host_session_token``). Falls back to ``str(uid)`` so any
    # code path that happens to introduce a Self-Host token without setting
    # the claim still produces a stable string identifier.
    identifier = (
        str(payload.get("pairwise_sub") or uid) if is_self_host else str(uid)
    )
    # Admin kommt ausschliesslich aus dem ``admin``-Claim, den cert_login beim
    # Ausstellen des Session-Tokens setzt. Der frueher hier stehende zweite
    # Vergleich (uid gegen PULSE_INSTANCE_OWNER_ID) konnte nie zutreffen: auf
    # einem Self-Host ist ``uid`` die synthetische ID aus
    # ``_decode_self_host_session_token``, nicht die rohe Cloud-User-ID — die
    # ist hier gar nicht mehr vorhanden. Toter Zweig, entfernt 2026-07-27;
    # dieselbe Stelle gab es in routes/ws.py.
    is_admin = bool(payload.get("admin", False))
    # Owner = the Cloud operator only. Self-Host tokens never carry it (and even
    # if one did, force False — Self-Host has no platform owner).
    is_owner = not is_self_host and bool(payload.get("owner", False))
    return AuthenticatedUser(
        id=uid,
        username=payload.get("username", ""),
        is_admin=is_admin,
        is_owner=is_owner,
        payload=payload,
        user_identifier=identifier,
        is_self_host=is_self_host,
    )


def _extract_bearer(authorization: str | None) -> str | None:
    """Pull the token out of an ``Authorization: Bearer …`` header (case-
    insensitive prefix). Returns ``None`` if the header is missing or shaped
    differently — the caller decides whether that's fatal or falls back to a
    query-param token."""
    if authorization and authorization.lower().startswith("bearer "):
        return authorization.split(" ", 1)[1].strip()
    return None


async def get_current_user(
    authorization: str | None = Header(default=None),
) -> AuthenticatedUser:
    return await _user_from_token(_extract_bearer(authorization))


async def get_current_user_token_query(
    authorization: str | None = Header(default=None),
    token: str | None = Query(default=None),
) -> AuthenticatedUser:
    """Accept the bearer token from the ``Authorization`` header **or** a
    ``?token=`` query param. The query form exists for browser-initiated
    downloads (``window.location.href`` / ``<a href>`` can't attach a header)
    and mirrors the WS endpoint's ``token`` query param. Same verification +
    gates as the header path — just an extra intake channel."""
    return await _user_from_token(_extract_bearer(authorization) or token)


CurrentUser = Annotated[AuthenticatedUser, Depends(get_current_user)]
CurrentUserQuery = Annotated[AuthenticatedUser, Depends(get_current_user_token_query)]


async def require_admin(current: CurrentUser) -> AuthenticatedUser:
    """Gate admin-only routes. Trusts the JWT ``admin`` claim — the token has a
    short TTL (≤15 min), so freshly-revoked admins lose access within that
    window. Auth-svc owns the source of truth and is the only place that can
    *grant* admin (so a revoked admin can't mint themselves a new token)."""
    if not current.is_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="admin only")
    return current


AdminUser = Annotated[AuthenticatedUser, Depends(require_admin)]


async def require_owner(current: CurrentUser) -> AuthenticatedUser:
    """Gate Cloud-operator-only routes (cloud-wide community oversight,
    emergency reported-content access). Stricter than ``require_admin``: only
    the single ``is_owner`` account passes. Self-Host tokens never carry the
    claim, so this is implicitly Cloud-only."""
    if not current.is_owner:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="owner only")
    return current


OwnerUser = Annotated[AuthenticatedUser, Depends(require_owner)]
