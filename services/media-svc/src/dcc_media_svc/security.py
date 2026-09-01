"""Token verification — dünner Shim um ``dcc_shared.token_verify``.

Die komplette Logik (JWKS-Cache + Single-Flight, kid-Dispatch Cloud/Self-Host)
lebt einmal in ``dcc_shared.token_verify``; dieser Shim hält nur die
dienstspezifische Settings-Injektion fest. media-svc übernimmt dadurch auch
das ``email_blocked``-Gate aus ``get_current_user`` — gleicher Gate wie
voice-signaling — Drift gefixt: die frühere Kopie hier kannte ihn nicht,
unbestätigte Accounts konnten streamen. Tests
monkeypatchen ``media_security.get_settings`` — die Wrapper lesen das
Modul-Globale deshalb bei jedem Aufruf, nicht importzeitgebunden.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import Depends, Header
from dcc_shared.token_verify import (
    AuthenticatedUser,
    install_static_jwks,
    reset_cache,
)
from dcc_shared import token_verify as _tv

from dcc_media_svc.config import get_settings

__all__ = [
    "AuthenticatedUser",
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
