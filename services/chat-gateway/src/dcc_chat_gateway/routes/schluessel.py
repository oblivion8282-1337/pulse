"""Das Geraete-Schluesselverzeichnis — Veroeffentlichen und Vorrat.

``PUT /keys/bundle`` legt das Buendel eines Geraets an oder ERSETZT es (eine
Zeile je ``(user_id, device_pubkey)``, s. Migration 0065). ``POST
/keys/onetime`` haengt Einmalschluessel an, begrenzt durch
``ONE_TIME_KEY_CAP`` je Geraet. ``GET /keys/onetime/count`` liest den Vorrat,
damit der Klient rechtzeitig nachfuellt.

Jede dieser Routen sagt, WELCHES Geraet handelt, und das Geraet muss zum
angemeldeten Konto gehoeren (``schluessel_nachweis.py``). Die Gegenseite —
``POST /keys/claim`` — liegt in ``schluessel_abholen.py``; Begruendung des
Schnitts dort.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Response, status
from sqlalchemy import func, select

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import DeviceKeyBundle, DeviceOneTimeKey
from dcc_chat_gateway.schemas import (
    BundleVeroeffentlichenRequest,
    EinmalschluesselHinzufuegenRequest,
    EinmalschluesselVorratOut,
)
from dcc_chat_gateway.schluessel_grenzen import platz_fuer_neues_geraet_schaffen
from dcc_chat_gateway.schluessel_nachweis import (
    geraet_gehoert_fremdem_konto,
    pruefe_geraet,
)
from dcc_chat_gateway.schluessel_verfall import kopplungszeitpunkt
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id

router = APIRouter(tags=["keys"])

#: Obergrenze der gleichzeitig gespeicherten Einmalschluessel je Geraet.
#: Ohne sie koennte ein einzelnes Geraet die Tabelle beliebig vollschreiben —
#: jeder Schluessel ist nur wenige Bytes, aber ein unbegrenzter Vorrat waere
#: ein Speicher-DoS ohne jeden Nutzen (ein realer Klient braucht nie mehr als
#: ein paar hundert auf einmal).
ONE_TIME_KEY_CAP = 100


@router.put("/keys/bundle", status_code=status.HTTP_204_NO_CONTENT)
async def bundle_veroeffentlichen(
    body: BundleVeroeffentlichenRequest,
    session: SessionDep,
    user: CurrentUser,
) -> Response:
    """Legt das Buendel des anfragenden Geraets an oder ersetzt es.

    **Die eine Route, die ein noch unbekanntes Geraet zulassen MUSS** (Spec
    §3b): beim allerersten Veroeffentlichen gibt es die Zeile nicht, gegen
    die ``pruefe_geraet`` sonst nachschlaegt — sie entsteht ja genau hier.
    Die Kennung ist damit selbstbehauptet, und das traegt, weil sie
    ausschliesslich in die EIGENE Geraeteliste schreibt (``user_id ==
    user.id`` in jeder Abfrage und in der neuen Zeile).

    Selbstbehauptet heisst aber nicht beliebig: eine Kennung, die bereits
    einem ANDEREN Konto gehoert, wird beim Anlegen abgewiesen. Das
    Zertifikat schloss das frueher aus; ohne den Riegel koennte jemand die
    (oeffentlich abholbare) Kennung eines Gespraechspartners fuer sich
    eintragen, und ``_postfach_deps.py::_bundle_laden`` faende in genau
    diesem Gespraech zwei Zeilen zu einem Pubkey — ``MultipleResultsFound``,
    also 500 fuer jede Einlieferung in diesem Kanal, auch die des Opfers.
    **Der Preis, benannt:** zwei Konten koennen denselben Geraeteschluessel
    nicht mehr nebeneinander fuehren (der Fall aus dem Bughunt 2026-08-28,
    FIX 2: geloeschtes und neu registriertes Konto im selben Browser). Der
    zweite bekommt 409 statt einer zweiten Zeile — hinnehmbar, weil ein
    Konto-Wechsel den lokalen Geraeteschluessel ohnehin wischt
    (``auth.svelte.ts``), der Fall also einen Rest aus einem frueheren Leben
    voraussetzt.
    """
    # ``pruefe_geraet`` ZUERST, vor jedem ORM-Laden: es schreibt mit einem
    # ``UPDATE``, und SQLAlchemy gleicht dessen WHERE-Klausel nachtraeglich
    # gegen die bereits geladenen Objekte der Session ab (Synchronisierung
    # „evaluate"). Steht die Buendel-Zeile da schon als Objekt, vergleicht es
    # den naiven Zeitstempel aus SQLite mit einem zeitzonenbehafteten und
    # wirft ``TypeError`` — im Test belegt, in Postgres unauffaellig.
    await pruefe_geraet(session, user, body.device_pubkey, noch_ohne_buendel=True)

    vorhanden = (
        await session.execute(
            select(DeviceKeyBundle).where(
                DeviceKeyBundle.user_id == user.id,
                DeviceKeyBundle.device_pubkey == body.device_pubkey,
            )
        )
    ).scalar_one_or_none()
    if vorhanden is None and await geraet_gehoert_fremdem_konto(
        session, user.id, body.device_pubkey
    ):
        raise HTTPException(status_code=409, detail="geraet_gehoert_anderem_konto")

    # Die Kopplungsmarke nachziehen (Spec §3a) — der Klient loest den Code
    # EIN und veroeffentlicht erst danach, die Einloesung findet die Zeile
    # eines frischen Browsers also noch nicht vor. Nur setzen, nie loeschen:
    # die Kopplungszeile wird nach der Umzugsfrist weggeraeumt, ein spaeteres
    # Veroeffentlichen faende dann nichts mehr (s. ``kopplungszeitpunkt``).
    gekoppelt_am = await kopplungszeitpunkt(session, user.id, body.device_pubkey)

    if vorhanden is not None:
        vorhanden.curve25519 = body.curve25519
        vorhanden.rueckfallschluessel = body.rueckfallschluessel
        vorhanden.dauerhaft = body.dauerhaft
        vorhanden.updated_at = func.now()
        if gekoppelt_am is not None:
            vorhanden.gekoppelt_am = gekoppelt_am
        # ``verfallen_am`` und ``entfernt_am`` bleiben hier ABSICHTLICH
        # unangetastet. Beim Verfall: ein abgelaufener Browser veroeffentlicht
        # beim naechsten Start wie jeder andere, und wuerde das den Verfall
        # aufheben, waere er nie mitteilbar (der Klient hat dann noch nicht
        # gefragt). Beim Ausschluss (Spec §3b Punkt 4) waere es schlimmer als
        # das: ein entferntes Geraet laeuft weiter und veroeffentlicht beim
        # naechsten Start: ein Zuruecksetzen HIER machte den Widerruf zu einer
        # Pause von wenigen Minuten. Zurueck geht es fuer beide nur ueber eine
        # neue Kopplung, s. ``routes/kopplung.py::kopplung_einloesen``.
    else:
        await platz_fuer_neues_geraet_schaffen(session, user.id)
        session.add(
            DeviceKeyBundle(
                id=next_id(),
                user_id=user.id,
                device_pubkey=body.device_pubkey,
                curve25519=body.curve25519,
                rueckfallschluessel=body.rueckfallschluessel,
                dauerhaft=body.dauerhaft,
                gekoppelt_am=gekoppelt_am,
            )
        )
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/keys/onetime", status_code=status.HTTP_204_NO_CONTENT)
async def einmalschluessel_hinzufuegen(
    body: EinmalschluesselHinzufuegenRequest,
    session: SessionDep,
    user: CurrentUser,
) -> Response:
    """Haengt einen Batch Einmalschluessel an das Buendel des Geraets an."""
    geraet = await pruefe_geraet(session, user, body.device_pubkey)

    bundle = (
        await session.execute(
            select(DeviceKeyBundle).where(
                DeviceKeyBundle.user_id == user.id,
                DeviceKeyBundle.device_pubkey == geraet,
            )
        )
    ).scalar_one_or_none()
    if bundle is None:
        # Nach ``pruefe_geraet`` nur noch als Wettlauf erreichbar (die
        # Geraete-Obergrenze hat die Zeile zwischen Pruefung und Auswahl
        # verdraengt, ``schluessel_grenzen.py``) — der Normalfall „nie
        # veroeffentlicht" endet schon oben mit 403.
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
    ``pruefe_geraet``; die Zeilenwahl bleibt trotzdem auf das
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
