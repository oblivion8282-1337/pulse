"""Die eigene Geraeteliste — ansehen und ausduennen (Spec §3b, Punkt 4).

``GET /keys/geraete`` beantwortet die eine Frage, fuer die es diese Liste
gibt: **wer liest bei mir mit?** ``DELETE /keys/geraete`` beantwortet die
zweite: **und wie werde ich das los?** Beides gehoert zusammen — eine Liste
ohne Knopf waere eine Beobachtung ohne Handgriff, und ein Knopf ohne Liste
setzte voraus, dass man die Kennung des fremden Geraets schon kennt.

**Beide Routen kommen ohne ``pruefe_geraet`` aus, und das ist Absicht.** Sie
handeln nicht FUER ein Geraet, sondern ueber die Geraete eines Kontos; wer
fragt, sagt die Anmeldung (``CurrentUser``), und jede Abfrage ist auf
``user_id == user.id`` beschraenkt — dasselbe Muster wie bei
``GET /keys/onetime/count`` und ``GET /keys/geraetestand``. Beim Entfernen
waere ein Nachweis fuer das ZIEL sogar widersinnig: das Ziel ist gerade das
Geraet, das man nicht mehr hat (Begruendung ausfuehrlich in
``geraete_widerruf.py::geraet_entfernen``).

**Entfernte Geraete stehen nicht in der Liste.** Sie ist keine Chronik,
sondern eine Bestandsaufnahme; ein Grabstein daneben machte die eine Frage
oben schwerer zu beantworten. Verfallene Geraete stehen dagegen drin, mit
Marke — sie kommen ueber eine neue Kopplung zurueck, ohne dass eine neue
Zeile entstuende, und gehoeren deshalb noch zum Bestand.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Response, status
from sqlalchemy import select

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.geraete_widerruf import geraet_entfernen, nicht_entfernt
from dcc_chat_gateway.models import DeviceKeyBundle
from dcc_chat_gateway.schemas import EigenesGeraetOut, GeraeteKennung
from dcc_chat_gateway.schluessel_verfall import ist_verfallen, verfall_grenze
from dcc_chat_gateway.security import CurrentUser

router = APIRouter(tags=["keys"])


@router.get("/keys/geraete", response_model=list[EigenesGeraetOut])
async def geraete_auflisten(
    session: SessionDep,
    user: CurrentUser,
) -> list[EigenesGeraetOut]:
    """Alle Geraete des angemeldeten Kontos, zuletzt benutztes zuerst.

    **Welche Zeile „ich selbst" ist, sagt der Server nicht** — er weiss es
    nicht: die Geraetekennung im Rumpf ist selbstbehauptet, und sie hier
    abzufragen hiesse zugleich, ``zuletzt_benutzt`` aufzufrischen (dieselbe
    Falle, die ``GET /keys/geraetestand`` bereits umgeht). Der Klient
    vergleicht die Kennungen selbst; seine eigene kennt er ohnehin
    (``web/src/lib/krypto/geraeteKennung.ts``).

    Ohne Obergrenze, weil es eine gibt: ``schluessel_max_buendel_je_konto``
    (Vorgabe 20) deckelt die Zeilen je Konto bereits beim Anlegen
    (``schluessel_grenzen.py``).
    """
    zeilen = (
        await session.execute(
            select(
                DeviceKeyBundle.device_pubkey,
                DeviceKeyBundle.dauerhaft,
                DeviceKeyBundle.gekoppelt_am,
                DeviceKeyBundle.created_at,
                DeviceKeyBundle.zuletzt_benutzt,
                # Die Verfallsregel als SQL-Ausdruck statt in Python nachgebaut
                # — dieselbe Entscheidung wie in ``geraetestand`` und aus
                # demselben Grund: zwei Fassungen derselben Regel koennen
                # auseinanderlaufen, und hier haengt die Anzeige daran, die
                # jemanden zum Entfernen bewegt.
                ist_verfallen(verfall_grenze()).label("verfallen"),
            )
            .where(DeviceKeyBundle.user_id == user.id, nicht_entfernt())
            .order_by(DeviceKeyBundle.zuletzt_benutzt.desc(), DeviceKeyBundle.id.desc())
        )
    ).all()

    return [
        EigenesGeraetOut(
            device_pubkey=z.device_pubkey,
            dauerhaft=z.dauerhaft,
            gekoppelt_am=z.gekoppelt_am,
            hinzugefuegt_am=z.created_at,
            zuletzt_benutzt=z.zuletzt_benutzt,
            verfallen=bool(z.verfallen),
        )
        for z in zeilen
    ]


@router.delete("/keys/geraete", status_code=status.HTTP_204_NO_CONTENT)
async def geraet_ausschliessen(
    session: SessionDep,
    user: CurrentUser,
    # ``Annotated`` statt eines Vorgabewerts: so bleiben die Laengengrenzen
    # aus ``GeraeteKennung`` die einzige Quelle (kein zweites Paar Zahlen im
    # ``Query``), und der Aufruf steht nicht im Argument-Vorgabewert (B008).
    device_pubkey: Annotated[GeraeteKennung, Query()],
) -> Response:
    """Wirft ein Geraet aus dem eigenen Konto. Ab sofort kein Empfaenger mehr.

    **Auch das eigene, gerade benutzte Geraet — ohne Sonderfall.** Dafuer gibt
    es zwei Gruende, und der zweite ist der staerkere:

    1. Der wichtige Fall ist „ich sitze am Ersatzgeraet und werfe das
       verlorene Telefon raus". Verboete man dabei das letzte Geraet, stuende
       genau derjenige ohne Handgriff da, fuer den die Funktion gebaut ist —
       denn wenn nur noch das verlorene Geraet gefuehrt wird, IST es das
       letzte.
    2. Ein Verbot waere gar nicht durchsetzbar. Der Server weiss nicht, wer
       ruft, sondern nur, welches Konto (``schluessel_nachweis.py``); ein
       Aufrufer, der sein eigenes Geraet nicht entfernen darf, gaebe schlicht
       eine andere Kennung an. Ein Riegel, der sich mit einem anderen Wort im
       selben Rumpf umgehen laesst, ist keiner — und er als solcher
       hingeschrieben waere eine Behauptung ohne Deckung.

    Was daran wirklich gefaehrlich ist — das entfernte Geraet loescht seinen
    lokalen Verlauf, und ohne Geraet nimmt das Konto keine verschluesselten
    Nachrichten mehr an —, gehoert deshalb in die Rueckfrage der Oberflaeche
    (``web/src/lib/components/settings/GeraeteListe*.svelte``), nicht in eine
    Serverregel, die nichts haelt.

    404, wenn das Konto kein solches Geraet fuehrt — die einzige
    Eigentumspruefung, und sie sagt einem fremden Konto nichts darueber, ob es
    die Kennung anderswo gibt.

    **Was hier NICHT geschieht, und das gehoert benannt:** es wird nichts
    gestossen. Das entfernte Geraet erfaehrt es erst, wenn es das naechste Mal
    ``GET /keys/geraetestand`` fragt — beim Start (``krypto/
    verfallPruefen.ts``). Bis dahin laeuft es weiter und zeigt seinen lokalen
    Verlauf; empfangen kann es ab diesem Augenblick nichts mehr, denn die
    Sperre sitzt am Server. Ein Push ueber den Websocket waere die naheliegende
    Ergaenzung, ist aber kein Ersatz: er erreicht ein ausgeschaltetes Geraet
    ohnehin nicht, und die Abfrage beim Start muesste trotzdem bleiben.
    """
    if not await geraet_entfernen(session, user.id, device_pubkey):
        raise HTTPException(status_code=404, detail="geraet_unbekannt")
    return Response(status_code=status.HTTP_204_NO_CONTENT)
