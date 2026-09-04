"""Gast-Tickets prüfen — die eine Stelle für alle drei Dienste.

Ein Gast (Besprechungslink, kein Konto) legt statt eines Zugangstokens ein
``typ="gast"``-Ticket vor, das auth-svc ausstellt (dort ``security.py::
issue_gast``). chat-gateway, voice-signaling und media-svc nehmen dasselbe
Ticket an — drei Kopien dieser Prüfung wären drei Gelegenheiten zum
Auseinanderlaufen, und die eine, die ihren ``typ``-Check verlöre, machte aus
einem Gast einen Vollnutzer.

Eigene Datei statt eines Anhangs an ``token_verify``: die beiden prüfen
verschiedene Dinge (ein Konto gegen ein Ticket), und ``token_verify`` lag mit
dem Gast-Teil über der Größen-Grenze aus PLAN.md §12.1. Der JWKS-Cache wird
von dort mitbenutzt — es ist derselbe Schlüsselsatz, und ein zweiter Cache
daneben hiesse doppelt abrufen.

Der normale Weg bleibt davon unberührt geschlossen: ``_decode_cloud_token``
verlangt ``typ == "access"``, ein Gast-Ticket fällt dort ohne Zutun heraus. Es
gibt deshalb NIRGENDS ein „Nutzer oder Gast" an einer Abhängigkeit — eine
Route nimmt entweder das eine oder das andere.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

import jwt
from fastapi import HTTPException, status

from dcc_shared.token_verify import _force_refresh_keys, _get_keys

__all__ = ["GastClaims", "decode_gast_ticket"]

@dataclass(frozen=True)
class GastClaims:
    """Der geprüfte Inhalt eines Gast-Tickets."""

    gast_id: str  # "gast-<snowflake>" — auch die LiveKit-Identität
    guild_id: str
    channel_id: str
    name: str  # selbst getippt, NICHT verifiziert → überall als Gast markieren
    exp: int


async def decode_gast_ticket(
    token: str, get_settings: Callable[[], Any]
) -> GastClaims:
    """Ein Gast-Ticket prüfen. Wirft 401, wenn irgendetwas nicht stimmt.

    Nur der Cloud-Pfad (RS256 mit ``kid`` gegen die JWKS von auth-svc) — und
    zwar in BEIDEN Betriebsarten: ein Self-Host betreibt sein eigenes auth-svc
    und damit seine eigene JWKS. Ein kid-loses Ticket gibt es nicht.
    """
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError as exc:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="invalid guest ticket"
        ) from exc
    kid = header.get("kid")
    if not kid:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="invalid guest ticket"
        )
    settings = get_settings()
    keys = await _get_keys(get_settings)
    if kid not in keys:
        keys = await _force_refresh_keys(get_settings)
        if kid not in keys:
            raise HTTPException(
                status.HTTP_401_UNAUTHORIZED, detail="unknown signing key"
            )
    try:
        payload = jwt.decode(
            token,
            keys[kid],
            algorithms=["RS256"],
            audience=settings.jwt_audience,
            issuer=settings.jwt_issuer,
        )
    except jwt.PyJWTError as exc:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="invalid guest ticket"
        ) from exc
    if payload.get("typ") != "gast":
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="not a guest ticket"
        )
    gast_id = str(payload.get("sub") or "")
    channel_id = str(payload.get("channel_id") or "")
    guild_id = str(payload.get("guild_id") or "")
    # Ein Ticket ohne Kanalbindung wäre ein Ticket für jeden Kanal. Fehlt sie,
    # ist das Ticket verformt — abweisen, nicht großzügig auslegen.
    if not gast_id.startswith("gast-") or not channel_id or not guild_id:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="malformed guest ticket"
        )
    return GastClaims(
        gast_id=gast_id,
        guild_id=guild_id,
        channel_id=channel_id,
        name=str(payload.get("name") or "").strip() or "Gast",
        exp=int(payload.get("exp", 0)),
    )
