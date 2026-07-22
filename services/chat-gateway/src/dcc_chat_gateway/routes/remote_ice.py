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

**Single-Pod-Kopplung:** TURN-Creds gibt es nur, wenn der User Peer einer
laufenden Fernsteuerungs-Session ist — und die Session liegt im **in-process**
Registry (``remote_registry``, wie ``watch_registry``). Diese HTTP-Route muss
also **denselben Gateway-Pod** treffen wie der WebSocket des Users, sonst findet
``remote_user_has_session`` nichts und TURN bleibt aus (STUN kommt weiter). Heute
gegeben (ein Container); ein Multi-Pod-Deploy bräuchte hier ein Redis-Relay
analog zum SDP/ICE-Weiterreichen.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import time

from fastapi import APIRouter, Request

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


def _user_in_remote_session(request: Request, user_id: int) -> bool:
    """Whether the caller is a peer of a live remote-control session (host or
    controller). Missing manager (tests / not wired) ⇒ ``False`` — TURN creds
    are then withheld, STUN is still served."""
    mgr = getattr(request.app.state, "connection_manager", None)
    check = getattr(mgr, "remote_user_has_session", None)
    return bool(check(user_id)) if callable(check) else False


@router.get("/remote/ice-servers")
async def remote_ice_servers(request: Request, user: CurrentUser) -> dict[str, object]:
    settings = chat_config.get_settings()
    servers: list[dict[str, object]] = [{"urls": settings.stun_url}]
    # TURN relays real media — only hand out (short-lived) relay credentials to a
    # user who is actually in a remote-control session, so the endpoint can't be
    # abused as an open TURN-credential vendor by any authenticated account.
    if (
        settings.turn_url
        and settings.turn_secret
        and _user_in_remote_session(request, user.id)
    ):
        username, credential = ephemeral_turn_credential(
            settings.turn_secret, str(user.id), settings.turn_ttl_s
        )
        servers.append(
            {"urls": settings.turn_url, "username": username, "credential": credential}
        )
    return {"ice_servers": servers, "ttl_s": settings.turn_ttl_s}
