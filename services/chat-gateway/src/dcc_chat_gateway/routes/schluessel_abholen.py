"""``POST /keys/claim`` — die Buendel fremder (und eigener) Geraete abholen.

Herausgeloest aus ``routes/schluessel.py``, als die Datei mit der Begruendung
der Erstveroeffentlichung (Spec §3b) ueber die Groessen-Policy (``PLAN.md``
§12.1) gewachsen waere. Der Umzug aendert kein Verhalten — der Schnitt liegt
an der Naht, die die Datei ohnehin schon zog: **Veroeffentlichen** (wer bin
ich, und was lege ich ab) auf der einen Seite, **Abholen** (was liegt bei
anderen) auf der anderen.

Abholen verlangt KEINE Geraeteangabe: wer abholt, weist sich ueber die
normale Anmeldung aus (``CurrentUser``); gebunden wird nur, wessen Schluessel
man veroeffentlicht, nie, wer sie liest.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from sqlalchemy import delete, select

import dcc_chat_gateway.config as chat_config
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import DeviceKeyBundle, DeviceOneTimeKey
from dcc_chat_gateway.schemas import GeraeteSchluesselOut, SchluesselAbholenRequest
from dcc_chat_gateway.schluessel_grenzen import einmalschluessel_budget_uebrig
from dcc_chat_gateway.schluessel_verfall import ist_lebendig, verfall_grenze
from dcc_chat_gateway.schluessel_zugriff import darf_schluessel_holen
from dcc_chat_gateway.security import CurrentUser

router = APIRouter(tags=["keys"])


def _require_redis(request: Request):
    redis = getattr(request.app.state, "redis", None)
    if redis is None:
        raise HTTPException(status_code=503, detail="schluessel_dienst_nicht_verfuegbar")
    return redis


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
        if not await darf_schluessel_holen(session, user.id, ziel_id):
            continue

        buendel = (
            await session.execute(
                select(DeviceKeyBundle)
                .where(
                    DeviceKeyBundle.user_id == ziel_id,
                    # Ein verfallenes Geraet ist kein Empfaenger mehr (Spec
                    # §3a, ``schluessel_verfall.py``). Der Filter steht in der
                    # Abfrage und nicht erst in der Schleife: was hier
                    # herauskommt, wird eine Zeile spaeter mit einem
                    # verbrauchten Einmalschluessel bezahlt.
                    ist_lebendig(verfall_grenze()),
                )
                # Defensive Obergrenze, deckungsgleich mit FIX 1
                # (``schluessel_max_buendel_je_konto``) — das Konto kann so
                # viele Zeilen gar nicht mehr anhaeufen, dieses ``limit``
                # bewacht nur den Fall alter Bestandsdaten von vor FIX 1.
                .limit(settings.schluessel_max_buendel_je_konto)
            )
        ).scalars().all()

        for b in buendel:
            # **Hier stand bis zum 2026-08-30 ein Sperrlisten-Filter** ueber
            # die mitgeschriebene ``cert_id``. Mit den Zertifikaten ist er
            # ersatzlos entfallen (Spec §3b, Punkt 4): es gibt keine
            # Sperrliste mehr, die ein einzelnes Geraet fuehren koennte.
            # Der Widerruf wird stattdessen sichtbar statt kryptographisch —
            # eine Geraeteliste mit „entfernen", die die Buendelzeile
            # loescht, womit dieses Geraet hier gar nicht mehr auftaucht.
            # **Solange die Liste nicht gebaut ist, gibt es keinen Widerruf**;
            # das ist der offene Rest der Umstellung, nicht ein Zustand, den
            # dieser Kommentar gutheisst.
            #
            # Budget-Wache (FIX 2) — nur fuer FREMDE Ziele: das eigene Konto
            # zieht ausschliesslich am eigenen Vorrat, das ist kein Angriff
            # auf jemand anderen (s. ``darf_schluessel_holen``-Docstring,
            # ``schluessel_zugriff.py``).
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
                    einmalschluessel=einmal,
                    rueckfallschluessel=b.rueckfallschluessel if einmal is None else None,
                    dauerhaft=b.dauerhaft,
                    gekoppelt=b.gekoppelt_am is not None,
                )
            )

    return ergebnis
