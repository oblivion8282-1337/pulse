"""JWT verification — dünner Shim um ``dcc_shared.token_verify``.

Die komplette Logik (JWKS-Cache + Single-Flight, kid-Dispatch Cloud/Self-Host,
``email_blocked``-Gate, Admin/Owner-Ableitung, Cross-Mode-Identifier) lebt
1:1 in ``dcc_shared.token_verify``; dieser Shim hält nur die
dienstspezifische Settings-Injektion und die FastAPI-Abhängigkeiten fest.
Tests monkeypatchen ``security.get_settings`` / rufen ``install_static_jwks``
+ ``reset_cache`` hier auf — die Wrapper lesen das Modul-Globale deshalb bei
jedem Aufruf, nicht importzeitgebunden; die JWKS-Helfer operieren direkt auf
den Globals des Shared-Moduls.

Two distinct token shapes flow through this module:

* **Cloud Access-JWT** — RS256, ``kid`` header, ``typ=access``. Validated
  against the JWKS pulled from auth-svc (``auth_jwks_url``).
* **Self-Host Session-JWT** — EdDSA, no ``kid``, ``typ=session``. Minted by
  ``session_tokens.issue_session_token`` after a Cert-Auth handshake; the
  validator synthesises a Cloud-Access-JWT-shaped payload (``sub`` = the
  synthetic 63-bit id, ``pairwise_sub`` = the original identifier).

Dispatch is keyed off cryptographic structure (``kid`` header presence), not
a payload claim that could be attacker-controlled. Siehe
``dcc_shared/token_verify.py`` für die Begründungen im Detail.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import Depends, Header, HTTPException, Query, status

from dcc_shared.token_verify import (
    AuthenticatedUser,
    _extract_bearer,
    install_static_jwks,
    reset_cache,
)
from dcc_shared import token_verify as _tv

from dcc_chat_gateway.config import get_settings

__all__ = [
    "AdminUser",
    "AuthenticatedUser",
    "CurrentUser",
    "CurrentUserQuery",
    "OwnerUser",
    "decode_token",
    "get_current_user",
    "get_current_user_token_query",
    "get_settings",
    "install_static_jwks",
    "reset_cache",
    "require_admin",
    "require_owner",
]


async def decode_token(token: str) -> dict[str, Any]:
    # Bewusst indirekt: der Name ``get_settings`` wird pro Aufruf aus den
    # Modul-Globals gelesen, damit Monkeypatches in Tests greifen.
    return await _tv.decode_token(token, get_settings)


async def get_current_user(
    authorization: str | None = Header(default=None),
) -> AuthenticatedUser:
    return await _tv.get_current_user(authorization, get_settings)


async def get_current_user_token_query(
    authorization: str | None = Header(default=None),
    token: str | None = Query(default=None),
) -> AuthenticatedUser:
    """Accept the bearer token from the ``Authorization`` header **or** a
    ``?token=`` query param. The query form exists for browser-initiated
    downloads (``window.location.href`` / ``<a href>`` can't attach a header)
    and mirrors the WS endpoint's ``token`` query param. Same verification +
    gates as the header path — just an extra intake channel."""
    return await _tv._user_from_token(_extract_bearer(authorization) or token, get_settings)


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
