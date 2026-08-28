"""Das Postfach — Einliefern verschluesselter Umschlaege (Etappe D, E2E-DM).

``POST /postfach`` nimmt einen oder mehrere verschluesselte Umschlaege
entgegen und faechert sie an die angegebenen Empfaengergeraete auf: eine
Zeile je Geraet in ``DmZustellung``, die auf eine ``DmNutzlast`` zeigt.
Abholen und Quittieren (Task 3) sowie der Verfallslauf (Task 4) folgen in
eigenen Aenderungen — hier nur das Einliefern.

Alle Pruefungen sind fail-closed, in dieser Reihenfolge (billig vor teuer,
Bughunt 2026-08-28 (Missbrauch), FIX 4 — vorher liefen Kryptoverifikation UND
Kanalzugang vor den reinen Strukturchecks):

1. Obergrenzen auf dem rohen Rumpf (Groesse je Umschlag, Anzahl Nutzlasten
   je Anfrage) — kein DB-Zugriff, keine Kryptografie.
2. Geraete-Nachweis (``schluessel_nachweis.py``, eigener Zweck ``"postfach"``
   — eine fuer ein Schluesselbuendel geleistete Unterschrift darf hier nicht
   gelten).
3. Kanalzugang — DIESELBE Regel wie im Klartext-Sendeweg
   (``ws_op_send.py:139-151``): DM-Kanal laden, Mitgliedschaft pruefen,
   ``block_exists_either_way`` + ``friendship_exists``. Postfach traegt
   heute nur DMs (Gruppen sind Etappe G) — eine Gilden-Kanal-ID wird deshalb
   ebenfalls abgewiesen.
4. Offene Zustellungen je Empfaengergeraet — insgesamt UND je Absender
   (FIX 3, s. ``postfach_max_offene_zustellungen_je_absender_und_geraet``
   in ``config.py``).

Der Server kann keinen Umschlag oeffnen — deshalb wird ``daten`` nirgends
geloggt, auch nicht in Fehlermeldungen.
"""

from __future__ import annotations

import base64
import logging
from collections.abc import Collection
from datetime import UTC, datetime, timedelta

from dcc_shared.events import PostfachNeuEvent
from fastapi import APIRouter, HTTPException, Request
from sqlalchemy import exists, func, select

import dcc_chat_gateway.config as chat_config
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.friend_helpers import block_exists_either_way, friendship_exists
from dcc_chat_gateway.models import DeviceKeyBundle, DirectMessageChannel, DmNutzlast, DmZustellung
from dcc_chat_gateway.push import fan_out_dm_push_encrypted
from dcc_chat_gateway.routes._deps import resolve_channel_for_user
from dcc_chat_gateway.schemas import PostfachEinliefernRequest, PostfachEinliefernResponse
from dcc_chat_gateway.schluessel_nachweis import baue_nutzlast, pruefe_geraet
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id

log = logging.getLogger(__name__)

router = APIRouter(tags=["postfach"])


def _require_redis(request: Request):
    redis = getattr(request.app.state, "redis", None)
    if redis is None:
        raise HTTPException(status_code=503, detail="postfach_dienst_nicht_verfuegbar")
    return redis


async def _channel_zugriff_pruefen(
    session, channel_id: int, user_id: int
) -> DirectMessageChannel:
    """Dieselbe Regel wie ``ws_op_send.py:139-151``: DM-Kanal laden, fehlt er
    oder ist der Nutzer nicht Mitglied -> abweisen. Ein Durchfallen wuerde das
    Freundschafts-/Block-Gate ueberspringen und eine verwaiste Zustellung
    schreiben. Eine Gilden-Kanal-ID faellt hier ebenfalls durch — Postfach
    traegt heute nur DMs."""
    resolved = await resolve_channel_for_user(session, channel_id, user_id)
    if resolved is None or resolved[0] != "dm":
        raise HTTPException(status_code=403, detail="channel_not_accessible")
    dm_obj = resolved[1]
    other = dm_obj.user_b_id if dm_obj.user_a_id == user_id else dm_obj.user_a_id
    if await block_exists_either_way(session, user_id, other):
        raise HTTPException(status_code=403, detail="blocked")
    if not await friendship_exists(session, user_id, other):
        raise HTTPException(status_code=403, detail="not_friends")
    return dm_obj


async def _bundle_laden(
    session, device_pubkey: str, erlaubte_user_ids: Collection[int]
) -> DeviceKeyBundle | None:
    """Der Verzeichnis-Eintrag eines Geraets, oder ``None`` — ein Geraet ohne
    veroeffentlichtes Buendel ist Alltag (noch nicht veroeffentlicht, gerade
    abgemeldet), kein Fehler; wie damit umzugehen ist, entscheidet die
    jeweilige Aufrufstelle.

    **Skopiert auf ``erlaubte_user_ids``** — die DB-Eindeutigkeit ist das
    Paar ``(user_id, device_pubkey)`` (``UniqueConstraint`` in
    ``models/geraete_schluessel.py``), NICHT der Pubkey allein. Eine unscopte
    Suche wirft ``MultipleResultsFound``, sobald zwei Konten denselben Pubkey
    fuehren — erreichbar z. B. ueber ein geloeschtes und neu registriertes
    Konto, das denselben lokal gespeicherten Geraeteschluessel weiterbenutzt
    (Bughunt 2026-08-28, FIX 2) — und reisst damit die GANZE Anfrage mit,
    auch die Zustellung an jeden anderen, unbeteiligten Empfaenger."""
    return (
        await session.execute(
            select(DeviceKeyBundle).where(
                DeviceKeyBundle.device_pubkey == device_pubkey,
                DeviceKeyBundle.user_id.in_(erlaubte_user_ids),
            )
        )
    ).scalar_one_or_none()


def _envelope_groesse(daten_b64: str) -> int:
    """Bytes VOR der Base64-Kodierung — nie den Inhalt in der Fehlermeldung,
    nur, DASS er ungueltig war.

    **Padding nachtragen, sonst scheitert JEDER echte Umschlag.** Der
    Krypto-Kern kodiert mit vodozemacs ``base64_encode``
    (`STANDARD`-Alphabet, `NO_PAD` — `krypto/pulse-krypto/src/
    utilities/mod.rs`), liefert also nie ein Vielfaches von 4 Zeichen mit
    Fuellzeichen. Pythons ``b64decode`` verlangt Padding IMMER, auch mit
    ``validate=False`` (das Flag steuert nur, ob Zeichen ausserhalb des
    Alphabets stillschweigend uebersprungen werden) — ohne den Zusatz warf
    diese Funktion bei jeder echten Nutzlast, weil ``daten`` fast nie zufaellig
    auf ein Vielfaches von 4 laenge trifft. Ueberschuessiges Padding ignoriert
    Python anstandslos, deshalb reicht ein fester Anhang von zwei
    Gleichheitszeichen (dasselbe Muster wie ``schluessel_nachweis.py::_b64``
    fuer base64url-Werte aus demselben Krypto-Kern).
    """
    try:
        return len(base64.b64decode(daten_b64 + "==", validate=False))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="ungueltige_nutzlast") from exc


@router.post("/postfach", response_model=PostfachEinliefernResponse)
async def postfach_einliefern(
    body: PostfachEinliefernRequest,
    request: Request,
    session: SessionDep,
    user: CurrentUser,
) -> PostfachEinliefernResponse:
    # Modul-Zugriff statt ``from … import get_settings`` (s. owner_check.py):
    # der Name waere sonst zur Importzeit gebunden und saehe eine spaetere
    # Test-Ueberschreibung von ``get_settings`` (s. ``_isolate_chat_settings``
    # in conftest.py) nicht.
    settings = chat_config.get_settings()
    redis = _require_redis(request)
    cid_int = int(body.channel_id)

    # 1. Obergrenzen ZUERST (Bughunt 2026-08-28 (Missbrauch), FIX 4) —
    # reiner Strukturcheck auf dem Rumpf, keine DB, keine Kryptografie.
    # Vorher liefen Geraete-Nachweis (Ed25519-Verifikation) UND Kanalzugang
    # schon, bevor ueberhaupt geprueft wurde, ob die Anfrage die eigenen
    # Grenzen einhaelt — nginx deckelt den Body zwar bei 16 MB, aber bis zu
    # dieser Deckelung war die teure Verifikation ueber die GESAMTE
    # angehaengte Nutzlast schon gelaufen, fuer eine Anfrage, die ohnehin
    # abgelehnt wird.
    if len(body.nutzlasten) > settings.postfach_max_nutzlasten_je_anfrage:
        raise HTTPException(status_code=400, detail="zu_viele_nutzlasten")
    groessen = [_envelope_groesse(n.daten) for n in body.nutzlasten]
    for groesse in groessen:
        if groesse > settings.postfach_max_umschlag_bytes:
            raise HTTPException(status_code=400, detail="umschlag_zu_gross")

    # 2. Geraete-Nachweis. Signatur bindet Kanal + alle Umschlaege — sonst
    # koennte eine fuer einen anderen Kanal/Inhalt geleistete Unterschrift
    # hier wiederverwendet werden.
    nutzlast_bytes = baue_nutzlast(
        "postfach", str(cid_int), *[n.daten for n in body.nutzlasten]
    )
    claims = await pruefe_geraet(body.cert, nutzlast_bytes, body.signatur, user, redis)

    # 3. Kanalzugang. Der Kanal liefert zugleich die Menge der Konten, an die
    # ueberhaupt zugestellt werden darf (s. Pruefung weiter unten).
    dm_obj = await _channel_zugriff_pruefen(session, cid_int, user.id)
    teilnehmer = {dm_obj.user_a_id, dm_obj.user_b_id}

    # 4. Anlegen. Zuerst das EIGENE Buendel des einliefernden Geraets — es
    # liefert den Curve25519-Identitaetsschluessel, den ein Empfaenger fuer
    # einen frischen Sitzungsaufbau braucht (Olm-Standardverhalten, s.
    # Migration 0069). ``claims.device_pubkey`` ist bereits durch den
    # Geraete-Nachweis geprueft, kein neuer Vertrauensschritt. Fehlt das
    # Buendel, bleibt die Spalte NULL — der Server erzwingt sie nicht, er
    # oeffnet den Umschlag ja nie.
    absender_bundle = await _bundle_laden(session, claims.device_pubkey, {user.id})
    absender_curve25519 = absender_bundle.curve25519 if absender_bundle else None

    # ``offene_je_geraet`` ist ein In-Request-Cache: eine
    # Anfrage mit mehreren Umschlaegen an dasselbe volle Geraet soll dieses
    # Geraet nicht mehrfach abfragen, und der lokale Zaehler wird bei jeder
    # neu angelegten Zustellung mitgefuehrt (sonst zaehlte er innerhalb der
    # Anfrage nicht mit, weil ungesetzte Inserts vor dem Commit nicht in
    # einem erneuten COUNT auftauchen).
    verfaellt_am = datetime.now(UTC) + timedelta(days=settings.postfach_frist_tage)
    offene_je_geraet: dict[str, int] = {}
    # Wie ``offene_je_geraet``, aber je (Absender-Geraet, Empfaengergeraet) —
    # FIX 3: die GESAMT-Obergrenze allein zaehlt ueber alle Absender hinweg,
    # ein einzelner angenommener Kontakt kann sie also allein fuellen und
    # damit jeden ANDEREN Absender an dieses Geraet aussperren. Absender ist
    # innerhalb dieser Anfrage konstant (``claims.device_pubkey``, ein
    # Geraete-Nachweis pro Aufruf), der Cache-Schluessel ist deshalb einfach
    # der Empfaenger-Pubkey.
    offene_je_sender_und_geraet: dict[str, int] = {}
    gesamt_zustellungen = 0
    verworfene_nutzlasten = 0
    # Fremde Konten mit mindestens einer Zustellung -> Grundlage fuer den
    # Push in Schritt 6 (dedupliziert: mehrere Nutzlasten an denselben
    # Empfaenger loesen nur EINEN Push aus).
    push_empfaenger: set[int] = set()
    # Ueber die ganze Anfrage dedupliziert, Reihenfolge egal — ``dict`` statt
    # ``set`` nur, damit die Reihenfolge fuer die Antwort stabil bleibt.
    uebersprungene_empfaenger: dict[str, None] = {}

    for eintrag, groesse in zip(body.nutzlasten, groessen, strict=True):
        empfaenger_zeilen: list[tuple[str, int]] = []
        for pubkey in dict.fromkeys(eintrag.empfaenger):  # Duplikate raus.
            # **Das Geraet muss zu DIESEM Gespraech gehoeren** — die Suche
            # ist deshalb direkt auf ``teilnehmer`` skopiert (FIX 2), nicht
            # erst ungescopt geladen und danach geprueft: eine ungescopte
            # Suche wirft ``MultipleResultsFound``, sobald zwei Konten
            # denselben Pubkey fuehren (s. ``_bundle_laden``-Docstring), und
            # reisst damit die GANZE Anfrage mit, auch die Zustellung an
            # jeden anderen, unbeteiligten Empfaenger.
            #
            # Die Kanalpruefung oben belegt nur, dass der Absender in DIESEM
            # Kanal schreiben darf — nicht, an WEN zugestellt wird. Die
            # Empfaengerkennungen kommen aus dem Anfrage-Rumpf; ohne die
            # Skopierung koennte jeder mit einer einzigen legitimen DM
            # Umschlaege in das Postfach JEDES Geraets JEDES Nutzers legen,
            # auch von Leuten, die ihn geblockt haben, und dabei deren
            # Kontingent vollschreiben.
            bundle = await _bundle_laden(session, pubkey, teilnehmer)
            if bundle is None:
                # Kein Buendel innerhalb DIESES Gespraechs — zwei Faelle,
                # die unterschiedlich beantwortet werden. Ein Pubkey, der
                # NIRGENDS existiert, ist Alltag (Geraet zwischen
                # Schluessel-Abholen und Absenden abgemeldet): still
                # uebersprungen, kein Fehler fuer die uebrigen Empfaenger,
                # nur ehrlich in der Antwort vermerkt. Ein Pubkey, der
                # existiert, aber zu KEINEM Teilnehmer dieses Kanals gehoert,
                # ist kein Alltagsfall, sondern ein Klientenfehler oder ein
                # Angriff — fail-closed und laut. Ein reiner
                # Existenz-Check statt eines zweiten ``_bundle_laden``-Aufrufs,
                # weil er selbst bei einer Pubkey-Kollision unter mehreren
                # fremden Konten nie mehr als einen booleschen Wert liefert.
                fremdes_geraet_vorhanden = (
                    await session.execute(
                        select(exists().where(DeviceKeyBundle.device_pubkey == pubkey))
                    )
                ).scalar_one()
                if fremdes_geraet_vorhanden:
                    raise HTTPException(status_code=403, detail="empfaenger_nicht_im_kanal")
                uebersprungene_empfaenger[pubkey] = None
                continue
            if pubkey not in offene_je_geraet:
                offene_je_geraet[pubkey] = (
                    await session.execute(
                        select(func.count())
                        .select_from(DmZustellung)
                        .where(DmZustellung.empfaenger_device_pubkey == pubkey)
                    )
                ).scalar_one()
            if pubkey not in offene_je_sender_und_geraet:
                offene_je_sender_und_geraet[pubkey] = (
                    await session.execute(
                        select(func.count())
                        .select_from(DmZustellung)
                        .join(DmNutzlast, DmNutzlast.id == DmZustellung.nutzlast_id)
                        .where(
                            DmZustellung.empfaenger_device_pubkey == pubkey,
                            DmNutzlast.absender_device_pubkey == claims.device_pubkey,
                        )
                    )
                ).scalar_one()
            if (
                offene_je_geraet[pubkey] >= settings.postfach_max_offene_zustellungen_je_geraet
                or offene_je_sender_und_geraet[pubkey]
                >= settings.postfach_max_offene_zustellungen_je_absender_und_geraet
            ):
                # Geraet ist voll (insgesamt ODER fuer diesen Absender allein,
                # FIX 3) — wie ein unbekanntes Geraet uebersprungen, nicht die
                # ganze Anfrage abgewiesen.
                #
                # **Beide Grenzen sind naeherungsweise, nicht scharf**, und
                # das gehoert gesagt: die Zaehler werden VOR dem Einfuegen
                # gelesen, gleichzeitige Anfragen sehen also denselben alten
                # Stand und koennen ihn zusammen ueberschreiten. Ein scharfer
                # Wert brauchte eine Zaehlerzeile mit bewachtem UPDATE.
                #
                # Vertretbar ist die Naeherung erst, seit oben geprueft wird,
                # dass ein Empfaengergeraet zu DIESEM Gespraech gehoert: das
                # Kontingent eines Fremden ist damit unerreichbar, und wer es
                # ueberschreiten kann, ist jemand, mit dem man befreundet ist
                # und schreibt — dessen Ueberschuss zudem nach
                # ``postfach_frist_tage`` von selbst verfaellt.
                uebersprungene_empfaenger[pubkey] = None
                continue
            empfaenger_zeilen.append((pubkey, bundle.user_id))
            offene_je_geraet[pubkey] += 1
            offene_je_sender_und_geraet[pubkey] += 1

        if not empfaenger_zeilen:
            # Keine Zustellung moeglich -> keine Nutzlast anlegen (sonst
            # eine Zeile, die niemand je abholen kann) — und dem Absender
            # gemeldet (FIX 1), statt es in einem unbedingten Erfolg
            # verschwinden zu lassen.
            verworfene_nutzlasten += 1
            continue

        nutzlast_id = next_id()
        session.add(
            DmNutzlast(
                id=nutzlast_id,
                channel_id=cid_int,
                absender_device_pubkey=claims.device_pubkey,
                absender_curve25519=absender_curve25519,
                art=eintrag.art,
                daten=eintrag.daten,
                groesse=groesse,
            )
        )
        for pubkey, empf_user_id in empfaenger_zeilen:
            session.add(
                DmZustellung(
                    id=next_id(),
                    nutzlast_id=nutzlast_id,
                    empfaenger_device_pubkey=pubkey,
                    empfaenger_user_id=empf_user_id,
                    verfaellt_am=verfaellt_am,
                )
            )
            # Nur FREMDE Konten pushen — ``teilnehmer`` deckt beide Seiten
            # ab, ein Empfaengergeraet kann also auch ein WEITERES Geraet
            # des Absenders selbst sein (Multi-Device). Wie der Klartext-Weg
            # (``messages.py``/``ws_op_send.py``): nur der jeweils andere.
            if empf_user_id != user.id:
                push_empfaenger.add(empf_user_id)
        gesamt_zustellungen += len(empfaenger_zeilen)

    await session.commit()

    # 5. Weckruf — inhaltslos, traegt Kanal und Anzahl, NIE einen Umschlag
    # (sonst laege der Inhalt wieder in Redis). Best-effort, wie die
    # entsprechenden Publishes in ws_op_send.py: die Zustellungen sind
    # bereits persistiert, ein Redis-Hiccup darf die Antwort nicht kippen.
    if gesamt_zustellungen > 0:
        manager = getattr(request.app.state, "connection_manager", None)
        if manager is not None:
            try:
                await manager.publish(
                    str(cid_int),
                    PostfachNeuEvent(channel_id=str(cid_int), anzahl=gesamt_zustellungen),
                )
            except Exception:
                log.exception("postfach wake publish failed for channel %s", cid_int)

    # 6. Geschlossene-Browser-Benachrichtigung — der WS-Weckruf oben erreicht
    # nur offene Tabs. Der Server kennt den Inhalt nie; der Push traegt
    # deshalb weder Nachrichteninhalt noch Dateiname, nur Absender und Kanal
    # (dieselbe Grenze wie beim Klartext-Push). Best-effort — kein ``try``
    # noetig, ``_fan_out_payload`` faengt selbst jede Ausnahme ab.
    if push_empfaenger:
        await fan_out_dm_push_encrypted(
            recipient_ids=push_empfaenger,
            author_name=user.username,
            channel_id=cid_int,
        )

    return PostfachEinliefernResponse(
        zustellungen_angelegt=gesamt_zustellungen,
        uebersprungene_empfaenger=list(uebersprungene_empfaenger),
        verworfene_nutzlasten=verworfene_nutzlasten,
    )
