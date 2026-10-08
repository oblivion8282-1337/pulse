"""VoIP-Token-Verwaltung (iOS-Liste Punkt 40) — Anmelden und Abmelden.

Die iOS-App holt beim Start einen PushKit-Token und meldet ihn hier an; beim
Sign-Out trägt sie ihn wieder ab. Der Versand lebt in
:mod:`dcc_chat_gateway.apns_voip`, der Fan-out im Anruf-Pfad.

**Das ist NICHT der FCM-Token.** Dasselbe Gerät führt beide gleichzeitig:
den FCM-Token für Nachrichten-Banner, den PushKit-Token fürs Klingeln. Eigene
Tabelle, eigener Endpunkt, eigener APNs-Topic (Begründung am Modell
``VoipToken``).

Endpunkte
---------
* ``POST   /voip/token`` — Token speichern/aktualisieren (idempotent).
* ``DELETE /voip/token`` — Token entfernen (Logout, App-Daten löschen).

Der Versand braucht zusätzlich einen APNs-Schlüssel am Server (``APNS_*``).
Ohne ihn bleibt die Anmeldung bestehen, es geht nur nichts raus — derselbe
Umgang wie bei ``fcm.ensure_fcm``: eine Fehlkonfiguration darf einen Anruf
nicht verhindern, der sonst über die WebSocket zustande käme.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Response, status
from pydantic import BaseModel, Field

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import VoipToken
from dcc_chat_gateway.ratelimit import check as ratelimit_check
from dcc_chat_gateway.routes import _geraetetoken as geraetetoken
from dcc_chat_gateway.security import CurrentUser

router = APIRouter(prefix="/voip", tags=["voip"])


class VoipTokenIn(BaseModel):
    token: str = Field(min_length=1, max_length=4096)
    #: Gerätelokale, persistierte Kennung des Klienten — derselbe Wert, den
    #: die FCM-Anmeldung benutzt. Ein Gerät, zwei Registrierungen.
    geraet_id: str = Field(min_length=1, max_length=128)


class VoipTokenEntfernen(BaseModel):
    token: str = Field(min_length=1, max_length=4096)


@router.post("/token", status_code=status.HTTP_204_NO_CONTENT)
async def token_speichern(
    payload: VoipTokenIn,
    session: SessionDep,
    current: CurrentUser,
) -> Response:
    """Token dieses Geräts speichern oder auffrischen."""
    if not ratelimit_check("voip_token", current.id):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="rate_limited")
    await geraetetoken.upsert(
        session=session,
        modell=VoipToken,
        user_id=current.id,
        geraet_id=payload.geraet_id,
        token=payload.token,
        konflikt_detail="voip_token_belegt",
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/token", status_code=status.HTTP_204_NO_CONTENT)
async def token_entfernen(
    payload: VoipTokenEntfernen,
    session: SessionDep,
    current: CurrentUser,
) -> Response:
    """Token abmelden (Sign-Out). Still 204 auf einem unbekannten Token —
    die Route ist idempotent und verrät nicht, was fremde Geräte tun."""
    await geraetetoken.entfernen(
        session=session, modell=VoipToken, user_id=current.id, token=payload.token
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
