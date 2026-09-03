"""Der Ableger — ein eingelieferter Postfach-Umschlag landet zusaetzlich als
Datei im Kanal-Ordner seines Erstellers (Entwurf 2026-09-02, §2-3).

**Wie das zum Postfach steht.** ``POST /postfach`` legt eine ``DmNutzlast``
an, egal ob der Kanal ein Ablage-Kanal ist — das Postfach ist der einzige
Zustellweg (CLAUDE.md: „ohne App-Geraet keine Direktnachrichten"). Ist der
Kanal zusaetzlich ein Ordner-Kanal (``AblageKanalOrdner``-Zeile vorhanden),
legt diese Datei den Umschlag zusaetzlich unter ``kanaele/<channel_id>/`` im
Konto-Laufwerk des Erstellers ab — das ist die Festigung, die einen
verstrichenen Umschlag (Postfach-Verfall) ueberdauert.

**Was in der Datei steht.** Denselben Umschlag wie beim Abholen
(``PostfachZustellungOut``): der Nachrichtentext bleibt Chiffrat, aber
Absender-Kennung, Absender-Konto, Kanal und Sendezeit stehen im Klartext
darin — genau wie in der Postfach-Zeile, aus der die Datei gebaut wird. Die
Datei ist damit nicht anonymer als das Postfach, nur dauerhafter. Die
FREIGABE-ADRESSE des Laufwerks steht nirgends darin und wird auch nicht
geloggt (``ablage_kanal.py``-Modulkopf).

**Ablauf statt Nachrichtenverlauf.** Der Server schreibt an eine Adresse, die
er nie zurueckgibt. Schlaegt der Schreibversuch fehl (Nextcloud kurz nicht
erreichbar), entsteht eine ``AblageKanalNachtrag``-Zeile — die Pflege holt
sie ueber ``nachtrag_sweep`` nach, statt den Umschlag stillschweigend
verloren zu geben.

**Die Festigung laeuft NACH der Antwort** (``festigung_nachlaufen``, als
FastAPI-``BackgroundTask`` aus ``routes/postfach.py``), mit einer EIGENEN
Session: die Anfrage-Session ist beendet, sobald die Antwort raus ist. Ein
Einliefern soll nie auf eine fremde Cloud warten muessen — und kein Fehler
dort darf ein 500 erzeugen, der Umschlag ist zu diesem Zeitpunkt laengst
zugestellt.

Modulweite Namen ``schreibe_aufs_laufwerk``/``ordner_anlegen_am_laufwerk``
als Import-Aliase — Tests ersetzen sie per ``monkeypatch.setattr`` (Muster
``test_postfach_anhaenge_laufwerk.py::_LaufwerkMock``), statt das ganze
HTTP-Verhalten von ``ablage_schreiben`` mitzusimulieren. ``SessionLocal``
steht aus demselben Grund als Modulname hier (Muster ``routes/ws_ops.py``,
gepatcht in ``tests/conftest.py::app``).
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.ablage_schreiben import ordner_anlegen as ordner_anlegen_am_laufwerk
from dcc_chat_gateway.ablage_schreiben import schreibe as schreibe_aufs_laufwerk
from dcc_chat_gateway.ablage_ssrf import AblageAbrufFehler
from dcc_chat_gateway.db import SessionLocal
from dcc_chat_gateway.models import (
    AblageKanalNachtrag,
    AblageKanalOrdner,
    AblageKontoLaufwerk,
    DmNutzlast,
)
from dcc_chat_gateway.schemas import PostfachZustellungOut

log = logging.getLogger(__name__)

#: Hoechstens so viele Nachtraege je Pflegelauf — dieselbe Begruendung wie
#: ``_ANHANG_BATCH`` in ``postfach_pflege.py``: ein Rueckstau (Nextcloud war
#: eine Nacht lang weg) darf nicht eine einzige Transaktion und eine fremde
#: Cloud gleichzeitig ueberfahren. Der naechste Takt holt den Rest.
_NACHTRAG_BATCH = 100

#: Kanaele, fuer die dieser Prozess das MKCOL schon gefahren hat. Der Ordner
#: entsteht genau einmal; jedes weitere MKCOL ist eine Netzrunde zu einer
#: fremden Cloud fuer eine Antwort, die schon feststeht. Bewusst nur
#: prozessweit und ohne Verfall: ein Neustart faehrt es einmal erneut (billig
#: und richtig), und wer den Ordner draussen loescht, bekommt ihn beim
#: naechsten Neustart zurueck — nicht frueher.
#: Schluessel ist (Kanal, Laufwerksadresse), nicht der Kanal allein: wechselt
#: der Ersteller seinen Freigabe-Link, ist der Ordner auf dem NEUEN Laufwerk
#: noch nicht da, und ein Cache nur nach Kanal-ID liesse jedes PUT dort
#: scheitern — bis zum Prozessneustart, mit endlos wiederholtem Nachtrag.
_ORDNER_ANGELEGT: set[tuple[int, str]] = set()


def ordner_zwischenspeicher_leeren() -> None:
    """Vergisst, welche Kanal-Ordner dieser Prozess schon angelegt hat.

    Nur fuer Tests: ohne das haengt ``_ORDNER_ANGELEGT`` an der Modul-Lebens-
    dauer, und ob ein Test ein MKCOL sieht, haenge daran, welcher Test die
    Kanal-Nummer zuerst benutzt hat.
    """
    _ORDNER_ANGELEGT.clear()


def ordner_pfad(channel_id: int) -> str:
    """Der Kanal-Ordner, relativ zum Konto-Laufwerk seines Erstellers."""
    return f"kanaele/{channel_id}"


def datei_name(nutzlast_id: int) -> str:
    return f"{nutzlast_id}.puls"


def datei_inhalt(n: DmNutzlast) -> bytes:
    """Derselbe Wire-Umschlag wie beim Abholen (``PostfachZustellungOut``),
    als JSON — damit ein Nachziehen aus dem Ordner denselben Parser
    benutzen kann wie das normale Abholen. IDs laufen als Strings ueber die
    Grenze (CLAUDE.md: Snowflake-IDs als Strings), ``daten`` bleibt
    unveraendertes Base64."""
    zustellung = PostfachZustellungOut.model_validate(n, from_attributes=True)
    return zustellung.model_dump_json().encode()


async def ablegen(session: AsyncSession, nutzlast: DmNutzlast) -> bool:
    """Legt ``nutzlast`` im Kanal-Ordner ab, falls der Kanal einer ist.

    ``False``, wenn der Kanal ueberhaupt kein Ordner-Kanal ist — der
    gewoehnliche Fall, kein Fehler. Ist er einer, aber fehlt dem Ersteller
    ein Konto-Laufwerk (abgehaengt oder nie gesetzt), wirft es
    ``AblageAbrufFehler("kein_laufwerk")`` — der Aufrufer entscheidet, ob
    daraus ein Nachtrag wird. Ein Nextcloud-Ausfall waehrend des Schreibens
    wirft ``AblageAbrufFehler`` aus ``ablage_schreiben`` unveraendert durch.

    Das MKCOL laeuft je Kanal nur beim ersten Mal in diesem Prozess
    (``_ORDNER_ANGELEGT``) — und nur, wenn es geklappt hat: ein
    fehlgeschlagenes Anlegen darf sich nicht als „schon da" merken.
    """
    ordner_zeile = await session.get(AblageKanalOrdner, nutzlast.channel_id)
    if ordner_zeile is None:
        return False

    laufwerk = await session.get(AblageKontoLaufwerk, ordner_zeile.ersteller_id)
    if laufwerk is None:
        raise AblageAbrufFehler("kein_laufwerk")

    pfad = ordner_pfad(nutzlast.channel_id)
    marke = (nutzlast.channel_id, laufwerk.freigabe_adresse)
    if marke not in _ORDNER_ANGELEGT:
        await ordner_anlegen_am_laufwerk(basis=laufwerk.freigabe_adresse, pfad=pfad)
        _ORDNER_ANGELEGT.add(marke)
    await schreibe_aufs_laufwerk(
        basis=laufwerk.freigabe_adresse,
        pfad=f"{pfad}/{datei_name(nutzlast.id)}",
        inhalt=datei_inhalt(nutzlast),
    )
    return True


async def _aufgabe_ist_gegenstandslos(session: AsyncSession, zeile: AblageKanalNachtrag) -> bool:
    """Ob dieser Nachtrag nie mehr gelingen KANN — dann wird er aufgegeben
    statt bei jedem Lauf erneut probiert.

    Zwei solche Faelle, beide dauerhaft: der Kanal ist kein Ordner-Kanal mehr
    (die ``AblageKanalOrdner``-Zeile ist weg), oder sein Ersteller hat kein
    Konto-Laufwerk mehr. Ein Netzfehler gehoert ausdruecklich NICHT dazu —
    der bleibt liegen und wird wiederholt.
    """
    ordner_zeile = await session.get(AblageKanalOrdner, zeile.channel_id)
    if ordner_zeile is None:
        return True
    return await session.get(AblageKontoLaufwerk, ordner_zeile.ersteller_id) is None


async def nachtrag_sweep(session: AsyncSession) -> tuple[int, int]:
    """Holt liegen gebliebene Nachtraege nach — hoechstens ``_NACHTRAG_BATCH``
    je Lauf, mit einem Commit JE ZEILE.

    Gibt ``(erledigt, aufgegeben)`` zurueck:

    * **erledigt** — geschrieben (oder die Nutzlast war inzwischen verfallen,
      dann ist der Nachtrag gegenstandslos) und die Zeile geloescht.
    * **aufgegeben** — geloescht, ohne je geschrieben worden zu sein: der
      Kanal ist kein Ordner-Kanal mehr oder sein Ersteller hat sein
      Konto-Laufwerk abgehaengt. Ohne diese Unterscheidung bliebe so eine
      Zeile fuer immer stehen und verbraeuchte in JEDEM Lauf einen Platz im
      Stapel — ein einziger abgehaengter Ersteller wuerde die Nachtraege
      aller anderen aushungern.

    Eine Zeile, die an einem Netzfehler scheitert, bleibt fuer den naechsten
    Lauf stehen. Der Commit je Zeile ist kein Stil, sondern Absicht: ein
    Fehler in Zeile 50 darf die 49 bereits geschriebenen Dateien nicht
    wieder als „noch offen" markieren.
    """
    zeilen = (
        await session.execute(select(AblageKanalNachtrag).limit(_NACHTRAG_BATCH))
    ).scalars().all()
    erledigt = 0
    aufgegeben = 0
    for zeile in zeilen:
        nutzlast = await session.get(DmNutzlast, zeile.nutzlast_id)
        if nutzlast is None:
            # Die Nutzlast ist inzwischen verfallen (Postfach-Pflege) — der
            # Nachtrag ist damit gegenstandslos, nicht mehr nachholbar.
            await session.delete(zeile)
            await session.commit()
            erledigt += 1
            continue
        if await _aufgabe_ist_gegenstandslos(session, zeile):
            await session.delete(zeile)
            await session.commit()
            aufgegeben += 1
            continue
        try:
            await ablegen(session, nutzlast)
        except AblageAbrufFehler:
            continue
        await session.delete(zeile)
        await session.commit()
        erledigt += 1
    return erledigt, aufgegeben


async def _nachtrag_vormerken(session: AsyncSession, nutzlast_id: int, channel_id: int) -> None:
    """Legt die Nachtrag-Zeile an, falls sie noch nicht existiert. Der
    Existenz-Check ist kein Schmuck: ``nutzlast_id`` ist der Primaerschluessel,
    ein zweiter Versuch fuer dieselbe Nutzlast liefe sonst in einen
    Integritaetsfehler."""
    if await session.get(AblageKanalNachtrag, nutzlast_id) is not None:
        return
    session.add(AblageKanalNachtrag(nutzlast_id=nutzlast_id, channel_id=channel_id))
    await session.commit()


async def festigung_nachlaufen(
    nutzlast_ids: Sequence[int],
    *,
    ableger: Callable[[AsyncSession, DmNutzlast], Awaitable[bool]],
) -> None:
    """Legt die genannten Nutzlasten im Kanal-Ordner ab — NACH der Antwort
    von ``POST /postfach``, als FastAPI-``BackgroundTask``.

    ``ableger`` kommt als Parameter (nicht der modulweite Name ``ablegen``),
    damit ``routes/postfach.py`` seinen eigenen, test-patchbaren Namen
    ``ablegen_im_ordner`` durchreichen kann.

    **Wirft nie.** JEDER Fehler — nicht nur ``AblageAbrufFehler``, auch ein
    Programmfehler im Ableger — wird zu einer Nachtrag-Zeile und einer
    Warnung mit Fehlerklasse und -code. Ein Wurf hier wuerde in Starlette
    NACH der bereits gesendeten Antwort aus dem ASGI-Aufruf herausfallen; der
    Umschlag ist zu diesem Zeitpunkt zugestellt, es gibt nichts mehr zu
    melden ausser der fehlenden Festigung. Die Freigabe-Adresse steht in
    keiner dieser Zeilen.
    """
    if not nutzlast_ids:
        return
    async with SessionLocal() as session:
        for nutzlast_id in nutzlast_ids:
            channel_id: int | None = None
            try:
                nutzlast = await session.get(DmNutzlast, nutzlast_id)
                if nutzlast is None:
                    # Zwischen Commit und Hintergrundlauf verfallen/geloescht
                    # — nichts mehr abzulegen, kein Nachtrag noetig.
                    continue
                channel_id = nutzlast.channel_id
                await ableger(session, nutzlast)
            except Exception as fehler:  # noqa: BLE001
                log.warning(
                    "ablage_kanal_festigung_fehlgeschlagen nutzlast=%s klasse=%s code=%s",
                    nutzlast_id,
                    type(fehler).__name__,
                    getattr(fehler, "code", None),
                )
                # Die Session kann nach einem DB-seitigen Fehler unbrauchbar
                # sein — zuruecksetzen, BEVOR der Nachtrag geschrieben wird.
                # Auch das Zuruecksetzen selbst darf die Hintergrundaufgabe
                # nicht verlassen: die Antwort ist laengst draussen, ein Wurf
                # hier landet nur im Log des Workers.
                if not await _still_zuruecksetzen(session, nutzlast_id):
                    continue
                if channel_id is not None:
                    try:
                        await _nachtrag_vormerken(session, nutzlast_id, channel_id)
                    except Exception:  # noqa: BLE001
                        log.warning(
                            "ablage_kanal_nachtrag_nicht_schreibbar nutzlast=%s", nutzlast_id
                        )
                        await _still_zuruecksetzen(session, nutzlast_id)


async def _still_zuruecksetzen(session: AsyncSession, nutzlast_id: int) -> bool:
    """Rollback, der nie wirft — ``False``, wenn die Session verloren ist."""
    try:
        await session.rollback()
    except Exception:  # noqa: BLE001
        log.warning("ablage_kanal_session_verloren nutzlast=%s", nutzlast_id)
        return False
    return True


__all__ = [
    "ordner_pfad",
    "datei_name",
    "datei_inhalt",
    "ablegen",
    "nachtrag_sweep",
    "festigung_nachlaufen",
    "ordner_zwischenspeicher_leeren",
]
