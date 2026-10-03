"""FCM-Token-Verwaltung (Übergabe P0.1) — Anmelden und Abmelden.

Die Android-App holt beim Start ein FCM-Registrierungstoken (via
``@capacitor-firebase/messaging``) und meldet es hier an; beim Sign-Out
trägt sie es wieder ab. Der Push-Versand selbst lebt in
:mod:`dcc_chat_gateway.fcm`.

Endpunkte
---------
* ``POST   /fcm/token`` — Token speichern/aktualisieren (idempotent).
* ``DELETE /fcm/token`` — Token entfernen (Logout, App-Daten löschen).

Der Versand braucht zusätzlich ``FIREBASE_SERVICE_ACCOUNT_KEY`` — ohne ihn
bleibt die Anmeldung trotzdem bestehen, es geht nur nichts raus (graceful
degradation, s. ``fcm.ensure_fcm``).
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import FcmToken
from dcc_chat_gateway.ratelimit import check as ratelimit_check
from dcc_chat_gateway.security import CurrentUser

router = APIRouter(prefix="/fcm", tags=["fcm"])


class FcmTokenIn(BaseModel):
    token: str = Field(min_length=1, max_length=4096)
    #: Gerätelokale, persistierte Kennung des Klienten — der Upsert-Schlüssel
    #: je Gerät (Neuanmeldung upsertet die Zeile des Geräts, s. Modelldoku).
    geraet_id: str = Field(min_length=1, max_length=128)


class FcmTokenEntfernen(BaseModel):
    token: str = Field(min_length=1, max_length=4096)


@router.post("/token", status_code=status.HTTP_204_NO_CONTENT)
async def token_speichern(
    payload: FcmTokenIn,
    session: SessionDep,
    current: CurrentUser,
) -> Response:
    """Token dieses Geräts speichern oder auffrischen.

    Ein FCM-Token gehört physisch zu genau einem Konto: Zeilen ANDERER Konten
    mit demselben Token werden zuerst entfernt (Spiegel von
    ``notifications.subscribe`` — das Gerät kennt ab sofort nur noch diesen
    Account). Das Drosselband bremst durchgedrehte Clients, nicht den
    normalen Ablauf: der App-Start upsertet einmal, nicht im Takt.
    """
    if not ratelimit_check("fcm_token", current.id):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="rate_limited")
    await session.execute(
        delete(FcmToken).where(
            FcmToken.token == payload.token, FcmToken.user_id != current.id
        )
    )
    existing = (
        await session.execute(
            select(FcmToken).where(
                FcmToken.user_id == current.id,
                FcmToken.geraet_id == payload.geraet_id,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        existing.token = payload.token
    else:
        session.add(
            FcmToken(
                user_id=current.id,
                geraet_id=payload.geraet_id,
                token=payload.token,
            )
        )
    try:
        await session.commit()
    except IntegrityError:
        # Doppelte Erst-Anmeldung desselben Geräts (zwei Start-Aufrufe im
        # Rennen) — die Zeile existiert bereits, 204 statt 500.
        await session.rollback()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/token", status_code=status.HTTP_204_NO_CONTENT)
async def token_entfernen(
    payload: FcmTokenEntfernen,
    session: SessionDep,
    current: CurrentUser,
) -> Response:
    """Token abmelden (Sign-Out). Still 204 auf einem unbekannten Token —
    die Route ist idempotent und verrät nicht, was fremde Geräte tun."""
    await session.execute(
        delete(FcmToken).where(
            FcmToken.user_id == current.id, FcmToken.token == payload.token
        )
    )
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


__all__ = ["router"]
