"""Das Geraete-Schluesselverzeichnis — Veroeffentlichen und Vorrat.

``PUT /keys/bundle`` legt das Buendel eines Geraets an oder ERSETZT es (eine
Zeile je ``(user_id, device_pubkey)``, s. Migration 0065). ``POST
/keys/onetime`` haengt Einmalschluessel an, begrenzt durch
``ONE_TIME_KEY_CAP`` je Geraet. ``GET /keys/onetime/count`` liest den Vorrat,
damit der Klient rechtzeitig nachfuellt.

Veroeffentlichen braucht in jedem Fall den Nachweis aus
``schluessel_nachweis.py`` — das Abholen (Task 3, ``POST /keys/claim``)
kommt in dieser Datei noch nicht vor.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from sqlalchemy import func, select

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import DeviceKeyBundle, DeviceOneTimeKey
from dcc_chat_gateway.schemas import (
    BundleVeroeffentlichenRequest,
    EinmalschluesselHinzufuegenRequest,
    EinmalschluesselVorratOut,
)
from dcc_chat_gateway.schluessel_nachweis import baue_nutzlast, pruefe_geraet
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id

router = APIRouter(tags=["keys"])

#: Obergrenze der gleichzeitig gespeicherten Einmalschluessel je Geraet.
#: Ohne sie koennte ein einzelnes Geraet die Tabelle beliebig vollschreiben —
#: jeder Schluessel ist nur wenige Bytes, aber ein unbegrenzter Vorrat waere
#: ein Speicher-DoS ohne jeden Nutzen (ein realer Klient braucht nie mehr als
#: ein paar hundert auf einmal).
ONE_TIME_KEY_CAP = 100


def _require_redis(request: Request):
    redis = getattr(request.app.state, "redis", None)
    if redis is None:
        raise HTTPException(status_code=503, detail="schluessel_dienst_nicht_verfuegbar")
    return redis


@router.put("/keys/bundle", status_code=status.HTTP_204_NO_CONTENT)
async def bundle_veroeffentlichen(
    body: BundleVeroeffentlichenRequest,
    request: Request,
    session: SessionDep,
    user: CurrentUser,
) -> Response:
    """Legt das Buendel des anfragenden Geraets an oder ersetzt es.

    ``device_pubkey`` und ``cert_id`` der gespeicherten Zeile kommen
    AUSSCHLIESSLICH aus den geprueften Zertifikats-Claims, nie aus dem
    Anfrage-Rumpf — der Rumpf traegt nur den Verschluesselungs-Anteil
    (``curve25519`` + optionaler Rueckfallschluessel), den das Geraet mit
    seinem Anmeldeschluessel unterschrieben hat.
    """
    redis = _require_redis(request)
    nutzlast = baue_nutzlast(
        "buendel", body.curve25519, body.rueckfallschluessel or ""
    )
    claims = await pruefe_geraet(body.cert, nutzlast, body.signatur, user, redis)

    vorhanden = (
        await session.execute(
            select(DeviceKeyBundle).where(
                DeviceKeyBundle.user_id == user.id,
                DeviceKeyBundle.device_pubkey == claims.device_pubkey,
            )
        )
    ).scalar_one_or_none()

    if vorhanden is not None:
        vorhanden.curve25519 = body.curve25519
        vorhanden.signatur = body.signatur
        vorhanden.rueckfallschluessel = body.rueckfallschluessel
        vorhanden.rueckfall_signatur = body.rueckfall_signatur
        vorhanden.cert_id = claims.cert_id
        vorhanden.updated_at = func.now()
    else:
        session.add(
            DeviceKeyBundle(
                id=next_id(),
                user_id=user.id,
                device_pubkey=claims.device_pubkey,
                curve25519=body.curve25519,
                signatur=body.signatur,
                rueckfallschluessel=body.rueckfallschluessel,
                rueckfall_signatur=body.rueckfall_signatur,
                cert_id=claims.cert_id,
            )
        )
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/keys/onetime", status_code=status.HTTP_204_NO_CONTENT)
async def einmalschluessel_hinzufuegen(
    body: EinmalschluesselHinzufuegenRequest,
    request: Request,
    session: SessionDep,
    user: CurrentUser,
) -> Response:
    """Haengt einen Batch Einmalschluessel an das Buendel des Geraets an."""
    redis = _require_redis(request)
    nutzlast = baue_nutzlast("einmalschluessel", *body.schluessel)
    claims = await pruefe_geraet(body.cert, nutzlast, body.signatur, user, redis)

    bundle = (
        await session.execute(
            select(DeviceKeyBundle).where(
                DeviceKeyBundle.user_id == user.id,
                DeviceKeyBundle.device_pubkey == claims.device_pubkey,
            )
        )
    ).scalar_one_or_none()
    if bundle is None:
        raise HTTPException(
            status_code=404, detail="Kein Buendel fuer dieses Geraet veroeffentlicht"
        )

    vorhandene = (
        await session.execute(
            select(func.count())
            .select_from(DeviceOneTimeKey)
            .where(DeviceOneTimeKey.bundle_id == bundle.id)
        )
    ).scalar_one()
    if vorhandene + len(body.schluessel) > ONE_TIME_KEY_CAP:
        raise HTTPException(status_code=400, detail="Vorrat-Obergrenze erreicht")

    for schluessel in body.schluessel:
        session.add(
            DeviceOneTimeKey(id=next_id(), bundle_id=bundle.id, schluessel=schluessel)
        )
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/keys/onetime/count", response_model=EinmalschluesselVorratOut)
async def einmalschluessel_vorrat(
    session: SessionDep,
    user: CurrentUser,
    device_pubkey: str = Query(...),
) -> EinmalschluesselVorratOut:
    """Liest den Vorrat des anfragenden Kontos fuer EIN Geraet.

    Reiner Lesezugriff auf eine Zahl, kein Schluesselmaterial — deshalb ohne
    den vollen Zertifikats-Nachweis; die Zeilenwahl bleibt trotzdem auf das
    angemeldete Konto beschraenkt (``user_id == user.id``), ein fremdes Konto
    kann den Vorrat eines anderen Geraets nicht ablesen.
    """
    bundle = (
        await session.execute(
            select(DeviceKeyBundle).where(
                DeviceKeyBundle.user_id == user.id,
                DeviceKeyBundle.device_pubkey == device_pubkey,
            )
        )
    ).scalar_one_or_none()
    if bundle is None:
        raise HTTPException(
            status_code=404, detail="Kein Buendel fuer dieses Geraet veroeffentlicht"
        )

    vorrat = (
        await session.execute(
            select(func.count())
            .select_from(DeviceOneTimeKey)
            .where(DeviceOneTimeKey.bundle_id == bundle.id)
        )
    ).scalar_one()
    return EinmalschluesselVorratOut(vorrat=vorrat)
