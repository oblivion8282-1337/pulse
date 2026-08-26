"""Was geschieht, wenn ein Refresh-Token ein zweites Mal vorgelegt wird.

Die Frage, an der alles haengt
------------------------------
Ein wiederholt vorgelegter Token hat zwei voellig verschiedene Ursachen, und bis
zum 2026-08-26 behandelte ``/refresh`` beide gleich — als Diebstahl.

* **Der Roundtrip brach ab.** Der Server hat rotiert, die Antwort erreichte den
  Klienten nie: der Rechner ging in den Ruhezustand, das Netz wechselte, der
  Browser fror den Tab ein. Der Klient kennt seinen Nachfolger nicht und legt
  zwangslaeufig wieder den alten Token vor. Das ist kein Angriff, sondern der
  Normalfall eines abgerissenen Aufrufs.
* **Zwei Parteien sind im Umlauf.** Jemand hat einen Token abgegriffen, und
  waehrend der eine damit weiterarbeitet, taucht der andere wieder auf.

Unterscheiden lassen sich die beiden an genau einem Merkmal: **wurde der
Nachfolger jemals eingeloest?** Nie eingeloest heisst, dass ihn niemand hatte —
dann kann er nur unterwegs verloren gegangen sein. Wurde er benutzt, sind
zwangslaeufig zwei Parteien im Spiel.

Warum nicht einfach eine Gnadenfrist
------------------------------------
Naheliegend waere „ein gerade rotierter Token darf ein paar Sekunden lang noch
einmal kommen". Das trifft aber genau den Fall nicht, um den es geht: die
gemessenen Vorfaelle lagen 6 bis 15 Minuten nach dem verlorenen Tausch (der
Rechner schlief dazwischen), ueber Nacht waeren es Stunden. Jede Frist, die
diese Faelle abdeckt, ist so lang, dass sie als Sicherheitsgrenze nichts mehr
aussagt — und jede Frist, die als Grenze etwas aussagt, deckt die Faelle nicht
ab. Die Frage nach dem Nachfolger braucht keine Zahl und beantwortet beides.

Was dabei NICHT nachlaesst
--------------------------
Ein Dieb, der einen abgegriffenen Token vorlegt, bevor der rechtmaessige Klient
seinen Nachfolger benutzt hat, bekommt denselben Nachfolger ausgehaendigt — den
der Klient ebenfalls hat. Sobald einer von beiden weiterdreht, ist der andere
der Fall „Nachfolger eingeloest", und die Kette stirbt. Die Erkennung ist damit
verzoegert, nicht aufgehoben; erkauft wird ein Nutzer, der nicht mehr grundlos
aus seiner Sitzung faellt.
"""

from __future__ import annotations

import logging
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_auth.models import RefreshToken

log = logging.getLogger(__name__)


def _kurz(wert: object) -> str:
    """Erste acht Zeichen einer Kennung — genug, um zwei Zeilen im Protokoll
    einander zuzuordnen, zu wenig, um daraus einen Ausweis zu bauen."""
    return str(wert or "-")[:8]


async def nachfolger_zum_nachreichen(
    session: AsyncSession, rt: RefreshToken
) -> RefreshToken | None:
    """Der Nachfolger dieses Tokens, falls er nachgereicht werden darf.

    ``None`` heisst: nicht nachreichbar — es gibt keinen Nachfolger, oder er
    wurde bereits eingeloest. Beides faellt in denselben Zweig, weil in beiden
    das Nachreichen nichts heilen wuerde.

    Auf Ablauf wird hier NICHT geprueft: der Nachfolger wird immer nach seinem
    Vorgaenger ausgestellt und laeuft mit derselben Frist, kann also nicht
    abgelaufen sein, solange der Vorgaenger es nicht ist — und den prueft
    ``routes.refresh`` bereits, bevor es hierher kommt.
    """
    if rt.replaced_by is None:
        return None
    nachfolger = await session.get(RefreshToken, rt.replaced_by)
    if nachfolger is None or nachfolger.revoked_at is not None:
        return None
    return nachfolger


async def widerrufe_kette(
    session: AsyncSession, rt: RefreshToken, *, jetzt: datetime
) -> list[RefreshToken]:
    """Alle noch lebenden Token DIESER Anmelde-Kette widerrufen.

    Frueher traf das jeden Token des Kontos. Die Reichweite ist der eigentliche
    Unterschied: ein Verdacht in einer Kette sagt nichts ueber die anderen
    Geraete desselben Nutzers aus, und sie mit abzumelden hat in 17 gemessenen
    Tagen mehr Sitzungen gekostet als je ein Diebstahl.

    Zeilen ohne Kettenkennung (``family_id IS NULL``) entstehen nur waehrend des
    Ausrollens von Migration 0050, solange der alte Code noch schreibt. Fuer sie
    gibt es keine Kette zum Absuchen — getroffen wird dann allein die vorgelegte
    Zeile.

    Zurueck kommt die vorgelegte Zeile **immer**, auch wenn ihr ``revoked_at``
    schon steht und hier nichts mehr zu widerrufen ist: der Aufrufer haengt an
    dieser Liste die Cookies auf, und das Cookie DIESER Anmeldung muss beim
    Verdacht sterben. Ohne sie ueberlebte es in genau dem Fall, in dem die Kette
    leer ist — mitsamt dem Recht, sich ein Geraete-Zertifikat auszustellen.
    ``revoke_sessions`` ist gegen Doppelnennung unempfindlich (es filtert auf
    ``revoked_at IS NULL``), eine Ueberschneidung kostet also nichts.
    """
    lebende = (
        []
        if rt.family_id is None
        else list(
            (
                await session.execute(
                    select(RefreshToken).where(
                        RefreshToken.family_id == rt.family_id,
                        RefreshToken.revoked_at.is_(None),
                    )
                )
            )
            .scalars()
            .all()
        )
    )
    for zeile in lebende:
        # Der Zeitstempel der vorgelegten Zeile bleibt unangetastet — er gehoert
        # zu ihrer Rotation und ist die Spur, an der spaeter der Abstand zum
        # Vorfall abgelesen wird.
        zeile.revoked_at = jetzt
    return [*lebende, rt] if rt not in lebende else lebende


def protokolliere_nachgereicht(rt: RefreshToken, *, jetzt: datetime) -> None:
    """Ein geheilter Fall — sichtbar, weil er sonst niemandem auffiele.

    Bewusst auf ``warning``: die Vorgabe fuer ``PULSE_LOG_LEVEL`` ist genau das
    (``dcc_shared/logging_setup.py``), die Cloud setzt nichts anderes, und eine
    ``info``-Zeile waere dort unsichtbar — dieselbe Falle, die ``owner_admin_log``
    29 Tage lang stumm geschaltet hat. Haeufigkeit ist kein Gegenargument: ueber
    alle Nutzer waren es zuletzt rund vier Faelle am Tag.
    """
    log.warning(
        "refresh_nachgereicht user=%s kette=%s rotiert_vor=%ss ua=%r",
        rt.user_id,
        _kurz(rt.family_id),
        _sekunden_seit(rt.revoked_at, jetzt),
        (rt.user_agent or "")[:80],
    )


def protokolliere_abweisung(
    rt: RefreshToken, *, jetzt: datetime, widerrufen: int, ua_jetzt: str | None
) -> None:
    """Eine abgewiesene Vorlage — und WELCHE der beiden es war.

    Nicht jede widerrufene Zeile wurde rotiert: ``/logout``, der Einzel-Widerruf
    unter ``/sessions`` und eine Kontosperre entwerten eine Zeile, ohne je einen
    Nachfolger anzulegen. Ein danach vorgelegter Token landet zwangslaeufig im
    selben Zweig wie eine echte Wiederverwendung — die Antwort ist in beiden
    Faellen dieselbe (401), die Meldung darf es nicht sein. Eine
    Diebstahlswarnung, die zur Haelfte aus gewoehnlichen Abmeldungen besteht,
    ist beim Auswerten wertlos.

    Unterschieden wird an ``replaced_by``: nur eine Rotation legt ihn an.
    Zeilen aus der Zeit vor Migration 0050 haben ihn ebenfalls nicht und fallen
    deshalb in dieselbe, vorsichtigere Meldung — richtig so, denn ueber sie ist
    tatsaechlich nichts bekannt.

    ``rotiert_vor`` trennt „eben erst" von „aus einer alten Sitzung", und die
    beiden Kennzeichnungen des Browsers trennen „derselbe Klient stolpert" von
    „der Token taucht anderswo auf". Der Token selbst steht nie im Protokoll,
    auch nicht gekuerzt.
    """
    ereignis = "refresh_verdacht" if rt.replaced_by is not None else "refresh_abgewiesen"
    log.warning(
        "%s user=%s kette=%s widerrufen_vor=%ss betroffen=%d "
        "ua_token=%r ua_anfrage=%r",
        ereignis,
        rt.user_id,
        _kurz(rt.family_id),
        _sekunden_seit(rt.revoked_at, jetzt),
        widerrufen,
        (rt.user_agent or "")[:80],
        (ua_jetzt or "")[:80],
    )


def _sekunden_seit(zeitpunkt: datetime | None, jetzt: datetime) -> int | None:
    """Ganze Sekunden zwischen den beiden — oder ``None``, wenn es keinen
    Zeitpunkt gibt. SQLite liefert zeitzonenlose Werte; die werden als UTC
    gelesen, wie ueberall sonst in diesem Dienst auch."""
    if zeitpunkt is None:
        return None
    if zeitpunkt.tzinfo is None:
        zeitpunkt = zeitpunkt.replace(tzinfo=jetzt.tzinfo)
    return int((jetzt - zeitpunkt).total_seconds())
