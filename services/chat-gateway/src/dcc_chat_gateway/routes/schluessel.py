"""Das Geraete-Schluesselverzeichnis — Veroeffentlichen, Vorrat und Abholen.

``PUT /keys/bundle`` legt das Buendel eines Geraets an oder ERSETZT es (eine
Zeile je ``(user_id, device_pubkey)``, s. Migration 0065). ``POST
/keys/onetime`` haengt Einmalschluessel an, begrenzt durch
``ONE_TIME_KEY_CAP`` je Geraet. ``GET /keys/onetime/count`` liest den Vorrat,
damit der Klient rechtzeitig nachfuellt. ``POST /keys/claim`` holt die
Buendel aller Geraete einer Liste von Nutzern ab, je Buendel genau einen
Einmalschluessel (verbraucht) — oder den Rueckfallschluessel, wenn der Vorrat
leer ist.

Veroeffentlichen braucht in jedem Fall den Nachweis aus
``schluessel_nachweis.py``. Abholen braucht ihn NICHT — wer abholt, weist
sich ueber die normale Anmeldung aus (``CurrentUser``); nachgewiesen wird nur,
wessen Schluessel man veroeffentlicht, nie, wer sie liest.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from sqlalchemy import delete, func, select

import dcc_chat_gateway.config as chat_config
from dcc_chat_gateway.credential_validator import REDIS_REVOKED_SET
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.friend_helpers import block_exists_either_way, friendship_exists
from dcc_chat_gateway.models import DeviceKeyBundle, DeviceOneTimeKey
from dcc_chat_gateway.schemas import (
    BundleVeroeffentlichenRequest,
    EinmalschluesselHinzufuegenRequest,
    EinmalschluesselVorratOut,
    GeraeteSchluesselOut,
    SchluesselAbholenRequest,
)
from dcc_chat_gateway.schluessel_grenzen import (
    einmalschluessel_budget_uebrig,
    platz_fuer_neues_geraet_schaffen,
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
        vorhanden.dauerhaft = body.dauerhaft
        vorhanden.cert_id = claims.cert_id
        vorhanden.updated_at = func.now()
    else:
        await platz_fuer_neues_geraet_schaffen(session, user.id)
        session.add(
            DeviceKeyBundle(
                id=next_id(),
                user_id=user.id,
                device_pubkey=claims.device_pubkey,
                curve25519=body.curve25519,
                signatur=body.signatur,
                rueckfallschluessel=body.rueckfallschluessel,
                dauerhaft=body.dauerhaft,
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


# ---------------------------------------------------------------------------
# Abholen — POST /keys/claim
# ---------------------------------------------------------------------------

#: Fuenf Fehlschlaege in Folge heissen: der Vorrat wird gerade leergeraeumt.
#: Dann ist "keiner mehr da" die richtige Antwort, nicht ein sechster Versuch.
_ABHOL_VERSUCHE = 5


async def _einmalschluessel_holen(session, bundle_id: int) -> str | None:
    """Nimmt genau einen Einmalschluessel aus dem Vorrat — oder keinen.

    Die Schleife ist kein Schoenheitsfehler: zwischen Auswaehlen und Loeschen
    kann eine andere gleichzeitige Abholung denselben Schluessel greifen. Wer
    dann nicht erneut auswaehlt, gibt zwei Absendern dasselbe Geheimnis. Kein
    ``SELECT ... FOR UPDATE`` — SQLite (Tests) kennt es nicht, und ein Schutz,
    der nur in Produktion greift, ist keiner. Das DELETE mit Bedingung auf die
    ID ist der Schiedsrichter: von zwei gleichzeitigen Versuchen auf dieselbe
    Zeile bekommt genau einer ``rowcount == 1``, der andere 0 und probiert die
    naechste Zeile.
    """
    for _ in range(_ABHOL_VERSUCHE):
        zeile = (
            await session.execute(
                select(DeviceOneTimeKey)
                .where(DeviceOneTimeKey.bundle_id == bundle_id)
                .order_by(DeviceOneTimeKey.id)
                .limit(1)
            )
        ).scalar_one_or_none()
        if zeile is None:
            return None
        ergebnis = await session.execute(
            delete(DeviceOneTimeKey).where(DeviceOneTimeKey.id == zeile.id)
        )
        await session.commit()
        if ergebnis.rowcount == 1:
            return zeile.schluessel
        # Ein anderer Versuch war schneller — die Zeile ist bereits weg,
        # noch einmal auswaehlen statt aufzugeben.
    return None


async def _darf_schluessel_holen(session, anfragender_id: int, ziel_id: int) -> bool:
    """Dieselbe Zugriffsregel wie beim DM-Anlegen
    (``routes/dms.py::create_or_get_dm_channel``): geblockt oder nicht
    befreundet -> keine Schluessel. Wer Schluessel fuer jemanden abholen
    kann, mit dem er gar nicht schreiben darf, koennte eine Sitzung
    aufbauen, die nie eine Nachricht tragen wird — reine Vorratsverschwendung
    und eine Moeglichkeit, den Vorrat eines Fremden leerzuziehen.

    Das eigene Konto ist immer erlaubt (weder befreundet noch geblockt
    ergibt fuer sich selbst einen Sinn) — ein Geraet holt so die Buendel der
    EIGENEN anderen Geraete, um auch fuer sie zu verschluesseln
    (Multi-Geraet-Sync)."""
    if anfragender_id == ziel_id:
        return True
    if await block_exists_either_way(session, anfragender_id, ziel_id):
        return False
    return await friendship_exists(session, anfragender_id, ziel_id)


@router.post("/keys/claim", response_model=dict[str, list[GeraeteSchluesselOut]])
async def schluessel_abholen(
    body: SchluesselAbholenRequest,
    request: Request,
    session: SessionDep,
    user: CurrentUser,
) -> dict[str, list[GeraeteSchluesselOut]]:
    """Holt die Buendel aller Geraete jedes angefragten Nutzers ab.

    Ein Nutzer ohne veroeffentlichte Geraete liefert eine leere Liste — das
    ist der Normalfall der Koexistenz-Regel (die App ist nicht installiert),
    kein Fehler. Dasselbe gilt fuer ein Ziel, mit dem man nicht schreiben
    darf: keine 403 fuer die ganze Anfrage, sondern eine leere Liste fuer
    GENAU dieses Ziel — sonst risse ein einzelner unzulaessiger Eintrag in
    einer Mehrfachanfrage die anderen, zulaessigen mit herunter, und die Liste
    ist ohnehin die richtige Antwortform fuer "hier gibt es nichts zu holen".
    """
    redis = _require_redis(request)
    settings = chat_config.get_settings()
    ergebnis: dict[str, list[GeraeteSchluesselOut]] = {}

    for ziel_id in dict.fromkeys(body.user_ids):  # Duplikate raus, Reihenfolge bleibt.
        schluessel_key = str(ziel_id)
        ergebnis[schluessel_key] = []
        if not await _darf_schluessel_holen(session, user.id, ziel_id):
            continue

        buendel = (
            await session.execute(
                select(DeviceKeyBundle)
                .where(DeviceKeyBundle.user_id == ziel_id)
                # Defensive Obergrenze, deckungsgleich mit FIX 1
                # (``schluessel_max_buendel_je_konto``) — das Konto kann so
                # viele Zeilen gar nicht mehr anhaeufen, dieses ``limit``
                # bewacht nur den Fall alter Bestandsdaten von vor FIX 1.
                .limit(settings.schluessel_max_buendel_je_konto)
            )
        ).scalars().all()

        for b in buendel:
            # Sperrlisten-Filter: die gespeicherte cert_id ist die des
            # Zertifikats, mit dem zuletzt veroeffentlicht wurde. Nach einer
            # Zertifikatserneuerung (alle 30 Tage) widerruft ein Sperren das
            # NEUE Zertifikat, waehrend im Buendel noch das alte steht — der
            # Filter griffe dann nicht. Weil das Geraet bei jeder Anmeldung
            # neu veroeffentlicht, ist das Fenster in der Praxis klein, aber
            # NICHT null. Der vollstaendige Weg waere ein Signal vom
            # auth-svc ("dieses Geraet ist weg"), das das Buendel loescht;
            # das gibt es heute nicht (eigene Aufgabe).
            if await redis.sismember(REDIS_REVOKED_SET, b.cert_id):
                continue

            # Budget-Wache (FIX 2) — nur fuer FREMDE Ziele: das eigene Konto
            # zieht ausschliesslich am eigenen Vorrat, das ist kein Angriff
            # auf jemand anderen (s. ``_darf_schluessel_holen``-Docstring).
            # Ist das Budget erschoepft, wird wie bei leerem Vorrat verfahren
            # (``einmal = None`` -> Rueckfallschluessel) statt gar nichts zu
            # liefern — ein Sitzungsaufbau soll trotzdem moeglich bleiben,
            # nur ohne den knappen Einmalschluessel des Ziels weiter zu
            # kosten.
            if user.id != ziel_id and not await einmalschluessel_budget_uebrig(
                redis, user.id, ziel_id
            ):
                einmal = None
            else:
                einmal = await _einmalschluessel_holen(session, b.id)
            ergebnis[schluessel_key].append(
                GeraeteSchluesselOut(
                    device_pubkey=b.device_pubkey,
                    curve25519=b.curve25519,
                    signatur=b.signatur,
                    einmalschluessel=einmal,
                    rueckfallschluessel=b.rueckfallschluessel if einmal is None else None,
                    dauerhaft=b.dauerhaft,
                )
            )

    return ergebnis
