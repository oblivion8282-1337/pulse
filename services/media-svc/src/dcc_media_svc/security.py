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

import secrets as _secrets
from typing import Annotated, Any

from fastapi import Depends, Header, HTTPException, status
from dcc_shared.token_verify import (
    AuthenticatedUser,
    _extract_bearer,
    install_static_jwks,
    reset_cache,
)
from dcc_shared import token_verify as _tv
from dcc_shared.gast_ticket import GastClaims, decode_gast_ticket

from dcc_media_svc.config import get_settings

__all__ = [
    "AuthenticatedUser",
    "CurrentGast",
    "CurrentUser",
    "decode_token",
    "get_current_user",
    "get_settings",
    "install_static_jwks",
    "require_internal",
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

    Eigene Abhaengigkeit statt eines zweiten Zweigs in ``get_current_user``:
    ein Gast ist kein Nutzer, und ``CurrentUser`` weist sein Ticket weiterhin
    ab (``_decode_cloud_token`` verlangt ``typ == "access"``). Genau eine
    Route hier kennt sie: ``GET /gast/whep``.
    """
    from fastapi import HTTPException, status  # noqa: PLC0415

    token = _extract_bearer(authorization)
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="missing guest ticket")
    return await decode_gast_ticket(token, get_settings)


CurrentGast = Annotated[GastClaims, Depends(get_current_gast)]


async def require_internal(
    x_pulse_internal_secret: str | None = Header(default=None),
) -> None:
    """Member-Routen duerfen nur der chat-gateway-Proxy rufen (Audit 2026-09-16).

    Bisher prueften diese Routen NUR den Bearer — die Kanal-Autorisierung
    (Mitgliedschaft, STREAM, VIEW_CHANNEL) lag komplett beim vorgeschalteten
    chat-gateway. Wer media-svc direkt erreichte (Dev-Port, falscher
    Reverse-Proxy — die Selfhost-Caddy-Exposition war real, siehe Kommentar in
    ``routes.py``), bekam Publish- und Lese-Token fuer JEDESKANAL. Das Shared
    Secret hier macht die Proxy-Annahme zur erzwungenen Eigenschaft: ohne
    korrekten Header gibt es 503, fail-closed auch wenn das Secret ungesetzt
    ist. Der Bearer bleibt daneben stehen — media-svc leitet daraus die
    Nutzer-Identitaet ab (``sub``), das Secret sagt nur: dieser Aufruf kam
    durch die Pruefung des Gateways.
    """
    expected = get_settings().internal_service_secret
    if not expected:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, detail="internal routes disabled"
        )
    given = x_pulse_internal_secret or ""
    if not _secrets.compare_digest(given.encode(), expected.encode()):
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, detail="internal routes disabled"
        )
