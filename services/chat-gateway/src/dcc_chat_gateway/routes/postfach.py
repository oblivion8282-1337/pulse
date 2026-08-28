"""Das Postfach — Einliefern verschluesselter Umschlaege (Etappe D, E2E-DM).

``POST /postfach`` nimmt einen oder mehrere verschluesselte Umschlaege
entgegen und faechert sie an die angegebenen Empfaengergeraete auf: eine
Zeile je Geraet in ``DmZustellung``, die auf eine ``DmNutzlast`` zeigt.
Abholen und Quittieren (Task 3) sowie der Verfallslauf (Task 4) folgen in
eigenen Aenderungen — hier nur das Einliefern.

Alle Pruefungen sind fail-closed, in dieser Reihenfolge:

1. Geraete-Nachweis (``schluessel_nachweis.py``, eigener Zweck ``"postfach"``
   — eine fuer ein Schluesselbuendel geleistete Unterschrift darf hier nicht
   gelten).
2. Kanalzugang — DIESELBE Regel wie im Klartext-Sendeweg
   (``ws_op_send.py:139-151``): DM-Kanal laden, Mitgliedschaft pruefen,
   ``block_exists_either_way`` + ``friendship_exists``. Postfach traegt
   heute nur DMs (Gruppen sind Etappe G) — eine Gilden-Kanal-ID wird deshalb
   ebenfalls abgewiesen.
3. Obergrenzen (Groesse je Umschlag, Anzahl Nutzlasten je Anfrage, offene
   Zustellungen je Empfaengergeraet).

Der Server kann keinen Umschlag oeffnen — deshalb wird ``daten`` nirgends
geloggt, auch nicht in Fehlermeldungen.
"""

from __future__ import annotations

import base64
import logging
from datetime import UTC, datetime, timedelta

from dcc_shared.events import PostfachNeuEvent
from fastapi import APIRouter, HTTPException, Request, Response, status
from sqlalchemy import func, select

import dcc_chat_gateway.config as chat_config
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.friend_helpers import block_exists_either_way, friendship_exists
from dcc_chat_gateway.models import DeviceKeyBundle, DirectMessageChannel, DmNutzlast, DmZustellung
from dcc_chat_gateway.routes._deps import resolve_channel_for_user
from dcc_chat_gateway.schemas import PostfachEinliefernRequest
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


async def _bundle_laden(session, device_pubkey: str) -> DeviceKeyBundle | None:
    """Der Verzeichnis-Eintrag eines Geraets, oder ``None`` — ein Geraet ohne
    veroeffentlichtes Buendel ist Alltag (noch nicht veroeffentlicht, gerade
    abgemeldet), kein Fehler; wie damit umzugehen ist, entscheidet die
    jeweilige Aufrufstelle."""
    return (
        await session.execute(
            select(DeviceKeyBundle).where(DeviceKeyBundle.device_pubkey == device_pubkey)
        )
    ).scalar_one_or_none()


def _envelope_groesse(daten_b64: str) -> int:
    """Bytes VOR der Base64-Kodierung — nie den Inhalt in der Fehlermeldung,
    nur, DASS er ungueltig war."""
    try:
        return len(base64.b64decode(daten_b64, validate=False))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="ungueltige_nutzlast") from exc


@router.post("/postfach", status_code=status.HTTP_204_NO_CONTENT)
async def postfach_einliefern(
    body: PostfachEinliefernRequest,
    request: Request,
    session: SessionDep,
    user: CurrentUser,
) -> Response:
    # Modul-Zugriff statt ``from … import get_settings`` (s. owner_check.py):
    # der Name waere sonst zur Importzeit gebunden und saehe eine spaetere
    # Test-Ueberschreibung von ``get_settings`` (s. ``_isolate_chat_settings``
    # in conftest.py) nicht.
    settings = chat_config.get_settings()
    redis = _require_redis(request)
    cid_int = int(body.channel_id)

    # 1. Geraete-Nachweis. Signatur bindet Kanal + alle Umschlaege — sonst
    # koennte eine fuer einen anderen Kanal/Inhalt geleistete Unterschrift
    # hier wiederverwendet werden.
    nutzlast_bytes = baue_nutzlast(
        "postfach", str(cid_int), *[n.daten for n in body.nutzlasten]
    )
    claims = await pruefe_geraet(body.cert, nutzlast_bytes, body.signatur, user, redis)

    # 2. Kanalzugang. Der Kanal liefert zugleich die Menge der Konten, an die
    # ueberhaupt zugestellt werden darf (s. Pruefung weiter unten).
    dm_obj = await _channel_zugriff_pruefen(session, cid_int, user.id)
    teilnehmer = {dm_obj.user_a_id, dm_obj.user_b_id}

    # 3. Obergrenzen.
    if len(body.nutzlasten) > settings.postfach_max_nutzlasten_je_anfrage:
        raise HTTPException(status_code=400, detail="zu_viele_nutzlasten")
    groessen = [_envelope_groesse(n.daten) for n in body.nutzlasten]
    for groesse in groessen:
        if groesse > settings.postfach_max_umschlag_bytes:
            raise HTTPException(status_code=400, detail="umschlag_zu_gross")

    # 4. Anlegen. Zuerst das EIGENE Buendel des einliefernden Geraets — es
    # liefert den Curve25519-Identitaetsschluessel, den ein Empfaenger fuer
    # einen frischen Sitzungsaufbau braucht (Olm-Standardverhalten, s.
    # Migration 0069). ``claims.device_pubkey`` ist bereits durch den
    # Geraete-Nachweis geprueft, kein neuer Vertrauensschritt. Fehlt das
    # Buendel, bleibt die Spalte NULL — der Server erzwingt sie nicht, er
    # oeffnet den Umschlag ja nie.
    absender_bundle = await _bundle_laden(session, claims.device_pubkey)
    absender_curve25519 = absender_bundle.curve25519 if absender_bundle else None

    # ``offene_je_geraet`` ist ein In-Request-Cache: eine
    # Anfrage mit mehreren Umschlaegen an dasselbe volle Geraet soll dieses
    # Geraet nicht mehrfach abfragen, und der lokale Zaehler wird bei jeder
    # neu angelegten Zustellung mitgefuehrt (sonst zaehlte er innerhalb der
    # Anfrage nicht mit, weil ungesetzte Inserts vor dem Commit nicht in
    # einem erneuten COUNT auftauchen).
    verfaellt_am = datetime.now(UTC) + timedelta(days=settings.postfach_frist_tage)
    offene_je_geraet: dict[str, int] = {}
    gesamt_zustellungen = 0

    for eintrag, groesse in zip(body.nutzlasten, groessen, strict=True):
        empfaenger_zeilen: list[tuple[str, int]] = []
        for pubkey in dict.fromkeys(eintrag.empfaenger):  # Duplikate raus.
            bundle = await _bundle_laden(session, pubkey)
            if bundle is None:
                # Kein Buendel im Verzeichnis: das Geraet ist zwischen
                # Schluessel-Abholen und Absenden verschwunden — Alltag,
                # kein Fehler fuer die uebrigen Empfaenger.
                continue
            # **Das Geraet muss zu DIESEM Gespraech gehoeren.**
            #
            # Die Kanalpruefung oben belegt nur, dass der Absender in DIESEM
            # Kanal schreiben darf — nicht, an WEN zugestellt wird. Die
            # Empfaengerkennungen kommen aus dem Anfrage-Rumpf; ohne diese
            # Zeile koennte jeder mit einer einzigen legitimen DM Umschlaege
            # in das Postfach JEDES Geraets JEDES Nutzers legen, auch von
            # Leuten, die ihn geblockt haben, und dabei deren Kontingent
            # vollschreiben.
            #
            # Kein stilles Ueberspringen wie beim unbekannten Geraet: ein
            # fremdes Geraet ist kein Alltagsfall, sondern ein Klientenfehler
            # oder ein Angriff. Fail-closed und laut.
            if bundle.user_id not in teilnehmer:
                raise HTTPException(status_code=403, detail="empfaenger_nicht_im_kanal")
            if pubkey not in offene_je_geraet:
                offene_je_geraet[pubkey] = (
                    await session.execute(
                        select(func.count())
                        .select_from(DmZustellung)
                        .where(DmZustellung.empfaenger_device_pubkey == pubkey)
                    )
                ).scalar_one()
            if offene_je_geraet[pubkey] >= settings.postfach_max_offene_zustellungen_je_geraet:
                # Geraet ist voll — wie ein unbekanntes Geraet uebersprungen,
                # nicht die ganze Anfrage abgewiesen.
                #
                # **Diese Grenze ist naeherungsweise, nicht scharf**, und das
                # gehoert gesagt: der Zaehler wird VOR dem Einfuegen gelesen,
                # gleichzeitige Anfragen sehen also denselben alten Stand und
                # koennen ihn zusammen ueberschreiten. Ein scharfer Wert
                # brauchte eine Zaehlerzeile mit bewachtem UPDATE.
                #
                # Vertretbar ist die Naeherung erst, seit oben geprueft wird,
                # dass ein Empfaengergeraet zu DIESEM Gespraech gehoert: das
                # Kontingent eines Fremden ist damit unerreichbar, und wer es
                # ueberschreiten kann, ist jemand, mit dem man befreundet ist
                # und schreibt — dessen Ueberschuss zudem nach
                # ``postfach_frist_tage`` von selbst verfaellt.
                continue
            empfaenger_zeilen.append((pubkey, bundle.user_id))
            offene_je_geraet[pubkey] += 1

        if not empfaenger_zeilen:
            # Keine Zustellung moeglich -> keine Nutzlast anlegen (sonst
            # eine Zeile, die niemand je abholen kann).
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

    return Response(status_code=status.HTTP_204_NO_CONTENT)
