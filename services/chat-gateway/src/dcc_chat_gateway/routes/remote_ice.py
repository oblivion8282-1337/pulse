"""ICE-Server für die Fernsteuerung (remote control, M3).

Liefert die STUN/TURN-Liste, die Controller **und** Host (Sidecar) für die
P2P-WebRTC brauchen. STUN ist immer dabei; ist ein TURN-Server konfiguriert,
gibt es **zeitlich begrenzte** Credentials nach dem TURN-REST-API-Muster
(coturn ``use-auth-secret``): kein Dauer-Passwort landet im Client.

    username   = "<ablauf-unix>:<user_id>"
    credential = base64( HMAC-SHA1( turn_secret, username ) )

coturn validiert das selbst aus demselben ``static-auth-secret`` — der Server
muss die einzelnen Credentials nicht speichern. TTL kurz halten
(``turn_ttl_s``, Default 300 s): der Client holt die Liste kurz vor jeder
Session.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import time

from fastapi import APIRouter

from dcc_chat_gateway import config as chat_config
from dcc_chat_gateway.security import CurrentUser

router = APIRouter()


def ephemeral_turn_credential(secret: str, user_id: str, ttl_s: int) -> tuple[str, str]:
    """(username, credential) nach TURN-REST-API. `now` wird hier gelesen — die
    Reinheit fürs Testen kommt über ``_credential_for`` (nimmt den Ablauf rein)."""
    expiry = int(time.time()) + ttl_s
    return _credential_for(secret, user_id, expiry)


def _credential_for(secret: str, user_id: str, expiry: int) -> tuple[str, str]:
    username = f"{expiry}:{user_id}"
    digest = hmac.new(secret.encode(), username.encode(), hashlib.sha1).digest()
    return username, base64.b64encode(digest).decode()


@router.get("/remote/ice-servers")
async def remote_ice_servers(user: CurrentUser) -> dict[str, object]:
    settings = chat_config.get_settings()
    servers: list[dict[str, object]] = [{"urls": settings.stun_url}]
    if settings.turn_url and settings.turn_secret:
        username, credential = ephemeral_turn_credential(
            settings.turn_secret, str(user.id), settings.turn_ttl_s
        )
        servers.append(
            {"urls": settings.turn_url, "username": username, "credential": credential}
        )
    return {"ice_servers": servers, "ttl_s": settings.turn_ttl_s}
