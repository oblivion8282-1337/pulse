"""Verlaufsumzug — Stuecke schieben, holen, abschliessen (Etappe F).

===========================================================================
WARUM NICHT DAS POSTFACH — die Transportfrage, nachgesehen statt geschaetzt
===========================================================================

Das Postfach (Etappe D) traegt verschluesselte Umschlaege an Geraete und
raeumt sie wieder weg. Es liegt nahe, den Umzug darueber zu fahren. **Es
traegt ihn nicht**, aus drei Gruenden, die alle in vorhandenem Code stehen:

1. **Es gibt keinen Kanal.** ``routes/postfach.py`` verlangt eine
   ``channel_id`` und prueft sie mit derselben Regel wie der Klartext-Weg:
   DM-Kanal laden, Mitgliedschaft, Block, Freundschaft
   (``_postfach_deps.py::_channel_zugriff_pruefen``). Zwischen zwei Geraeten
   DESSELBEN Kontos gibt es keinen DM-Kanal — ``DirectMessageChannel`` ist
   per Constraint auf zwei VERSCHIEDENE Personen verdrahtet
   (``models/channels.py``). Der Umzug haette keine gueltige ``channel_id``,
   die er angeben koennte.

2. **Die Menge passt nicht.** ``postfach_max_offene_zustellungen_je_absender_und_geraet``
   steht auf 50, ``postfach_max_umschlag_bytes`` auf 256 KiB — zusammen
   12,8 MB gleichzeitig unterwegs, danach werden weitere Einlieferungen
   dieses Absenders **stillschweigend uebersprungen** (nicht abgewiesen, s.
   dortiger Kommentar). Ein Umzug ueber diese Grenze faende also nicht
   statt und meldete trotzdem Erfolg. Die Grenze hochzudrehen ginge nicht:
   sie ist ausdruecklich ein Missbrauchs-Riegel (Bughunt 2026-08-28, FIX 3).

3. **Der Zustand ist der falsche.** Ein Postfach-Umschlag ist Olm-
   verschluesselt, jeder Umschlag ratchet die Sitzung weiter. Ein
   abgebrochener und wiederholter Umzug wuerde die Sitzung des Geraetepaars
   mit Zehntausenden Schritten belasten, und jeder verlorene Umschlag
   waere endgueltig. **Fortsetzbarkeit und Double Ratchet vertragen sich
   nicht** — ein Stueck, das man beliebig oft neu ziehen kann, ist genau
   das, was ein Ratchet ausschliesst.

Deshalb eine eigene, schmale Ablage (``models/kopplung.py``): fortlaufend
nummerierte Stuecke unter AES-GCM mit einem Schluessel, den der Server nicht
kennt. Jedes Stueck ist unabhaengig entschluesselbar, also beliebig oft
wiederholbar — genau die Eigenschaft, an der der Postfach-Weg scheitert.

===========================================================================
ANHANG-BYTES ZIEHEN NICHT MIT — Entscheidung und ihr Preis
===========================================================================

Der lokale Verlauf enthaelt seit Etappe E entschluesselte Anhang-Bytes
(``web/src/lib/verlauf/schema.ts``, Speicher ``anhaenge``). Sie wandern
**nicht** mit, und das ist entschieden, nicht vergessen:

* Es sind Blobs in Bild- und Videogroesse. Diese Tabelle ist eine
  Text-Spalte in Postgres; der Blob-Speicher des Projekts ist MinIO.
* Der Weg zu MinIO ist da, aber sein Zugriffsrecht nicht: ``darf_anhang_abrufen``
  (``postfach_anhaenge.py``) haengt an einer OFFENEN ZUSTELLUNG des
  abrufenden Geraets. Beim Umzug gibt es keine — der Empfaenger war nie
  Adressat dieser Nachrichten. Ein Anhang-Umzug braucht also einen zweiten,
  eigenen Berechtigungsweg; das ist eine eigene Etappe, keine Zeile hier.

**Was der Nutzer davon merkt, und wie ehrlich es steht:** die Nachricht
kommt mit, samt Angaben zum Anhang (Name, Groesse, Masse) — die stehen im
Satz, nicht in den Bytes. Die Kachel bleibt also an ihrem Platz, das Bild
laesst sich nur nicht oeffnen. Die Oberflaeche sagt das an ZWEI Stellen, aber
beide NACH dem Uebernehmen, nicht davor: einmal im Abschlussbericht
(``kopplung_uebernommen`` nennt die Zahl der uebernommenen Nachrichten) und
gleich daneben der feste Hinweis, dass Bilder und Dateien auf dem alten
Geraet bleiben (``kopplung_anhaenge_hinweis``, `KopplungEinloesen.svelte`).
Eine Vorschau VOR dem Uebernehmen gibt es nicht — der Empfaenger kennt die
Gesamtzahl erst, wenn das alte Geraet ``POST /kopplung/fertig`` gerufen hat,
und selbst dann ist es nur die Stueckzahl, nicht die Nachrichtenzahl (die
steckt erst in den verschluesselten Stuecken). Nicht angezeigt wird ein
Ladefehler — der waere die Unwahrheit, es ist kein Fehler.
"""

from __future__ import annotations

import base64

from fastapi import APIRouter, HTTPException, Request, Response, status
from sqlalchemy import delete, select

import dcc_chat_gateway.config as chat_config
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.kopplung_schemas import (
    KopplungAbschliessenRequest,
    KopplungFertigRequest,
    UmzugStueckHolenRequest,
    UmzugStueckRequest,
    UmzugStueckResponse,
)
from dcc_chat_gateway.kopplung_zugriff import kopplung_laden
from dcc_chat_gateway.models import Kopplung, UmzugStueck
from dcc_chat_gateway.routes._postfach_deps import _require_redis
from dcc_chat_gateway.schluessel_nachweis import baue_nutzlast, pruefe_geraet
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id

router = APIRouter(tags=["kopplung"])


def _stueck_groesse(daten_b64: str) -> int:
    """Bytes VOR der Base64-Kodierung — wie ``_envelope_groesse`` im Postfach.

    Der Klient kodiert ohne Fuellzeichen (vodozemacs ``STANDARD_NO_PAD``,
    s. CLAUDE.md), Python verlangt sie: ``"=="`` anhaengen ist bei
    ueberzaehliger Polsterung gefahrlos.
    """
    try:
        return len(base64.b64decode(daten_b64 + "=="))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="stueck_kein_base64") from exc


@router.post("/kopplung/stueck", status_code=status.HTTP_204_NO_CONTENT)
async def kopplung_stueck_ablegen(
    body: UmzugStueckRequest,
    request: Request,
    session: SessionDep,
    user: CurrentUser,
) -> Response:
    """Legt ein Stueck ab — vom ALTEN Geraet, beliebig oft wiederholbar.

    **Wiederholbarkeit ist hier die Funktion, nicht Nachsicht:** ein
    abgerissener Umzug setzt fort, indem er die fehlenden Positionen erneut
    schiebt. Trifft er dabei eine, die doch schon liegt (die Antwort auf den
    ersten Versuch ging verloren), ersetzt er sie — statt eine Dublette
    anzulegen oder mit 409 abzubrechen, was den Sender zwaenge, den
    Unterschied zwischen „schon da" und „kaputt" selbst zu erraten.
    """
    settings = chat_config.get_settings()
    redis = _require_redis(request)
    kid = int(body.kopplung_id)

    # Struktur- und Mengenpruefung VOR der Kryptografie — dieselbe
    # Reihenfolge und derselbe Grund wie in ``routes/postfach.py``
    # (Bughunt 2026-08-28, FIX 4): der teure Teil ist die Ed25519-Prufung
    # ueber die gesamte angehaengte Nutzlast.
    if body.folge >= settings.umzug_max_stuecke:
        raise HTTPException(status_code=400, detail="folge_ausserhalb")
    groesse = _stueck_groesse(body.daten)
    if groesse > settings.umzug_max_stueck_bytes:
        raise HTTPException(status_code=400, detail="stueck_zu_gross")

    nutzlast = baue_nutzlast("kopplung-stueck", str(kid), str(body.folge), body.daten)
    claims = await pruefe_geraet(body.cert, nutzlast, body.signatur, user, redis)
    await kopplung_laden(session, kid, user.id, claims.device_pubkey, "alt")

    vorhanden = (
        await session.execute(
            select(UmzugStueck).where(
                UmzugStueck.kopplung_id == kid, UmzugStueck.folge == body.folge
            )
        )
    ).scalar_one_or_none()
    if vorhanden is None:
        session.add(
            UmzugStueck(
                id=next_id(),
                kopplung_id=kid,
                folge=body.folge,
                daten=body.daten,
                groesse=groesse,
                kennung=body.kennung,
            )
        )
    else:
        vorhanden.daten = body.daten
        vorhanden.groesse = groesse
        vorhanden.kennung = body.kennung

    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/kopplung/stueck/holen", response_model=UmzugStueckResponse)
async def kopplung_stueck_holen(
    body: UmzugStueckHolenRequest,
    request: Request,
    session: SessionDep,
    user: CurrentUser,
) -> UmzugStueckResponse:
    """Holt ein Stueck — vom NEUEN Geraet.

    **Holen loescht nicht**, aus demselben Grund wie beim Postfach-Abholen:
    eine verlorene Antwort waere sonst ein verlorenes Stueck. Geloescht wird
    erst beim Abschliessen oder mit der Frist.
    """
    redis = _require_redis(request)
    kid = int(body.kopplung_id)
    nutzlast = baue_nutzlast("kopplung-stueck-holen", str(kid), str(body.folge))
    claims = await pruefe_geraet(body.cert, nutzlast, body.signatur, user, redis)
    await kopplung_laden(session, kid, user.id, claims.device_pubkey, "neu")

    stueck = (
        await session.execute(
            select(UmzugStueck).where(
                UmzugStueck.kopplung_id == kid, UmzugStueck.folge == body.folge
            )
        )
    ).scalar_one_or_none()
    if stueck is None:
        raise HTTPException(status_code=404, detail="stueck_fehlt")

    return UmzugStueckResponse(folge=stueck.folge, daten=stueck.daten)


@router.post("/kopplung/fertig", status_code=status.HTTP_204_NO_CONTENT)
async def kopplung_fertig(
    body: KopplungFertigRequest,
    request: Request,
    session: SessionDep,
    user: CurrentUser,
) -> Response:
    """Meldet die Gesamtzahl der Stuecke — vom ALTEN Geraet.

    Erst diese Zahl macht „vollstaendig" pruefbar. Ohne sie sieht ein Umzug,
    der beim 40. von 100 Stuecken abriss, fuer den Empfaenger genauso aus wie
    einer, der bei 40 fertig war.
    """
    settings = chat_config.get_settings()
    redis = _require_redis(request)
    kid = int(body.kopplung_id)

    if body.gesamt_stuecke > settings.umzug_max_stuecke:
        raise HTTPException(status_code=400, detail="zu_viele_stuecke")

    nutzlast = baue_nutzlast("kopplung-fertig", str(kid), str(body.gesamt_stuecke))
    claims = await pruefe_geraet(body.cert, nutzlast, body.signatur, user, redis)
    kopplung = await kopplung_laden(session, kid, user.id, claims.device_pubkey, "alt")

    kopplung.gesamt_stuecke = body.gesamt_stuecke
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/kopplung/abschliessen", status_code=status.HTTP_204_NO_CONTENT)
async def kopplung_abschliessen(
    body: KopplungAbschliessenRequest,
    request: Request,
    session: SessionDep,
    user: CurrentUser,
) -> Response:
    """Loescht Kopplung und Stuecke — von BEIDEN Geraeten aufrufbar.

    Auch das alte Geraet darf abbrechen: ein versehentlich gezeigter Code
    muss sich zuruecknehmen lassen, ohne die Frist abzuwarten. Eine bereits
    geloeschte Kopplung ergibt 204, nicht 404 — Abschliessen ist die einzige
    Handlung hier, deren Wiederholung nichts kosten darf (der Empfaenger
    ruft sie, nachdem er alles eingespielt hat, und eine verlorene Antwort
    duerfte ihn nicht in einen Fehlerzustand schieben).
    """
    redis = _require_redis(request)
    kid = int(body.kopplung_id)
    nutzlast = baue_nutzlast("kopplung-abschliessen", str(kid))
    claims = await pruefe_geraet(body.cert, nutzlast, body.signatur, user, redis)

    # Die Rolle steckt hier in der WHERE-Klausel statt in ``kopplung_laden``:
    # beide Rollen duerfen, eine dritte nicht — und ein bereits verfallener
    # Eintrag soll sich trotzdem wegraeumen lassen, weshalb die Frist hier
    # bewusst NICHT geprueft wird.
    treffer = (
        await session.execute(
            delete(Kopplung)
            .where(
                Kopplung.id == kid,
                Kopplung.user_id == user.id,
                (Kopplung.alt_device_pubkey == claims.device_pubkey)
                | (Kopplung.neu_device_pubkey == claims.device_pubkey),
            )
            .returning(Kopplung.id)
        )
    ).scalars().all()

    # **Die Stuecke werden AUSDRUECKLICH geloescht, nicht ueber den
    # Fremdschluessel.** Der ``ondelete="CASCADE"`` steht weiterhin am Modell
    # und greift auf Postgres — aber SQLite erzwingt Fremdschluessel nur mit
    # ``PRAGMA foreign_keys=ON``, und der Testaufbau setzt es nicht. Ein
    # Aufraeumen, das allein am CASCADE haengt, waere im Test also
    # unbeobachtbar: er saehe die Stuecke liegen bleiben und koennte nicht
    # unterscheiden, ob das an SQLite liegt oder am Code. Genau so ist es
    # aufgefallen (zwei rote Tests beim ersten Lauf).
    if treffer:
        await session.execute(delete(UmzugStueck).where(UmzugStueck.kopplung_id == kid))

    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
