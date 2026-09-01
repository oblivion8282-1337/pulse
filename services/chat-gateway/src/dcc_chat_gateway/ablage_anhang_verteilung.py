"""Anhaenge in die Cloud-Ordner aller Beteiligten legen (Design §11.1).

**Was sich damit umkehrt.** Bisher hielt Pulse das Chiffrat eines
verschluesselten DM-Anhangs, bis der letzte Umschlag quittiert war, und
raeumte es dann weg (``postfach_pflege.py::sweep_verwaiste_anhaenge``) — oft
binnen Minuten. Wer ein Bild nie angeklickt hat, verlor es. Neu legt der
Server dasselbe unlesbare Paket in den Archiv-Ordner **jedes Beteiligten**
und gibt danach seine eigene Kopie frei. Ein Empfaenger holt die Datei
spaeter aus SEINEM Laufwerk; Pulses Aufbewahrung spielt keine Rolle mehr.

**Warum ueber Pulse und nicht Cloud zu Cloud** (§11.1): ein Ordner kennt
keine Personen. Laege die Datei nur beim Absender, braeuchte der Empfaenger
einen Link — und der oeffnet nicht eine Datei, sondern den ganzen Ordner.
Pulse ist der einzige gemeinsame Boden, auf den alle duerfen; es ist dabei
Durchgang, nicht Speicher.

**Der Server sieht weiterhin nur Chiffrat.** Was er weiterschiebt, ist genau
der Klumpen, den der Klient hochgeladen hat (AES-GCM aus
``web/src/lib/krypto/anhangKrypto.ts``) — Byte fuer Byte unveraendert, ohne
zweite Huelle. Der Dateiname steckt im verschluesselten Umschlag beim
Empfaenger und geht den Server nichts an; er kaeme hier auch gar nicht an.
Die Dateinamen im Laufwerk sind deshalb reine Kennungen.

**Alles oder nichts, und das ist die Sicherheitsregel dieses Moduls.** Die
eigene Kopie faellt erst, wenn JEDER Beteiligte sein Paket hat. Fehlt auch
nur einem das Laufwerk oder schlaegt ein Schreibvorgang fehl, bleibt der
Klumpen bei Pulse und es gilt unveraendert das heutige Verhalten. Der
Anhang-Knopf verhindert den Fall in der Oberflaeche (§11.2), aber darauf
darf sich der Server nicht verlassen — die Oberflaeche ist keine Zusicherung.

**Wo Google Drive spaeter ansetzt.** Heute gibt es genau einen Anbietertyp:
eine Freigabe-Adresse, unter der ein ``PUT`` ohne jede Zugangsdaten
durchgeht (Nextcloud-Freigabe-Link und alles Link-basierte, gemessen am
2026-09-01). ``_lege_ab`` ist die einzige Stelle, die das weiss. Ein
OAuth-Anbieter (§11.4) bekommt dort einen zweiten Zweig und braucht dazu
eine Spalte an ``ablage_konto_laufwerke``, die den verwahrten Zugang
verschluesselt haelt — was §11.4 ausdruecklich als eigenen Auftrag benennt.
Bis dahin wird hier bewusst KEIN Anbieter-Feld erfunden: eine leere
Fallunterscheidung waere eine Behauptung ueber Code, den es nicht gibt.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway import s3
from dcc_chat_gateway.ablage_schreiben import schreibe as schreibe_aufs_laufwerk
from dcc_chat_gateway.ablage_ssrf import AblageAbrufFehler
from dcc_chat_gateway.models import AblageKontoLaufwerk, MessageAttachment

log = logging.getLogger(__name__)


class AnhangVerteilFehler(Exception):
    """Die Verteilung ist nicht vollstaendig gelungen.

    Traegt eine kurze Kennung, nie eine Adresse und nie einen Dateinamen —
    der Klient uebersetzt sie in einen Satz. Wird bis zur Route
    durchgereicht und dort zu einem 502 mit derselben Kennung; die
    Oberflaeche macht daraus einen sichtbaren Fehlschlag an der Kachel,
    statt still weiterzumachen.
    """

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


def archiv_pfad(anhang_id: int, *, vorschau: bool = False) -> str:
    """Der Dateiname eines Anhangs im Archiv-Ordner — beide Seiten leiten ihn
    unabhaengig aus der Kennung ab.

    **Flach, kein Unterordner.** Ein ``PUT`` in eine Sammlung, die es noch
    nicht gibt, beantwortet WebDAV mit 409, und ``ablage_schreiben.schreibe``
    legt bewusst keine an (ein ``MKCOL`` waere ein zweiter Aufruf mit einem
    zweiten Fehlerfall). Der Archiv-Ordner traegt seine Segmente ohnehin
    flach (``web/src/lib/ablage/segment.ts``: ``seg-000000.puls``); das
    Praefix ``anh-`` haelt die beiden Sorten trotzdem auseinander.

    **Der Name ist eine Snowflake und sonst nichts.** Kein Dateiname, kein
    Typ, keine Groesse — was der Server ohnehin nicht kennt, kann er auch
    nicht in einen Ordner schreiben, den fremde Augen sehen koennten.

    Das Gegenstueck steht in ``web/src/lib/ablage/anhangArchivPfad.ts`` und
    muss synchron bleiben; ein Unit-Test dort haelt die Form fest.
    """
    return f"anh-{anhang_id}{'-vs' if vorschau else ''}.puls"


async def laufwerke_der_beteiligten(
    session: AsyncSession, user_ids: set[int]
) -> dict[int, AblageKontoLaufwerk]:
    """Die eingetragenen Archiv-Laufwerke dieser Konten, nach Konto-ID.

    Wer fehlt, hat keines — der Aufrufer entscheidet, was das bedeutet
    (hier: der Anhang bleibt bei Pulse; in der Bereitschafts-Auskunft: der
    Knopf verschwindet).
    """
    if not user_ids:
        return {}
    zeilen = (
        await session.execute(
            select(AblageKontoLaufwerk).where(AblageKontoLaufwerk.user_id.in_(user_ids))
        )
    ).scalars().all()
    return {zeile.user_id: zeile for zeile in zeilen}


async def _klumpen_lesen(key: str, max_bytes: int) -> bytes:
    """Holt ein Objekt aus dem Objektspeicher in den Speicher.

    Die Grenze wird WAEHREND des Lesens geprueft, nicht danach: ein Objekt,
    das ueber der Einstellung liegt (etwa weil sie nach dem Hochladen
    gesenkt wurde), soll den Prozess nicht erst vollstaendig fuellen.
    """
    stuecke: list[bytes] = []
    gesamt = 0
    async for stueck in s3.stream_object(key):
        gesamt += len(stueck)
        if gesamt > max_bytes:
            raise AnhangVerteilFehler("anhang_zu_gross")
        stuecke.append(stueck)
    return b"".join(stuecke)


async def _lege_ab(
    laufwerk: AblageKontoLaufwerk, pfad: str, inhalt: bytes, max_bytes: int
) -> None:
    """Ein Paket auf EIN Laufwerk legen — die einzige anbieterabhaengige
    Stelle dieses Moduls (s. Modulkopf, „Wo Google Drive spaeter ansetzt").

    Heute: die Freigabe-Adresse ist ein WebDAV-Ziel, das ein ``PUT`` ohne
    Zugangsdaten annimmt. ``schreibe`` fuehrt dabei die SSRF-Pruefung und
    verankert die Verbindung an der geprueften Adresse.
    """
    try:
        await schreibe_aufs_laufwerk(
            basis=laufwerk.freigabe_adresse,
            pfad=pfad,
            inhalt=inhalt,
            max_bytes=max_bytes,
        )
    except AblageAbrufFehler as fehler:
        raise AnhangVerteilFehler(f"laufwerk_{fehler.code}") from fehler


async def verteile_anhang(
    session: AsyncSession,
    *,
    anhang: MessageAttachment,
    beteiligte: set[int],
    max_bytes: int,
) -> None:
    """Legt Klumpen und Vorschau in JEDES Beteiligten-Laufwerk und gibt danach
    die eigene Kopie frei. Committet.

    Reihenfolge, und sie ist nicht beliebig:

    1. Alle Laufwerke da? Sonst ``kein_laufwerk`` und **nichts** geschieht —
       kein halb verteilter Anhang, der weder hier noch dort ganz liegt.
    2. Bytes lesen, dann an jedes Laufwerk schreiben. Ein Fehlschlag bricht
       ab; was schon geschrieben wurde, bleibt liegen (Aufraeumen ist §11.5),
       aber Pulses Kopie bleibt ebenfalls — der Anhang ist also weiter
       erreichbar, und der Klient erfaehrt den Fehlschlag.
    3. Erst wenn alle bestaetigt haben: Marke setzen, committen, DANN die
       Objekte loeschen. Genau die Reihenfolge von
       ``hard_delete_attachments(defer_s3=…)``. Andersherum verloere ein
       fehlgeschlagener Commit die Bytes, waehrend die Zeile weiter auf sie
       zeigt — und dann waere der Anhang nirgends mehr.

    Ein zweiter Aufruf fuer denselben Anhang ist ein No-Op (die Marke steht
    schon): ein wiederholter Klient soll nicht dieselben Bytes ein zweites
    Mal in fremde Ordner schieben.
    """
    if anhang.laufwerk_verteilt_am is not None:
        return

    laufwerke = await laufwerke_der_beteiligten(session, beteiligte)
    fehlend = beteiligte - laufwerke.keys()
    if fehlend:
        # Kein Log mit Konto-IDs: die Auskunft, WER kein Laufwerk hat, gibt
        # es an genau einer Stelle (der Bereitschafts-Route), und die ist an
        # die Kanalmitgliedschaft gebunden.
        raise AnhangVerteilFehler("kein_laufwerk")

    # Objektschluessel und Zielpfad gehoeren zusammen: derselbe Klumpen wird
    # gelesen, geschrieben und am Ende bei Pulse freigegeben. Die Vorschau ist
    # der einzige wahlweise Teil — sie steht deshalb in EINER
    # Fallunterscheidung statt in je einer beim Lesen und beim Freigeben.
    quellen: list[tuple[str, str]] = [(anhang.storage_key, archiv_pfad(anhang.id))]
    if anhang.thumb_storage_key:
        quellen.append((anhang.thumb_storage_key, archiv_pfad(anhang.id, vorschau=True)))

    pakete = [(pfad, await _klumpen_lesen(key, max_bytes)) for key, pfad in quellen]

    for laufwerk in laufwerke.values():
        for pfad, inhalt in pakete:
            await _lege_ab(laufwerk, pfad, inhalt, max_bytes)

    anhang.laufwerk_verteilt_am = datetime.now(UTC)
    schluessel = [key for key, _ in quellen]
    await session.commit()

    # Erst nach dem Commit, und erst hier importiert — derselbe Import-Kreis
    # wie in ``postfach_pflege.py`` (``routes.attachments`` fuehrt ueber
    # ``routes/internal.py`` wieder hierher zurueck).
    from dcc_chat_gateway.routes.attachments import purge_s3_keys

    await purge_s3_keys(schluessel)
    log.info("anhang in laufwerke verteilt", extra={"anzahl_laufwerke": len(laufwerke)})


__all__ = [
    "AnhangVerteilFehler",
    "archiv_pfad",
    "laufwerke_der_beteiligten",
    "verteile_anhang",
]
