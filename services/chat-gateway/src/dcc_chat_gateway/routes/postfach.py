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
   je Anfrage) — kein DB-Zugriff.
2. Geraete-Zuordnung (``schluessel_nachweis.py``): das im Rumpf genannte
   Sendegeraet muss zum angemeldeten Konto gehoeren.
3. Kanalzugang (``_postfach_deps.py::_channel_zugriff_pruefen``) — bei einer
   DM DIESELBE Regel wie im Klartext-Sendeweg (``ws_op_send.py:139-151``):
   DM-Kanal laden, Mitgliedschaft pruefen, ``block_exists_either_way`` +
   ``friendship_exists``. Bei einer privaten Gruppe (Etappe G) entscheidet
   die Mitgliedschaft allein — Begruendung dort. Bei einem Ablage-Kanal
   (Guild-Kanal mit ``ablage=true``, Etappe E6) entscheidet ``VIEW_CHANNEL``
   ueber den Rechte-Resolver — Begruendung dort. Ein gewoehnlicher
   Community-Kanal wird in allen drei Faellen abgewiesen.
3b. Anhaenge (Etappe E) — jede mitgegebene Anhang-Kennung muss demselben
   Konto und demselben Kanal gehoeren und darf an keiner Nachricht haengen
   (``postfach_anhaenge.py::binde_anhaenge``).
4. Offene Zustellungen je Empfaengergeraet — insgesamt UND je Absender-KONTO
   (FIX 3, s. ``postfach_max_offene_zustellungen_je_absender_und_geraet``
   in ``config.py`` — gezaehlt ueber ``DmNutzlast.absender_user_id``, NICHT
   ueber das einzelne Sendegeraet, s. Migration 0076).

Der Server kann keinen Umschlag oeffnen — deshalb wird ``daten`` nirgends
geloggt, auch nicht in Fehlermeldungen. Zu einem verschluesselten Anhang
kennt er weder Namen noch Typ, also kann auch davon nichts in ein Log
geraten.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from sqlalchemy import exists, select

import dcc_chat_gateway.config as chat_config
from dcc_chat_gateway.ablage_kanal_ordner import ablegen as ablegen_im_ordner
from dcc_chat_gateway.ablage_kanal_ordner import festigung_nachlaufen
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import DeviceKeyBundle, DmNutzlast, DmZustellung
from dcc_chat_gateway.postfach_anhaenge import bezuege_anlegen, binde_anhaenge
from dcc_chat_gateway.postfach_benachrichtigung import wecke_und_pushe

# Die Pruef-Helfer liegen seit Etappe E in ``_postfach_deps.py`` (die Datei
# waere sonst ueber die Groessen-Policy gewachsen). Der Import haelt sie
# zugleich als Attribute DIESES Moduls verfuegbar — ``postfach_anhaenge`` und
# die Tests holen ``_channel_zugriff_pruefen``/``_envelope_groesse`` weiterhin
# von hier.
#
# **Neuer Code nimmt ``_postfach_deps`` direkt** (so ``postfach_anhaenge_
# laufwerk.py`` seit Design §11). Der Umweg ueber dieses Modul ist nur noch
# Bestandsschutz fuer die Aufrufer von damals; er kostet nichts, aber er ist
# kein Muster, dem man folgen sollte.
from dcc_chat_gateway.routes._postfach_deps import (
    _bundle_laden,
    _channel_zugriff_pruefen,
    _envelope_groesse,
    offene_zustellungen_zaehlen,
)
from dcc_chat_gateway.schemas import PostfachEinliefernRequest, PostfachEinliefernResponse
from dcc_chat_gateway.schluessel_nachweis import pruefe_geraet
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id

router = APIRouter(tags=["postfach"])


@router.post("/postfach", response_model=PostfachEinliefernResponse)
async def postfach_einliefern(
    body: PostfachEinliefernRequest,
    request: Request,
    background: BackgroundTasks,
    session: SessionDep,
    user: CurrentUser,
) -> PostfachEinliefernResponse:
    # Modul-Zugriff statt ``from … import get_settings`` (s. owner_check.py):
    # der Name waere sonst zur Importzeit gebunden und saehe eine spaetere
    # Test-Ueberschreibung von ``get_settings`` (s. ``_isolate_chat_settings``
    # in conftest.py) nicht.
    settings = chat_config.get_settings()
    cid_int = int(body.channel_id)

    # 1. Obergrenzen ZUERST (Bughunt 2026-08-28 (Missbrauch), FIX 4) —
    # reiner Strukturcheck auf dem Rumpf, keine DB. Vorher liefen
    # Geraete-Nachweis UND Kanalzugang schon, bevor ueberhaupt geprueft
    # wurde, ob die Anfrage die eigenen Grenzen einhaelt — nginx deckelt
    # den Body zwar bei 16 MB, aber bis zu dieser Deckelung waren beide
    # ueber die GESAMTE angehaengte Nutzlast schon gelaufen, fuer eine
    # Anfrage, die ohnehin abgelehnt wird. Die Reihenfolge kostet seit dem
    # Wegfall der Unterschrift weniger als frueher, bleibt aber richtig:
    # der Kanalzugang ist weiterhin mehrere Abfragen wert.
    if len(body.nutzlasten) > settings.postfach_max_nutzlasten_je_anfrage:
        raise HTTPException(status_code=400, detail="zu_viele_nutzlasten")
    groessen = [_envelope_groesse(n.daten) for n in body.nutzlasten]
    for groesse in groessen:
        if groesse > settings.postfach_max_umschlag_bytes:
            raise HTTPException(status_code=400, detail="umschlag_zu_gross")

    # 2. Geraete-Zuordnung: das genannte Sendegeraet muss zum angemeldeten
    # Konto gehoeren. **Was hier weggefallen ist** (Spec §3b): eine
    # Unterschrift ueber Kanal, Umschlaege und Anhang-Kennungen. Sie band
    # den Inhalt an genau dieses Geraet; heute buergt fuer den Inhalt das
    # Konto. Fuer den Empfaenger aendert das nichts — was er oeffnen kann,
    # entscheidet die Olm-Sitzung, nicht diese Unterschrift.
    geraet = await pruefe_geraet(session, user, body.device_pubkey)

    # 3. Kanalzugang. Der Kanal liefert zugleich die Menge der Konten, an die
    # ueberhaupt zugestellt werden darf (s. Pruefung weiter unten), UND die
    # Kanalart — die Empfaenger-Schleife braucht sie (Bughunt 2026-08-28/29).
    zugriff = await _channel_zugriff_pruefen(session, cid_int, user)
    teilnehmer = zugriff.teilnehmer

    # 3b. Anhaenge (Etappe E). VOR dem Anlegen der Umschlaege: eine fremde
    # oder kanalfremde Kennung soll die Anfrage kippen, bevor irgendeine
    # Zeile entsteht. ``binde_anhaenge`` setzt ``postfach_gebunden_am`` und
    # nimmt die Zeilen damit dem Anhang-Reaper aus der Hand.
    #
    # Entsteht unten fuer KEINE Nutzlast eine Zustellung (alle Empfaenger
    # uebersprungen), bleibt der Anhang ohne jede Bezugszeile zurueck und
    # faellt beim naechsten Pflegelauf — richtig so: kein Umschlag traegt
    # dann seinen Dateischluessel. Der Absender erfaehrt es ueber
    # ``verworfene_nutzlasten`` in der Antwort.
    anhang_ids = [int(a) for a in body.anhaenge]
    await binde_anhaenge(
        session, anhang_ids=anhang_ids, channel_id=cid_int, uploader_id=user.id
    )

    # 4. Anlegen. Zuerst das EIGENE Buendel des einliefernden Geraets — es
    # liefert den Curve25519-Identitaetsschluessel, den ein Empfaenger fuer
    # einen frischen Sitzungsaufbau braucht (Olm-Standardverhalten, s.
    # Migration 0069). ``geraet`` gehoert nach Schritt 2 nachweislich zu
    # diesem Konto, hat also ein Buendel — die Abfrage bleibt trotzdem
    # ``or_none``: die Geraete-Obergrenze koennte die Zeile dazwischen
    # verdraengt haben (``schluessel_grenzen.py``). Dann bleibt die Spalte
    # NULL, der Server erzwingt sie nicht, er oeffnet den Umschlag ja nie.
    absender_bundle = await _bundle_laden(session, geraet, {user.id})
    absender_curve25519 = absender_bundle.curve25519 if absender_bundle else None

    # ``offene_je_geraet`` ist ein In-Request-Cache: eine
    # Anfrage mit mehreren Umschlaegen an dasselbe volle Geraet soll dieses
    # Geraet nicht mehrfach abfragen, und der lokale Zaehler wird bei jeder
    # neu angelegten Zustellung mitgefuehrt (sonst zaehlte er innerhalb der
    # Anfrage nicht mit, weil ungesetzte Inserts vor dem Commit nicht in
    # einem erneuten COUNT auftauchen).
    verfaellt_am = datetime.now(UTC) + timedelta(days=settings.postfach_frist_tage)
    offene_je_geraet: dict[str, int] = {}
    # Wie ``offene_je_geraet``, aber je (Absender-KONTO, Empfaengergeraet) —
    # FIX 3, korrigiert im belegten Fehler vom 2026-08-29: die
    # GESAMT-Obergrenze allein zaehlt ueber alle Absender hinweg, ein
    # einzelner angenommener Kontakt kann sie also allein fuellen und damit
    # jeden ANDEREN Absender an dieses Geraet aussperren. Warum ueber das
    # KONTO und nicht ueber das Sendegeraet gezaehlt wird, steht bei
    # ``offene_zustellungen_zaehlen``. Das Absender-Konto ist innerhalb
    # dieser Anfrage konstant (``user.id``, ein Login pro Aufruf), der
    # Cache-Schluessel ist deshalb einfach der Empfaenger-Pubkey.
    offene_je_sender_und_geraet: dict[str, int] = {}
    gesamt_zustellungen = 0
    verworfene_nutzlasten = 0
    # Angelegte Nutzlasten mit ihrem ``archiv``-Wunsch, fuer den Ableger unten.
    angelegte: list[tuple[DmNutzlast, bool]] = []
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
                # Kein Buendel innerhalb DIESES Gespraechs. Ein Pubkey, der
                # NIRGENDS existiert, ist immer Alltag (Geraet zwischen
                # Schluessel-Abholen und Absenden abgemeldet): still
                # uebersprungen. Ein Pubkey, der existiert, aber zu KEINEM
                # Teilnehmer dieses Kanals gehoert, haengt an der Kanalart
                # (Bughunt 2026-08-28/29 (belegter Fehler)):
                #
                # * **DM** — kein Alltagsfall, sondern ein Klientenfehler
                #   oder ein Angriff (nur zwei Teilnehmer) — fail-closed und
                #   laut, UNVERAENDERT (s.
                #   ``test_zustellung_an_ein_kanalfremdes_geraet_wird_abgewiesen``).
                # * **Private Gruppe** — hier ist es der Alltagsfall: ein
                #   Mitglied, das der Absender gerade eben noch in der Liste
                #   sah (Schritt 1 im Klienten), kann zwischen Lesen und
                #   Einliefern entfernt worden sein — sein Buendel existiert
                #   global weiter, gehoert aber zu keinem Teilnehmer mehr.
                #   Eine Gruppen-Anfrage traegt oft VIELE Empfaenger auf
                #   einmal (Megolm, ein Umschlag fuer alle); sie mit 403 zu
                #   toeten liesse jedes andere, weiterhin berechtigte
                #   Mitglied ebenfalls leer ausgehen. Zugestellt wird dem
                #   Ausgeschiedenen so oder so nichts — nur WIE das dem
                #   Absender gesagt wird, unterscheidet sich.
                #
                # Ein reiner Existenz-Check statt eines zweiten
                # ``_bundle_laden``-Aufrufs, weil er selbst bei einer
                # Pubkey-Kollision unter mehreren fremden Konten nie mehr als
                # einen booleschen Wert liefert.
                fremdes_geraet_vorhanden = (
                    await session.execute(
                        select(exists().where(DeviceKeyBundle.device_pubkey == pubkey))
                    )
                ).scalar_one()
                if fremdes_geraet_vorhanden and zugriff.ist_dm:
                    raise HTTPException(status_code=403, detail="empfaenger_nicht_im_kanal")
                uebersprungene_empfaenger[pubkey] = None
                continue
            if pubkey not in offene_je_geraet:
                # Beide Zaehler kommen gemeinsam (``_postfach_deps.py``) und
                # werden gemeinsam zwischengespeichert — sie entstehen immer
                # beim selben ersten Auftreten dieses Pubkeys.
                (
                    offene_je_geraet[pubkey],
                    offene_je_sender_und_geraet[pubkey],
                ) = await offene_zustellungen_zaehlen(
                    session, pubkey=pubkey, absender_user_id=user.id
                )
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
        nutzlast_obj = DmNutzlast(
            id=nutzlast_id,
            channel_id=cid_int,
            absender_device_pubkey=geraet,
            absender_user_id=user.id,
            absender_curve25519=absender_curve25519,
            art=eintrag.art,
            daten=eintrag.daten,
            groesse=groesse,
        )
        session.add(nutzlast_obj)
        angelegte.append((nutzlast_obj, eintrag.archiv))
        # Jede Nutzlast traegt denselben Anhang — bei einer DM ist sie je
        # Empfaengergeraet eine andere, der hochgeladene Klumpen aber nur
        # einmal da. Er faellt erst, wenn die LETZTE dieser Nutzlasten weg
        # ist (``postfach_pflege.py``).
        await bezuege_anlegen(session, nutzlast_id=nutzlast_id, anhang_ids=anhang_ids)
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

    # 4b. Festigung (Task 3) fuer Nutzlasten mit ``archiv: true`` — als
    # Hintergrundaufgabe NACH der Antwort, nicht im Anfragepfad: das Ablegen
    # geht an eine FREMDE Cloud, und ein Einliefern darf nicht auf sie warten
    # (Nextcloud-Zeitueberschreitungen liegen im Sekundenbereich). Der Lauf
    # bekommt deshalb eine eigene Session (``ablage_kanal_ordner.py``) — die
    # Anfrage-Session hier ist beendet, sobald die Antwort raus ist — und
    # schluckt JEDEN Fehler zu einem Nachtrag; die Antwort bleibt ein Erfolg,
    # der Umschlag ist ja zugestellt.
    background.add_task(
        festigung_nachlaufen,
        [n.id for n, archiv in angelegte if archiv],
        ableger=ablegen_im_ordner,
    )

    # 5./6. Weckruf (WS) + Push — ausgelagert nach
    # ``postfach_benachrichtigung.py`` (Groessen-Policy), Verhalten
    # unveraendert. Beides best-effort, beides ohne Inhalt.
    await wecke_und_pushe(
        getattr(request.app.state, "connection_manager", None),
        channel_id=cid_int,
        zustellungen=gesamt_zustellungen,
        push_empfaenger=push_empfaenger,
        absender_name=user.username,
    )

    return PostfachEinliefernResponse(
        zustellungen_angelegt=gesamt_zustellungen,
        uebersprungene_empfaenger=list(uebersprungene_empfaenger),
        verworfene_nutzlasten=verworfene_nutzlasten,
    )
