"""Welches GERAET eines Kontos handelt hier — und gehoert es diesem Konto?

Bis zum 2026-08-30 leistete das ein cloud-signiertes Identitaets-Zertifikat
plus eine Unterschrift ueber eine zweckgebundene Nutzlast. Beides ist mit den
Zertifikaten selbst entfallen (Spec §3b): **das Zertifikat hat eine Arbeit
geleistet, die die Anmeldung schon leistet.** Ein Schluesselbuendel wird immer
nur ins EIGENE Konto geschrieben, und welches das ist, sagt die Sitzung
bereits.

Uebrig bleiben zwei Fragen, und beide beantwortet diese Datei:

1. **Welches Konto?** — steht in ``CurrentUser``, kommt aus dem Bearer.
2. **Welches Geraet?** — behauptet der Aufrufer im Anfrage-Rumpf, und der
   Riegel dagegen ist ein Nachschlagen in ``DeviceKeyBundle`` ueber
   ``(user_id, device_pubkey)``: die Kennung muss zu einem Geraet DIESES
   Kontos gehoeren.

**Diese Datei ist die EINZIGE Stelle, an der geprueft wird, ob ein Geraet
fuer ein Konto handeln darf.** Fail-closed: ein unbekanntes Geraet ergibt
403, mit einer Meldung, die sagt WAS fehlgeschlagen ist, nie WELCHER
Schluessel beteiligt war (kein Schluesselmaterial in Fehlermeldungen oder
Logs).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import exists, select, update

from dcc_chat_gateway.models import DeviceKeyBundle
from dcc_chat_gateway.schluessel_verfall import stempel_ausdruck
from dcc_chat_gateway.security import AuthenticatedUser

#: Aufloesung fuer ``zuletzt_benutzt`` — ein Schreibzugriff pro Geraet und
#: Stunde statt einer bei JEDEM Geraete-Nachweis. ``pruefe_geraet`` laeuft
#: auch am Postfach-Abholzyklus (Klient pollt), ein Schreibzugriff je Aufruf
#: waere dort unnoetige Last. Eine Stunde ist grob genug, um die Last klein
#: zu halten, und fein genug fuer beide Verbraucher: die Verdraengung bei
#: ``schluessel_max_buendel_je_konto`` Geraeten entscheidet zwischen Geraeten,
#: die sich um Tage bis Wochen unterscheiden, und der 14-Tage-Ablauf
#: gekoppelter Browser (Spec §3a) misst in Tagen — eine Stunde Unschaerfe
#: faellt in beiden Faellen nicht ins Gewicht.
_ZULETZT_BENUTZT_AUFLOESUNG = timedelta(hours=1)


async def _zuletzt_benutzt_auffrischen(session, user_id: int, device_pubkey: str) -> None:
    """Setzt ``zuletzt_benutzt`` auf jetzt — aber nur, wenn der bisherige Wert
    laenger als ``_ZULETZT_BENUTZT_AUFLOESUNG`` zurueckliegt.

    Eine bedingte ``UPDATE``-Anweisung statt Lesen-dann-Schreiben: bei einem
    frisch benutzten Geraet (der haeufige Fall, z. B. Postfach-Polling)
    matcht die WHERE-Bedingung nicht, es wird ueberhaupt nichts geschrieben.
    Kein Fehler, wenn keine Zeile existiert (s. Docstring von
    ``pruefe_geraet``) — die Anweisung betrifft dann schlicht null Zeilen.

    Setzt ausserdem den Verfalls-Grabstein, falls das Geraet ueberfaellig war
    (Spec §3a) — in DERSELBEN Anweisung, als ``CASE`` ueber den alten Wert von
    ``zuletzt_benutzt``. Die Reihenfolge „erst stempeln, dann auffrischen" ist
    damit nicht bloss eingehalten, sondern unmoeglich zu verletzen, und der
    haeufige Pfad (Postfach-Polling) kostet weiterhin genau eine Runde zur
    Datenbank. Begruendung im Ganzen: ``schluessel_verfall.py::stempel_ausdruck``.

    Dass die 14-Tage-Bedingung des Stempels die 1-Stunden-Bedingung der
    Auffrischung IMPLIZIERT, ist die Voraussetzung dafuer, dass beide unter
    dieselbe WHERE-Klausel passen — wer eine der beiden Fristen aendert,
    prueft das nach.

    Committet NUR, wenn tatsaechlich eine Zeile getroffen wurde — einige
    Aufrufer sind lesende Routen (z. B. ``kopplung_stand``), die selbst nie
    committen; ohne einen eigenen Commit hier ginge die Auffrischung dort mit
    dem Sessionende (Rollback) verloren. Ein leerer Treffer committet nichts,
    das ist der haeufige Fall und der Sinn der groben Aufloesung.

    **Bedingung, unter der dieser Commit unbedenklich ist — beim Hinzufuegen
    eines Aufrufers pruefen:** ``pruefe_geraet`` laeuft in allen heutigen
    Routen VOR jedem ``session.add``, es steht also nichts Ungespeichertes an,
    das hier versehentlich mit festgeschrieben wuerde. Nachgesehen am
    2026-08-30 fuer alle dreizehn Aufrufer. Wer ``pruefe_geraet`` kuenftig
    NACH eigenen Schreibzugriffen ruft, macht diesen Commit zu einem
    Teil-Commit seiner eigenen Arbeit — und der faellt erst auf, wenn die
    Route danach fehlschlaegt und die Haelfte trotzdem stehenbleibt."""
    jetzt = datetime.now(UTC)
    schwelle = jetzt - _ZULETZT_BENUTZT_AUFLOESUNG
    ergebnis = await session.execute(
        update(DeviceKeyBundle)
        .where(
            DeviceKeyBundle.user_id == user_id,
            DeviceKeyBundle.device_pubkey == device_pubkey,
            DeviceKeyBundle.zuletzt_benutzt < schwelle,
        )
        .values(verfallen_am=stempel_ausdruck(jetzt), zuletzt_benutzt=jetzt)
    )
    if ergebnis.rowcount:
        await session.commit()


async def pruefe_geraet(
    session,
    user: AuthenticatedUser,
    device_pubkey: str,
    *,
    noch_ohne_buendel: bool = False,
) -> str:
    """Bestaetigt, dass ``device_pubkey`` ein Geraet DIESES Kontos bezeichnet,
    und gibt die Kennung zurueck.

    Der Rueckgabewert ist dieselbe Zeichenkette, die hereinkam — er existiert,
    damit an der Aufrufstelle sichtbar bleibt, dass der GEPRUEFTE Wert
    weiterverwendet wird und nicht ein zweites Mal aus dem Rumpf gelesener.

    ``noch_ohne_buendel=True`` hebt die Nachschlage-Bedingung auf. Genau zwei
    Routen brauchen das, beide weil die Zeile in DIESEM Augenblick noch gar
    nicht existieren kann (Begruendung an der jeweiligen Aufrufstelle):
    ``PUT /keys/bundle`` legt sie selbst an, und ``POST /kopplung/einloesen``
    laeuft im Klienten VOR der ersten Veroeffentlichung. Ueberall sonst ist
    die Bedingung scharf.

    Bei Erfolg wird zusaetzlich ``DeviceKeyBundle.zuletzt_benutzt`` fuer das
    Geraet aufgefrischt (grob aufgeloest, s. ``_ZULETZT_BENUTZT_AUFLOESUNG``
    oben) — diese Funktion ist die einzige Stelle, an der ein Geraet sich
    ueberhaupt zu erkennen gibt, also der einzige richtige Ort fuer das Signal
    "lebt noch". Fehlt die Zeile (die beiden Ausnahmen oben), ist das ein
    stilles No-Op — sie bekommt ihren Startwert ueber ``server_default`` beim
    Anlegen.

    ===================================================================
    WAS GEGENUEBER DEM ZERTIFIKAT VERLORENGEHT — hier, weil hier die Ursache
    liegt
    ===================================================================
    Das Zertifikat plus Unterschrift bewies, dass der Aufrufer dieses Geraet
    **IST** (Besitz des privaten Geraeteschluessels). Die Nachschlage-Bedingung
    unten beweist nur, dass das Geraet **zum selben Konto gehoert**.

    Der Unterschied wird beim Abholen des Postfachs zur Einbusse: wer eine
    Kontositzung uebernimmt, kann seither die offenen Umschlaege **aller**
    Geraete des Kontos abholen und quittieren, nicht mehr nur die eines
    einzigen. Dasselbe gilt fuer ``POST /postfach/anhaenge/{id}/abrufadresse``
    und fuer die Kopplungs-Rollen (``alt``/``neu``).

    Das ist bewusst hingenommen (Spec §3b): entschluesseln kann der
    Uebernehmende die Umschlaege trotzdem nicht — die privaten Olm-Schluessel
    liegen im jeweiligen Geraet, nicht am Server. Er kann sie dem
    rechtmaessigen Geraet aber **wegquittieren**. Dagegen steht seit dem
    2026-08-30 die Geraeteliste mit „entfernen" (``geraete_widerruf.py``,
    ``routes/geraete.py``): sie ist die Stelle, an der ein Nutzer das bemerken
    und beenden kann — und ihr Riegel sitzt in DIESER Funktion, s. den
    Kommentar an der ``exists``-Bedingung unten.
    """
    if not noch_ohne_buendel:
        gehoert_dem_konto = (
            await session.execute(
                select(
                    exists().where(
                        DeviceKeyBundle.user_id == user.id,
                        DeviceKeyBundle.device_pubkey == device_pubkey,
                        # Ein entferntes Geraet gehoert dem Konto nicht mehr
                        # (Spec §3b Punkt 4). **Diese eine Zeile ist der
                        # ganze Widerruf auf der Handlungsseite**: sie sperrt
                        # in einem Zug Postfach-Abholen und -Quittieren,
                        # Anhaenge-Abrufadressen, das Nachlegen von
                        # Einmalschluesseln und das Anlegen eines
                        # Kopplungscodes — jede Route also, die ueber diese
                        # Funktion geht. Die Empfaengerseite sperrt daneben
                        # ``geraete_widerruf.py::darf_empfangen``.
                        #
                        # NICHT betroffen sind die beiden Aufrufer mit
                        # ``noch_ohne_buendel=True``, und das ist gewollt:
                        # ``POST /kopplung/einloesen`` ist der Weg zurueck
                        # (es hebt den Grabstein auf), und ``PUT
                        # /keys/bundle`` muss unbekannte Kennungen zulassen —
                        # es laesst den Grabstein aber stehen, s. dort.
                        DeviceKeyBundle.entfernt_am.is_(None),
                    )
                )
            )
        ).scalar_one()
        if not gehoert_dem_konto:
            raise HTTPException(
                status_code=403, detail="Geraet gehoert nicht zum angemeldeten Konto"
            )

    await _zuletzt_benutzt_auffrischen(session, user.id, device_pubkey)
    return device_pubkey


async def geraet_gehoert_fremdem_konto(session, user_id: int, device_pubkey: str) -> bool:
    """Fuehrt ein ANDERES Konto dieselbe Geraetekennung?

    Nur ``PUT /keys/bundle`` fragt das, und nur beim Anlegen einer neuen
    Zeile — Begruendung dort. Ein reiner Existenz-Ausdruck statt eines
    ``SELECT``: es interessiert nur das Bit, nie welches Konto.
    """
    return (
        await session.execute(
            select(
                exists().where(
                    DeviceKeyBundle.device_pubkey == device_pubkey,
                    DeviceKeyBundle.user_id != user_id,
                )
            )
        )
    ).scalar_one()
