"""FCM-Token-Verwaltung (Übergabe P0.1) — Anmelden und Abmelden.

Die Android-App holt beim Start ein FCM-Registrierungstoken (via
``@capacitor-firebase/messaging``) und meldet es hier an; beim Sign-Out
trägt sie es wieder ab. Der Push-Versand selbst lebt in
:mod:`dcc_chat_gateway.fcm`.

Endpunkte
---------
* ``POST   /fcm/token`` — Token speichern/aktualisieren (idempotent).
* ``DELETE /fcm/token`` — Token entfernen (Logout, App-Daten löschen).
* ``POST   /fcm/badge`` — Ungelesen-Stand des wachen Klienten melden.

Der Versand braucht zusätzlich ``FIREBASE_SERVICE_ACCOUNT_KEY`` — ohne ihn
bleibt die Anmeldung trotzdem bestehen, es geht nur nichts raus (graceful
degradation, s. ``fcm.ensure_fcm``).
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError

from dcc_chat_gateway import badgezaehler
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


class BadgeStand(BaseModel):
    #: Ungelesene Nachrichten über alle Gespräche. ``ge=0``: negative Werte
    #: sind keine Anzahl und sollen hart abgewiesen werden, nicht stillschweigend
    #: auf 0 gezogen — ein Klient, der das sendet, hat einen Fehler.
    anzahl: int = Field(ge=0, le=badgezaehler.OBERGRENZE)


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
        # Rennen (zwei Start-Aufrufe desselben Geräts): der andere Aufruf hat
        # die Zeile (user_id, geraet_id) gewonnen. Rollback, dann den
        # Überlebenden explizit auf DEN hier angekommenden Token ziehen —
        # sonst würde ein verlorener Rennlauf still 204 liefern, ohne dass
        # der frische Token je ankommt (Befund 03.10.).
        await session.rollback()
        uebrig = (
            await session.execute(
                select(FcmToken).where(
                    FcmToken.user_id == current.id,
                    FcmToken.geraet_id == payload.geraet_id,
                )
            )
        ).scalar_one_or_none()
        if uebrig is None:
            # Kein Rennen um die Zeile — ein anderer Grund (z. B. Token-Unique
            # gegen ein parallel wanderndes Gerät). Ehrlich scheitern statt
            # Erfolg behaupten; der App-Start wiederholt den Aufruf.
            raise HTTPException(
                status.HTTP_409_CONFLICT, detail="fcm_token_belegt"
            ) from None
        uebrig.token = payload.token
        try:
            await session.commit()
        except IntegrityError:
            await session.rollback()
            raise HTTPException(
                status.HTTP_409_CONFLICT, detail="fcm_token_belegt"
            ) from None
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


@router.post("/badge", status_code=status.HTTP_204_NO_CONTENT)
async def badge_melden(
    payload: BadgeStand,
    request: Request,
    current: CurrentUser,
) -> Response:
    """Den exakten Ungelesen-Stand dieses Kontos übernehmen.

    **Warum der Klient das meldet und nicht der Server rechnet:** Für
    verschlüsselte DMs — den Normalweg — kann der Server die Zahl nicht
    kennen (``badgezaehler``-Modulkopf nennt die beiden Gründe). Der Klient
    hat den Klartext; solange die App wach ist, ist er die Wahrheit und
    überschreibt damit die Fortschreibung, die der Push-Weg betreibt.

    Jedes Gerät desselben Kontos darf melden — der Stand gehört dem Konto.
    Dass zwei Geräte verschiedene Zahlen melden könnten, ist kein Fehlerfall,
    sondern der Normalfall eines ungleichen Lesestands; es gewinnt die
    jüngste Meldung, und das ist richtig: sie kommt vom Gerät, an dem gerade
    jemand sitzt.
    """
    if not ratelimit_check("fcm_badge", current.id):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="rate_limited")
    await badgezaehler.setzen(request.app.state.redis, current.id, payload.anzahl)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


__all__ = ["router"]
