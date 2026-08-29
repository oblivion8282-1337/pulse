"""Geraete-Kopplung — Code anlegen, einloesen, Stand abfragen (Etappe F).

===========================================================================
DIE SICHERHEITSFRAGE, VOR DEM BAUEN BEANTWORTET
===========================================================================

**Was beweist der Code?** Nichts ueber die Identitaet — die steht schon fest.
Beide beteiligten Geraete sind bereits am Konto angemeldet und legen jedes
fuer sich ein cloud-signiertes Identitaets-Zertifikat plus Unterschrift vor
(``schluessel_nachweis.py::pruefe_geraet``). Der Code beweist etwas anderes,
das kein Zertifikat beweisen kann: **dass dieselbe Person in diesem Moment
beide Geraete in der Hand hat.** Er ist eine Autorisierung, keine
Authentifizierung — und genau EINE: „dieses eine neue Geraet darf meinen
Verlauf bekommen".

**Wie lange gilt er?** ``kopplung_code_gueltig_minuten`` (Vorgabe 10) bis zur
Einloesung. Danach ist der Code verbraucht; die laengere ``umzug_frist_stunden``
gilt nur noch dem bereits gebundenen Geraetepaar und oeffnet nichts mehr.

**Was passiert bei mehrfacher Einloesung?** Sie ist unmoeglich, und zwar
nicht durch eine Pruefung davor, sondern durch die Einloesung selbst: ein
einziges ``UPDATE … WHERE eingeloest_am IS NULL RETURNING id``
(Muster ``registration_invites``, Migration 0022). Der zweite Versuch trifft
null Zeilen, egal wie eng er am ersten liegt — es gibt kein Fenster zwischen
Pruefen und Setzen, in das ein Wettlauf passte. Er bekommt 409.

**Was kann jemand anfangen, der den Bildschirm abfotografiert?** Ohne Zugang
zum Konto: nichts. Jede Route dieser Datei verlangt zusaetzlich einen
gueltigen Bearer UND ein Zertifikat DESSELBEN Kontos; ein Fremder kommt an
keiner der beiden Huerden vorbei.

Mit Zugang zum Konto — also nach einer Uebernahme — ist der Gewinn dagegen
**erheblich, und das gehoert ausgesprochen**: heute erbeutet eine Uebernahme
nur, was der Server hat (kuenftig also nichts von den verschluesselten DMs).
Mit einem abfotografierten Code erbeutet sie den **vollstaendigen lokalen
Verlauf** des alten Geraets. Deshalb, und nur deshalb, sind die drei
Gegenmassnahmen keine Kosmetik: kurze Frist, Einmal-Einloesung, und die
Anzeige laeuft auf dem alten Geraet, das jederzeit abbrechen kann
(``POST /kopplung/abschliessen``).

**Was der Server bei alldem nicht kann: mitlesen.** Er speichert nur
``SHA-256(Code)``. Der Schluessel der Stuecke wird per HKDF aus dem Code
selbst abgeleitet (``web/src/lib/kopplung/transport.ts``), und der Code
ueberquert diese Leitung nie. Ein Datenbank-Leak liefert Chiffretext und
einen Hash — kein Klartext, auch nicht rueckwirkend.

**Die Grenze dieser Konstruktion, ehrlich benannt:** wer den Code hat, kann
den Verlauf lesen. Er ist ~100 Bit lang und wird auf dem Bildschirm gezeigt;
gegen jemanden, der ueber die Schulter schaut UND das Konto hat, schuetzt er
nicht. Das ist derselbe Handel, den jede QR-Kopplung eingeht.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import NoReturn

from fastapi import APIRouter, HTTPException, Request
from sqlalchemy import func, insert, literal, select, update

import dcc_chat_gateway.config as chat_config
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.kopplung_schemas import (
    KopplungAnlegenRequest,
    KopplungAnlegenResponse,
    KopplungEinloesenRequest,
    KopplungEinloesenResponse,
    KopplungStandRequest,
    KopplungStandResponse,
)
from dcc_chat_gateway.kopplung_zugriff import _als_utc, kopplung_laden
from dcc_chat_gateway.models import Kopplung, UmzugStueck
from dcc_chat_gateway.routes._postfach_deps import _require_redis
from dcc_chat_gateway.schluessel_nachweis import baue_nutzlast, pruefe_geraet
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id

router = APIRouter(tags=["kopplung"])


@router.post("/kopplung", response_model=KopplungAnlegenResponse)
async def kopplung_anlegen(
    body: KopplungAnlegenRequest,
    request: Request,
    session: SessionDep,
    user: CurrentUser,
) -> KopplungAnlegenResponse:
    """Legt eine offene Kopplung an — gerufen vom EINGERICHTETEN Geraet.

    Reihenfolge wie in ``routes/postfach.py``: billige Struktur- und
    Mengenpruefungen vor der teuren Ed25519-Verifikation waere hier nicht
    moeglich, weil die Mengenpruefung selbst die DB braucht — dafuer ist der
    Rumpf winzig, es gibt also nichts, was eine vorgezogene Pruefung sparen
    koennte.
    """
    settings = chat_config.get_settings()
    redis = _require_redis(request)

    nutzlast = baue_nutzlast("kopplung", body.code_hash)
    claims = await pruefe_geraet(body.cert, nutzlast, body.signatur, user, redis, session)

    jetzt = datetime.now(UTC)
    verfaellt_am = jetzt + timedelta(minutes=settings.kopplung_code_gueltig_minuten)
    kopplung_id = next_id()

    # Zaehlen und Einfuegen in EINER Anweisung (Bughunt Befund 5, 2026-08-29).
    # Die vorige Fassung las die Zahl offener Kopplungen per ``SELECT count``
    # und schrieb danach getrennt — dazwischen lag ein Await-Punkt, an dem
    # eine zweite, fast gleichzeitige Anlage denselben (noch ungezaehlten)
    # Stand sah und ebenfalls durchkam. Die Zaehl-Unterabfrage haengt jetzt in
    # der WHERE-Klausel DERSELBEN ``INSERT``-Anweisung: zwischen Zaehlen und
    # Schreiben liegt kein ``await`` mehr, an dem eine zweite Anfrage
    # dazwischenfunken koennte — nachgestellt in
    # ``test_offene_kopplungen_haelt_die_grenze_auch_im_wettlauf``.
    #
    # **Grenze der Konstruktion, ehrlich benannt:** das schliesst die Race
    # innerhalb EINER Transaktion/Verbindung — genau die Form, die der Test
    # nachstellt. Zwei echte, gleichzeitige Postgres-Verbindungen koennten
    # ihre Zaehl-Unterabfrage theoretisch trotzdem gegen denselben,
    # gegenseitig noch unbestaetigten Stand lesen (klassisches READ-COMMITTED-
    # Write-Skew); das vollstaendig zu schliessen braucht eine Sperre (z. B.
    # ``pg_advisory_xact_lock`` je Konto) oder eine serialisierbare
    # Transaktion mit Retry. Bewusst nicht gebaut: betroffen ist ausschliess-
    # lich das eigene Konto (Obergrenze der eigenen offenen Kopplungen), kein
    # fremder Zugriff — der Aufwand einer echten Sperre steht in keinem
    # Verhaeltnis zum Schaden eines vereinzelt ueberschrittenen Limits.
    offene_unterabfrage = (
        select(func.count())
        .select_from(Kopplung)
        .where(
            Kopplung.user_id == user.id,
            Kopplung.eingeloest_am.is_(None),
            Kopplung.verfaellt_am > jetzt,
        )
        .scalar_subquery()
    )
    einfuegen = insert(Kopplung).from_select(
        ["id", "user_id", "code_hash", "alt_device_pubkey", "verfaellt_am"],
        select(
            literal(kopplung_id),
            literal(user.id),
            literal(body.code_hash),
            # Aus den geprueften Claims, NIE aus dem Rumpf — sonst legte ein
            # Geraet eine Kopplung im Namen eines anderen an.
            literal(claims.device_pubkey),
            literal(verfaellt_am),
        ).where(offene_unterabfrage < settings.kopplung_max_offen_je_konto),
    )
    ergebnis = await session.execute(einfuegen)
    if ergebnis.rowcount == 0:
        raise HTTPException(status_code=429, detail="zu_viele_offene_kopplungen")
    await session.commit()

    return KopplungAnlegenResponse(id=kopplung_id, verfaellt_am=verfaellt_am)


@router.post("/kopplung/einloesen", response_model=KopplungEinloesenResponse)
async def kopplung_einloesen(
    body: KopplungEinloesenRequest,
    request: Request,
    session: SessionDep,
    user: CurrentUser,
) -> KopplungEinloesenResponse:
    """Loest einen Code ein — gerufen vom NEUEN Geraet. Genau einmal moeglich."""
    settings = chat_config.get_settings()
    redis = _require_redis(request)

    nutzlast = baue_nutzlast("kopplung-einloesen", body.code_hash)
    claims = await pruefe_geraet(body.cert, nutzlast, body.signatur, user, redis, session)

    jetzt = datetime.now(UTC)
    neue_frist = jetzt + timedelta(hours=settings.umzug_frist_stunden)

    # DIE atomare Stelle. Alle Bedingungen stehen in DERSELBEN Anweisung, die
    # auch setzt — kein Lesen-dann-Schreiben, in dessen Mitte ein zweiter
    # Versuch dieselbe Zeile noch offen faende.
    zeile = (
        await session.execute(
            update(Kopplung)
            .where(
                Kopplung.code_hash == body.code_hash,
                Kopplung.user_id == user.id,
                Kopplung.eingeloest_am.is_(None),
                Kopplung.verfaellt_am > jetzt,
                # Ein Geraet darf sich nicht mit sich selbst koppeln. Ohne
                # diese Zeile liefe der eigene Code ins Leere und die
                # Kopplung waere verbraucht — ein Bedienfehler, der wie ein
                # Angriff aussieht.
                Kopplung.alt_device_pubkey != claims.device_pubkey,
            )
            .values(
                neu_device_pubkey=claims.device_pubkey,
                eingeloest_am=jetzt,
                verfaellt_am=neue_frist,
            )
            .returning(Kopplung.id, Kopplung.alt_device_pubkey)
        )
    ).first()

    if zeile is None:
        await _einloesen_fehler_erklaeren(session, body.code_hash, user.id, claims, jetzt)

    await session.commit()
    return KopplungEinloesenResponse(
        id=zeile.id, alt_device_pubkey=zeile.alt_device_pubkey, verfaellt_am=neue_frist
    )


async def _einloesen_fehler_erklaeren(
    session, code_hash: str, user_id: int, claims, jetzt: datetime
) -> NoReturn:
    """Sagt dem Nutzer, WARUM die Einloesung nicht ging — und wirft immer.

    Die Diagnose-Abfrage filtert ebenfalls auf ``user_id``: ein Code eines
    fremden Kontos ist deshalb ununterscheidbar von einem erfundenen. Ohne
    diesen Filter waere die Fehlermeldung ein Orakel dafuer, welche Codes
    irgendwo auf der Welt existieren.
    """
    kopplung = (
        await session.execute(
            select(Kopplung).where(Kopplung.code_hash == code_hash, Kopplung.user_id == user_id)
        )
    ).scalar_one_or_none()

    if kopplung is None:
        raise HTTPException(status_code=404, detail="kopplung_unbekannt")
    if kopplung.eingeloest_am is not None:
        raise HTTPException(status_code=409, detail="kopplung_schon_eingeloest")
    if _als_utc(kopplung.verfaellt_am) <= jetzt:
        raise HTTPException(status_code=410, detail="kopplung_abgelaufen")
    if kopplung.alt_device_pubkey == claims.device_pubkey:
        raise HTTPException(status_code=400, detail="kopplung_selbes_geraet")
    # Kein Zweig traf zu: die Zeile hat sich zwischen UPDATE und Diagnose
    # geaendert (ein zweites Geraet war schneller). Dieselbe Antwort wie der
    # haeufigste Fall dieses Wettlaufs.
    raise HTTPException(status_code=409, detail="kopplung_schon_eingeloest")


@router.post("/kopplung/stand", response_model=KopplungStandResponse)
async def kopplung_stand(
    body: KopplungStandRequest,
    request: Request,
    session: SessionDep,
    user: CurrentUser,
) -> KopplungStandResponse:
    """Stand einer Kopplung — von BEIDEN Seiten abfragbar.

    Fuer den Sender ist ``vorhandene_stuecke`` die Fortsetz-Auskunft, fuer den
    Empfaenger die Fortschritts-Auskunft. Beide Rollen sind zugelassen, aber
    keine dritte: geprueft wird gegen ``alt`` UND ``neu``, nicht gegen „irgendein
    Geraet des Kontos".
    """
    redis = _require_redis(request)
    kid = int(body.kopplung_id)
    nutzlast = baue_nutzlast("kopplung-stand", str(kid))
    claims = await pruefe_geraet(body.cert, nutzlast, body.signatur, user, redis, session)

    kopplung = await _als_alt_oder_neu(session, kid, user.id, claims.device_pubkey)

    zeilen = (
        await session.execute(
            select(UmzugStueck.folge, UmzugStueck.kennung)
            .where(UmzugStueck.kopplung_id == kid)
            .order_by(UmzugStueck.folge)
        )
    ).all()

    return KopplungStandResponse(
        id=kopplung.id,
        eingeloest=kopplung.eingeloest_am is not None,
        neu_device_pubkey=kopplung.neu_device_pubkey,
        gesamt_stuecke=kopplung.gesamt_stuecke,
        vorhandene_stuecke=[folge for folge, _kennung in zeilen],
        # Nur wo eine Kennung hinterlegt ist (aeltere Zeilen vor diesem Feld
        # haben keine) — der Sender behandelt eine fehlende Position in
        # dieser Abbildung als Nicht-Uebereinstimmung, s. Modulkopf-Verweis
        # in ``kopplung_schemas.py``.
        vorhandene_kennungen={folge: k for folge, k in zeilen if k is not None},
        verfaellt_am=kopplung.verfaellt_am,
    )


async def _als_alt_oder_neu(session, kid: int, user_id: int, device_pubkey: str) -> Kopplung:
    """Laesst beide Rollen durch, aber nur diese beiden."""
    try:
        return await kopplung_laden(session, kid, user_id, device_pubkey, "alt")
    except HTTPException:
        return await kopplung_laden(session, kid, user_id, device_pubkey, "neu")
