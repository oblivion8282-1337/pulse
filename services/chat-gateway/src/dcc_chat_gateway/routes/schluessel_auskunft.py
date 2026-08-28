"""Verbrauchsfreie Auskunft: kann ein Gespraech mit diesem Konto
verschluesselt laufen?

**Warum eine eigene Route und nicht ``POST /keys/claim``.** Bis heute war
``claim`` die einzige Moeglichkeit, das herauszufinden — und ``claim``
VERBRAUCHT einen Einmalschluessel je Geraet des Ziels
(``schluessel.py::_einmalschluessel_holen`` loescht die Zeile). Ein Schloss
im Kopf des Gespraechs fragt aber beim Betreten JEDES Gespraechs, ohne dass
je eine Nachricht folgen muss: der Vorrat der Gegenseite waere durch blosses
Herumklicken leerzuziehen, und danach liefe ihr Sitzungsaufbau nur noch ueber
den Rueckfallschluessel. Diese Route liest deshalb ausschliesslich —
kein ``DELETE``, kein ``INSERT``, kein ``commit``.

**Was die Antwort verraet, und warum das vertretbar ist.** Sie sagt einem
Gegenueber, ob jemand die App (Electron oder Android) installiert hat. Das
ist ein Stueck Metadaten ueber eine Person, kein Schluesselmaterial. Getragen
wird die Abwaegung allein davon, dass GENAU DERSELBE Kreis — die Regel unten
ist dieselbe ``darf_schluessel_holen``-Pruefung wie beim Abholen — dieselbe
Auskunft ohnehin ueber ``claim`` bekommen kann, nur teurer fuer das Ziel. Die
Route macht also nichts sichtbar, was vorher verborgen war; sie macht das
Sichtbare bloss billig. Wer die Zugriffsregel hier lockert, verschiebt genau
diese Abwaegung und muss sie neu treffen.

**Kein eigener Nachweis-Zweck** (``schluessel_nachweis.py``): der ist dort
noetig, wo jemand behauptet, ein bestimmtes GERAET zu sein — beim
Veroeffentlichen also. Hier wird nichts veroeffentlicht und nichts
herausgegeben, was an ein Geraet gebunden waere; es zaehlt nur, WER fragt,
und dafuer ist die normale Anmeldung (``CurrentUser``) der Ausweis. Dasselbe
gilt fuer ``POST /keys/claim`` und ``GET /keys/onetime/count``, die beide
ebenfalls ohne Zertifikats-Nachweis auskommen (s. Modulkopf von
``schluessel.py``).
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from sqlalchemy import select

import dcc_chat_gateway.config as chat_config
from dcc_chat_gateway.credential_validator import REDIS_REVOKED_SET
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import DeviceKeyBundle
from dcc_chat_gateway.schemas import SnowflakeId, VerschluesselbarOut
from dcc_chat_gateway.schluessel_zugriff import darf_schluessel_holen
from dcc_chat_gateway.security import CurrentUser

router = APIRouter(tags=["keys"])


@router.get("/keys/verschluesselbar/{ziel_id}", response_model=VerschluesselbarOut)
async def verschluesselbar(
    ziel_id: SnowflakeId,
    request: Request,
    session: SessionDep,
    user: CurrentUser,
) -> VerschluesselbarOut:
    """Hat das Zielkonto mindestens ein dauerhaftes Geraet mit
    veroeffentlichten Schluesseln?

    Das ist genau das Kriterium der Koexistenz-Regel (Spec §3,
    ``web/src/lib/krypto/empfaengerGeraete.ts``) fuer die GEGENSEITE — die
    eigene Haelfte kennt der Klient selbst, er ist ja das eigene Geraet.

    Fehlende Berechtigung ergibt ``false``, keine 403. Nicht aus Bequemlichkeit,
    sondern damit die Auskunft mit dem Sendeweg uebereinstimmt: wer nicht
    abholen darf, bekommt von ``POST /keys/claim`` eine leere Liste, und der
    Sendeweg faellt dann ohnehin auf Klartext zurueck. Eine 403 waere zudem
    dieselbe Auskunft in anderer Verpackung.
    """
    if not await darf_schluessel_holen(session, user.id, ziel_id):
        return VerschluesselbarOut(verschluesselbar=False)

    redis = getattr(request.app.state, "redis", None)
    if redis is None:
        raise HTTPException(status_code=503, detail="schluessel_dienst_nicht_verfuegbar")

    settings = chat_config.get_settings()
    # Nur die dauerhaften Buendel interessieren — ein Browser-Tab zaehlt fuer
    # die Koexistenz-Regel nicht (Haltbarkeit, nicht Krypto-Faehigkeit).
    # ``limit`` deckungsgleich mit dem Abholweg, aus demselben Grund
    # (Bestandsdaten von vor der Buendel-Obergrenze).
    cert_ids = (
        await session.execute(
            select(DeviceKeyBundle.cert_id)
            .where(
                DeviceKeyBundle.user_id == ziel_id,
                DeviceKeyBundle.dauerhaft.is_(True),
            )
            .limit(settings.schluessel_max_buendel_je_konto)
        )
    ).scalars().all()

    for cert_id in cert_ids:
        # Derselbe Sperrlisten-Filter wie beim Abholen: ein widerrufenes Geraet
        # wuerde dort uebersprungen, also darf es hier kein Schloss begruenden.
        # Ohne diese Zeile behauptete das Kennzeichen "verschluesselt", waehrend
        # der Sendeweg auf Klartext zurueckfaellt — dieselbe Einschraenkung
        # (die gespeicherte ``cert_id`` kann nach einer Erneuerung veraltet
        # sein) gilt hier wie dort, s. ``schluessel.py::schluessel_abholen``.
        if not await redis.sismember(REDIS_REVOKED_SET, cert_id):
            return VerschluesselbarOut(verschluesselbar=True)

    return VerschluesselbarOut(verschluesselbar=False)
