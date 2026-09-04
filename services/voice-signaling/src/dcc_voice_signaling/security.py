"""Token verification — dünner Shim um ``dcc_shared.token_verify``.

Die komplette Logik (JWKS-Cache + Single-Flight, kid-Dispatch Cloud/Self-Host,
``email_blocked``-Gate) lebt einmal in ``dcc_shared.token_verify``; dieser
Shim hält nur die dienstspezifische Settings-Injektion fest. Tests
monkeypatchen ``voice_security.get_settings`` — die Wrapper lesen das
Modul-Globale deshalb bei jedem Aufruf, nicht importzeitgebunden.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import Depends, Header
from dcc_shared.token_verify import (
    AuthenticatedUser,
    _extract_bearer,
    install_static_jwks,
    reset_cache,
)
from dcc_shared import token_verify as _tv
from dcc_shared.gast_ticket import GastClaims, decode_gast_ticket

from dcc_voice_signaling.config import get_settings

__all__ = [
    "AuthenticatedUser",
    "CurrentGast",
    "CurrentUser",
    "decode_token",
    "get_current_user",
    "get_settings",
    "install_static_jwks",
    "reset_cache",
]


async def decode_token(token: str) -> dict[str, Any]:
    # Bewusst indirekt: der Name ``get_settings`` wird pro Aufruf aus den
    # Modul-Globals gelesen, damit Monkeypatches in Tests greifen.
    return await _tv.decode_token(token, get_settings)


async def get_current_user(
    authorization: str | None = Header(default=None),
) -> AuthenticatedUser:
    return await _tv.get_current_user(authorization, get_settings)


CurrentUser = Annotated[AuthenticatedUser, Depends(get_current_user)]


async def get_current_gast(
    authorization: str | None = Header(default=None),
) -> GastClaims:
    """Ein Gast-Ticket (``typ="gast"``), sonst 401.

    Eigene Abhaengigkeit statt eines Gast-Zweigs in ``get_current_user``: ein
    Gast ist kein Nutzer. ``CurrentUser`` weist sein Ticket weiterhin ab
    (``_decode_cloud_token`` verlangt ``typ == "access"``), und genau eine
    Route hier kennt sie — ``POST /gast/token``.
    """
    from fastapi import HTTPException, status  # noqa: PLC0415

    token = _extract_bearer(authorization)
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="missing guest ticket")
    return await decode_gast_ticket(token, get_settings)


CurrentGast = Annotated[GastClaims, Depends(get_current_gast)]
