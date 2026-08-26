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

Das erste Merkmal ist: **wurde der Nachfolger jemals eingeloest?** Nie
eingeloest heisst, dass ihn niemand hatte — dann kann er nur unterwegs verloren
gegangen sein. Es reicht allein aber NICHT; das zweite Merkmal steht weiter
unten.

Warum nicht einfach eine Gnadenfrist
------------------------------------
Naheliegend waere „ein gerade rotierter Token darf ein paar Sekunden lang noch
einmal kommen". Das trifft aber genau den Fall nicht, um den es geht: die
gemessenen Vorfaelle lagen 6 bis 15 Minuten nach dem verlorenen Tausch (der
Rechner schlief dazwischen), ueber Nacht waeren es Stunden. Jede Frist, die
diese Faelle abdeckt, ist so lang, dass sie als Sicherheitsgrenze nichts mehr
aussagt — und jede Frist, die als Grenze etwas aussagt, deckt die Faelle nicht
ab. Die Grenze liegt deshalb nicht auf der Uhr, sondern auf der Anzahl
(s. unten): sie zaehlt, was tatsaechlich passiert ist, statt zu raten, wie
lange ein Rechner schlaeft.

Was dabei NICHT nachlaesst
--------------------------
Ein Dieb, der einen abgegriffenen Token vorlegt, bevor der rechtmaessige Klient
seinen Nachfolger benutzt hat, bekommt denselben Nachfolger ausgehaendigt — den
der Klient ebenfalls hat.

**Die Nachfolger-Frage allein faengt das nicht.** Am 2026-08-26 nachgemessen:
laeuft der Dieb einfach mit, liegt er nie zwei Schritte zurueck, bekommt in
jeder Runde denselben Nachfolger nachgereicht und wird NIE erkannt; und wer
immer nur denselben alten Token vorlegt, bekommt beliebig oft ein frisches
Zugriffstoken, waehrend jede Rotation den Ablauf um weitere 30 Tage schiebt.
Ein frueherer Stand dieses Kopfes behauptete das Gegenteil („verzoegert, nicht
aufgehoben") — er war falsch.

Die Grenze zieht deshalb {@link NACHREICH_LIMIT}: Nachreichen ist Kulanz mit
Kontingent, kein Dauerzustand. Beide Faelle enden dort, der erste nach wenigen
Rotationszyklen, der zweite nach wenigen Sekunden.

Ganz aufheben laesst sich der Handel nicht: der Server kann „die Antwort ging
verloren" nicht von „eine zweite Partei hat den Ausweis" unterscheiden — beide
sehen identisch aus. Wer heilt, oeffnet dasselbe Fenster fuer beide; die einzige
Stellschraube ist, wie weit.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import NamedTuple

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_auth.models import RefreshToken

log = logging.getLogger(__name__)

#: Wie oft in EINER Anmelde-Kette nachgereicht werden darf, bevor die naechste
#: Vorlage als Verdacht gilt.
#:
#: Ohne Deckel ist die Erkennung nicht verzoegert, sondern aufgehoben — beides
#: am 2026-08-26 nachgemessen: wer den Ausweis abgegriffen hat und einfach
#: mitpollt, liegt nie zwei Schritte zurueck, bekommt in jeder Runde denselben
#: Nachfolger nachgereicht und laeuft nie auseinander; und wer immer nur
#: denselben alten Token vorlegt, bekommt beliebig oft ein frisches
#: Zugriffstoken. Jede Rotation schiebt dabei den Ablauf um weitere 30 Tage.
#:
#: Der Zaehler haengt an der KETTE, nicht an der Zeile: der mitlaufende Fall
#: betrifft in jeder Runde eine andere Zeile und umginge einen Zeilen-Zaehler
#: vollstaendig. Und er wird bei einer gesunden Rotation NICHT zurueckgesetzt —
#: im mitlaufenden Fall dreht das Opfer jede Runde regulaer weiter, ein Reset
#: haette den Zaehler dauerhaft bei null gehalten.
#:
#: Drei, weil ein abgerissener Rundlauf pro Ruhezustand genau EINE Nachreichung
#: kostet: zwei Reserve fuer eine unruhige Leitung, und ein Mitlaeufer ist nach
#: drei Rotationszyklen (bei 15 Minuten Takt also unter einer Stunde) draussen
#: statt nie. Wer den Deckel erreicht, verliert die Kette — genau das, was vor
#: dieser Aenderung schon beim ERSTEN abgerissenen Rundlauf geschah.
NACHREICH_LIMIT = 3


def _kurz(wert: object) -> str:
    """Erste acht Zeichen einer Kennung — genug, um zwei Zeilen im Protokoll
    einander zuzuordnen, zu wenig, um daraus einen Ausweis zu bauen."""
    return str(wert or "-")[:8]


class Befund(NamedTuple):
    """Was mit einem wiederholt vorgelegten Token geschehen soll — und warum.

    Grund und Handlung stehen zusammen, weil sie sonst an zwei Stellen
    entstuenden: die Handlung hier, die Benennung im Aufrufer. Genau so ist am
    2026-08-26 die erste Fassung schiefgegangen — sie leitete den Grund aus
    ``replaced_by`` her und nannte jede Abmeldung nach einer Rotation einen
    Diebstahlsverdacht.
    """

    #: Der nachzureichende Nachfolger, oder ``None`` — dann wird abgewiesen.
    nachfolger: RefreshToken | None
    #: Name der Meldung im Protokoll.
    ereignis: str


async def pruefe_wiedervorlage(
    session: AsyncSession, rt: RefreshToken, *, jetzt: datetime
) -> Befund:
    """Entscheiden, was eine wiederholte Vorlage bedeutet.

    Vier Ausgaenge, drei davon Abweisungen mit verschiedener Aussagekraft:

    * **nachreichen** — der Nachfolger lebt, wurde nie eingeloest und die Kette
      hat noch Kontingent. Der Rundlauf war abgerissen.
    * **``refresh_verdacht``** — der Nachfolger wurde seinerseits ROTIERT. Erst
      das belegt, dass ihn jemand hatte. Ein blosses ``replaced_by`` genuegt
      nicht: nach ``refresh`` + ``logout`` traegt die vorgelegte Zeile
      ebenfalls einen Nachfolger, der aber entwertet und nicht eingeloest wurde.
    * **``refresh_kontingent``** — {@link NACHREICH_LIMIT} erreicht. Die
      aussagekraeftigste Meldung dieses Dienstes: in EINER Kette wurde
      auffaellig oft nachgereicht, und genau so sieht ein Mitlaeufer aus.
    * **``refresh_abgewiesen``** — nie rotiert. Abmeldung, Sitzungsende,
      Kontosperre oder eine Zeile von vor Migration 0050. Ueber die ist
      tatsaechlich nichts bekannt, und eine Diebstahlswarnung, die zur Haelfte
      aus Abmeldungen besteht, waere beim Auswerten wertlos.

    Der Ablauf des Nachfolgers wird geprueft, obwohl er praktisch nicht
    eintreten kann: er wird nach seinem Vorgaenger ausgestellt und laeuft mit
    derselben Frist. Das gilt aber nur, solange ``jwt_refresh_ttl_seconds``
    zwischen beiden Ausgaben unveraendert bleibt — wird die Frist verkuerzt,
    reichten wir einen bereits abgelaufenen Ausweis heraus. Zwei Zeilen gegen
    eine Annahme, die niemand erzwingt.
    """
    if rt.replaced_by is None:
        return Befund(None, "refresh_abgewiesen")
    nachfolger = await session.get(RefreshToken, rt.replaced_by)
    if nachfolger is None:
        return Befund(None, "refresh_abgewiesen")
    if nachfolger.replaced_by is not None:
        return Befund(None, "refresh_verdacht")
    if nachfolger.revoked_at is not None:
        return Befund(None, "refresh_abgewiesen")
    if nachfolger.nachgereicht >= NACHREICH_LIMIT:
        return Befund(None, "refresh_kontingent")
    ablauf = nachfolger.expires_at
    if ablauf.tzinfo is None:
        ablauf = ablauf.replace(tzinfo=UTC)
    if ablauf <= jetzt:
        return Befund(None, "refresh_abgewiesen")
    return Befund(nachfolger, "refresh_nachgereicht")


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
    # ``rt`` ist in diesem Zweig immer widerrufen und damit nie in ``lebende``
    # (das filtert auf ``revoked_at IS NULL``) — angehaengt wird sie trotzdem
    # unbedingt, nicht bedingt: eine Bedingung, die nie falsch werden kann,
    # liest sich wie eine Vorsichtsmassnahme und ist keine.
    return [*lebende, rt]


def protokolliere_nachgereicht(
    rt: RefreshToken, *, jetzt: datetime, nachgereicht: int, ua_jetzt: str | None
) -> None:
    """Ein geheilter Fall — sichtbar, weil er sonst niemandem auffiele.

    Hier stehen BEIDE Browser-Kennungen, obwohl es der harmlose Zweig ist —
    gerade deshalb: es ist der einzige Weg, auf dem die Lockerung ueberhaupt
    etwas herausgibt. Ohne die Kennung der Anfrage liesse sich der Zeile nicht
    ansehen, ob dasselbe Geraet stolperte oder ein fremdes bedient wurde.
    ``nachgereicht`` zeigt, wie nah die Kette an ihrem Kontingent ist.

    Bewusst auf ``warning``: die Vorgabe fuer ``PULSE_LOG_LEVEL`` ist genau das
    (``dcc_shared/logging_setup.py``), die Cloud setzt nichts anderes, und eine
    ``info``-Zeile waere dort unsichtbar — dieselbe Falle, die ``owner_admin_log``
    29 Tage lang stumm geschaltet hat. Haeufigkeit ist kein Gegenargument: ueber
    alle Nutzer waren es zuletzt rund vier Faelle am Tag.
    """
    log.warning(
        "refresh_nachgereicht user=%s kette=%s rotiert_vor=%ss %d/%d "
        "ua_token=%r ua_anfrage=%r",
        rt.user_id,
        _kurz(rt.family_id),
        _sekunden_seit(rt.revoked_at, jetzt),
        nachgereicht,
        NACHREICH_LIMIT,
        (rt.user_agent or "")[:80],
        (ua_jetzt or "")[:80],
    )


def protokolliere_abweisung(
    rt: RefreshToken,
    *,
    jetzt: datetime,
    widerrufen: int,
    ua_jetzt: str | None,
    ereignis: str,
) -> None:
    """Eine abgewiesene Vorlage — und WELCHE der beiden es war.

    Nicht jede widerrufene Zeile wurde rotiert: ``/logout``, der Einzel-Widerruf
    unter ``/sessions`` und eine Kontosperre entwerten eine Zeile, ohne je einen
    Nachfolger anzulegen. Ein danach vorgelegter Token landet zwangslaeufig im
    selben Zweig wie eine echte Wiederverwendung — die Antwort ist in beiden
    Faellen dieselbe (401), die Meldung darf es nicht sein. Eine
    Diebstahlswarnung, die zur Haelfte aus gewoehnlichen Abmeldungen besteht,
    ist beim Auswerten wertlos.

    Welche der drei Meldungen es ist, entscheidet {@link pruefe_wiedervorlage} —
    dort steht auch, woran sie sich unterscheiden.

    ``rotiert_vor`` trennt „eben erst" von „aus einer alten Sitzung", und die
    beiden Kennzeichnungen des Browsers trennen „derselbe Klient stolpert" von
    „der Token taucht anderswo auf". Der Token selbst steht nie im Protokoll,
    auch nicht gekuerzt.
    """
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
