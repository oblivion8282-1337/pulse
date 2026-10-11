"""Wann klingelt wessen Telefon — der Push-Teil des Anruf-Wegs (Punkt 40).

Getrennt von :mod:`dcc_chat_gateway.apns_voip`, und die Naht ist inhaltlich:
dort steht, WIE man mit APNs spricht (JWT, Kopfzeilen, Statusdeutung), hier,
WANN wer einen Push bekommt.

**Alles fail-open.** Fehlender Schlüssel, toter Token, Störung bei Apple oder
Redis: der Anruf läuft wie bisher über die WebSocket weiter. Ein Push ist die
Zugabe für den, der gerade keine offene Verbindung hat.

**Die eine Regel von Apple, an der hier alles hängt:** jeder VoIP-Push
verpflichtet die App, einen Anruf an CallKit zu melden. Tut sie das nicht,
beendet iOS sie, und bei Wiederholung stellt es die VoIP-Pushes für die App
ganz ab — dann klingelt bei geschlossener App gar nichts mehr. Ein Push, auf
den die Hülle keinen Anruf melden kann, ist deshalb nicht harmlos, sondern
der teuerste Push überhaupt. Bis zum 2026-10-11 ging der Abbruch an JEDEN
Teilnehmer — auch an den Anrufer, dessen Telefon nie geklingelt hatte, und
an das Gerät, das gerade selbst aufgelegt hatte (Bughunt 2026-10-11, K3).

Daraus folgen die zwei Hälften dieses Moduls:

* **Klingeln geht an JEDES iOS-Gerät der Gerufenen** — ohne Frische-Prüfung
  der WebSocket. Bis zum 2026-10-11 wurde ein Telefon mit einer Verbindung,
  die in den letzten 40 s etwas gesagt hatte, übersprungen; ein eben
  weggestecktes Telefon galt damit als wach, sein eingefrorenes JS verarbeitete
  das ``call_klingelt`` aber nie, und der Anruf war verpasst (T14). Ein
  zusätzlicher Push an ein waches Telefon kostet nichts: die Hülle kennt den
  Anruf dann schon (die WebSocket hat ihn über ``ankommen`` gemeldet) und
  meldet keinen zweiten Bildschirm.
* **Der Abbruch geht nur an Geräte, die per Push geklingelt haben** — und an
  keins davon zweimal. Welche das waren, steht je Anruf in Redis
  (:func:`klingeln` schreibt, :func:`abbrechen` liest und trägt aus). Wer
  nicht geklingelt hat, bekommt keinen Abbruch; wer selbst gehandelt hat
  (``ausser``), auch nicht — sein Anruf ist dort schon zu.

**Gesendet wird im Hintergrund** (Bughunt T17): ein APNs-Rundlauf dauert, und
bis zum 2026-10-11 hing er im Anfragepfad von ``POST /anrufe`` — solange
kannte der Anrufer die Anruf-Kennung nicht. Die Klingel- und Abbruch-Sendungen
eines Anrufs laufen dabei der Reihe nach (:func:`_im_hintergrund`), damit ein
schneller Abbruch nicht vor seinem Klingeln bei Apple ankommt.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Coroutine
from dataclasses import dataclass
from typing import Any

from sqlalchemy import delete, select

from dcc_chat_gateway import apns_voip
from dcc_chat_gateway.config import get_settings
from dcc_chat_gateway.models import VoipToken

log = logging.getLogger("dcc_chat_gateway.anruf_push")

#: Je Anruf: welches Gerät per Push geklingelt hat (Redis-Hash, Feld = Token,
#: Wert = ``"<user_id>|<geraet_id>"``).
GEKLINGELT_PRAEFIX = "anruf:voip:geklingelt:"

#: So lange bleibt der Merker stehen. Er muss das GESPRÄCH überdauern, nicht
#: nur das Klingeln: das Gerät, das angenommen hat, bekommt seinen Abbruch erst
#: beim Ende — falls seine Oberfläche dann eingefroren ist, ist das der einzige
#: Weg, der den CallKit-Anruf dort schliesst.
GEKLINGELT_HALTBARKEIT_S = 12 * 60 * 60


@dataclass(frozen=True)
class Geraet:
    """Ein iOS-Gerät, das einen Push bekommen kann."""

    user_id: int
    geraet_id: str
    token: str

    @property
    def kennung(self) -> tuple[int, str]:
        """``(user_id, geraet_id)`` — die Form, in der ``ausser`` ein Gerät nennt."""
        return (self.user_id, self.geraet_id)


def schluessel(call_id: str) -> str:
    return f"{GEKLINGELT_PRAEFIX}{call_id}"


def auswaehlen(
    geklingelt: list[Geraet],
    *,
    nur_konten: set[int] | None = None,
    ausser: tuple[int, str] | None = None,
) -> list[Geraet]:
    """Welche der geklingelten Geräte einen Abbruch bekommen.

    ``nur_konten``: nur Geräte dieser Konten (Gruppenanruf — ein Mitglied, das
    annimmt oder ablehnt, beendet nur das Klingeln SEINER Geräte; die übrigen
    Mitglieder dürfen weiter beitreten). ``ausser``: das handelnde Gerät
    selbst, ``(user_id, geraet_id)`` — dort ist der Anruf schon zu, und ein
    Push dorthin fände keinen Anruf mehr, den die Hülle melden könnte. Ohne
    ``ausser`` gilt kein Gerät als handelnd.

    Rein und ohne Zugriff nach aussen, damit die Regel ohne Redis und ohne
    Apple prüfbar ist.
    """
    return [
        g
        for g in geklingelt
        if (nur_konten is None or g.user_id in nur_konten) and g.kennung != ausser
    ]


def _als_text(wert: Any) -> str:
    return wert.decode() if isinstance(wert, bytes) else str(wert)


async def _merken(redis: Any, call_id: str, geraete: list[Geraet]) -> None:
    if redis is None or not geraete:
        return
    try:
        key = schluessel(call_id)
        await redis.hset(key, mapping={g.token: f"{g.user_id}|{g.geraet_id}" for g in geraete})
        await redis.expire(key, GEKLINGELT_HALTBARKEIT_S)
    except Exception:  # noqa: BLE001 — fail-open, s. Modulkopf
        log.warning("anruf_voip_merken_fehlgeschlagen")


async def _geklingelt(redis: Any, call_id: str) -> list[Geraet]:
    if redis is None:
        return []
    try:
        roh = await redis.hgetall(schluessel(call_id))
    except Exception:  # noqa: BLE001
        log.warning("anruf_voip_lesen_fehlgeschlagen")
        return []
    geraete: list[Geraet] = []
    for token, wert in roh.items():
        uid, _, gid = _als_text(wert).partition("|")
        try:
            user_id = int(uid)
        except ValueError:
            continue
        geraete.append(Geraet(user_id=user_id, geraet_id=gid, token=_als_text(token)))
    return geraete


async def _austragen(redis: Any, call_id: str, geraete: list[Geraet]) -> None:
    if redis is None or not geraete:
        return
    try:
        await redis.hdel(schluessel(call_id), *[g.token for g in geraete])
    except Exception:  # noqa: BLE001
        log.warning("anruf_voip_austragen_fehlgeschlagen")


# MARK: - Hintergrund

#: Laufende Sendungen je Anruf — die nächste wartet auf die vorige.
_letzte_je_anruf: dict[str, asyncio.Task[None]] = {}
#: Starke Verweise auf alle laufenden Sendungen. Ohne sie darf der
#: Ereignis-Loop eine Aufgabe mitten im Lauf einsammeln.
_laufend: set[asyncio.Task[None]] = set()


def _im_hintergrund(call_id: str, arbeit: Coroutine[Any, Any, None]) -> None:
    """``arbeit`` im Hintergrund starten — erst, wenn die vorige Sendung
    desselben Anrufs durch ist (s. Modulkopf)."""
    vorher = _letzte_je_anruf.get(call_id)

    async def kette() -> None:
        if vorher is not None:
            await asyncio.gather(vorher, return_exceptions=True)
        try:
            await arbeit
        except Exception:  # noqa: BLE001 — Push ist best-effort
            log.exception("anruf_voip_sendung_fehlgeschlagen")

    aufgabe = asyncio.create_task(kette(), name=f"anruf-voip-{call_id}")
    _laufend.add(aufgabe)
    _letzte_je_anruf[call_id] = aufgabe

    def fertig(t: asyncio.Task[None]) -> None:
        _laufend.discard(t)
        if _letzte_je_anruf.get(call_id) is t:
            del _letzte_je_anruf[call_id]

    aufgabe.add_done_callback(fertig)


async def hintergrund_abwarten(frist_s: float = 5.0) -> None:
    """Auf alle laufenden Sendungen warten — beim Herunterfahren, und in Tests,
    die sehen wollen, was hinausging."""
    offen = set(_laufend)
    if offen:
        await asyncio.wait(offen, timeout=frist_s)


async def _senden(
    zugang: apns_voip.ApnsZugang, geraete: list[Geraet], nutzlast: dict, session_factory: Any
) -> None:
    """An alle ``geraete`` senden; Tokens, die Apple als tot meldet, löschen."""
    ergebnisse = await asyncio.gather(
        *(
            apns_voip.senden(zugang=zugang, geraete_token=g.token, nutzlast=nutzlast)
            for g in geraete
        ),
        return_exceptions=True,
    )
    tote = [g.token for g, ausgang in zip(geraete, ergebnisse, strict=True) if ausgang == "dead"]
    if not tote or session_factory is None:
        return
    async with session_factory() as session:
        await session.execute(delete(VoipToken).where(VoipToken.token.in_(tote)))
        await session.commit()


# MARK: - Die zwei Einstiege


async def klingeln(
    *,
    session: Any,
    redis: Any,
    session_factory: Any,
    empfaenger_ids: set[int],
    call_id: str,
    art: str,
    channel_id: str,
    einleiter_id: str,
    einleiter_name: str,
) -> None:
    """Einen eingehenden Anruf an alle iOS-Geräte der Gerufenen melden.

    **Der Name reist mit, anders als im WS-Ereignis.** Dort steht nur
    ``einleiter_id``, und der Klient löst den Namen aus seinem Zwischenspeicher
    auf — nativer Code hat keinen. Ohne den Namen stünde im CallKit-Bildschirm
    eine Zahl.

    ``anruf_art`` ist ``dm`` oder ``gruppe`` — die ART DES GESPRÄCHS, nicht
    ob Video läuft. Einen Videoanruf als eigene Art gibt es nicht; die Kamera
    schaltet man im laufenden Anruf zu (Bughunt G3: die Hülle prüfte hier auf
    ``video`` und das Web fiel auf ein ungültiges ``audio`` zurück).

    Kehrt zurück, sobald gemerkt ist, wer klingelt; gesendet wird im
    Hintergrund. Löst nie aus.
    """
    if not empfaenger_ids:
        return
    zugang = apns_voip.zugang_aus_einstellungen(get_settings())
    if zugang is None:
        return
    try:
        treffer = await session.execute(
            select(VoipToken).where(VoipToken.user_id.in_(list(empfaenger_ids)))
        )
        geraete = [
            Geraet(user_id=z.user_id, geraet_id=z.geraet_id, token=z.token)
            for z in treffer.scalars().all()
        ]
    except Exception:  # noqa: BLE001
        log.exception("anruf_voip_geraete_lesen_fehlgeschlagen")
        return
    if not geraete:
        return
    # ZUERST merken, dann senden: ein Abbruch, der sofort danach kommt, muss
    # diese Geräte schon finden.
    await _merken(redis, call_id, geraete)
    nutzlast = {
        "art": "klingelt",
        "call_id": call_id,
        "anruf_art": art,
        "channel_id": channel_id,
        "einleiter_id": einleiter_id,
        "einleiter_name": einleiter_name or "Pulse",
    }
    _im_hintergrund(call_id, _senden(zugang, geraete, nutzlast, session_factory))


async def abbrechen(
    *,
    redis: Any,
    session_factory: Any,
    call_id: str,
    nur_konten: set[int] | None = None,
    ausser: tuple[int, str] | None = None,
) -> None:
    """Den CallKit-Bildschirm auf den Geräten schliessen, die per Push
    geklingelt haben (Auswahl: :func:`auswaehlen`).

    **Ohne das klingelt das Telefon ins Leere.** Legt der Anrufer auf, bevor
    abgenommen wurde, weiss eine Hülle mit eingefrorener Oberfläche nichts
    davon. Wer einen Abbruch bekommen hat, wird ausgetragen — ein zweiter
    fände keinen Anruf mehr (s. Modulkopf). Das handelnde Gerät wird STILL
    ausgetragen: nach einer Annahme läuft dort das Gespräch, und ein Abbruch
    an dessen Ende käme in den häufigsten Fall — beide Oberflächen wach, das
    Ende längst über die WebSocket da — und fände keinen Anruf mehr. Ist die
    Oberfläche dort eingefroren, schliesst die Hülle das Gespräch selbst, wenn
    die Gegenseite den Raum verlässt (``AnrufRaum.swift``).
    """
    zugang = apns_voip.zugang_aus_einstellungen(get_settings())
    if zugang is None:
        return
    geklingelt = await _geklingelt(redis, call_id)
    gewaehlt = auswaehlen(geklingelt, nur_konten=nur_konten, ausser=ausser)
    selbst = [g for g in geklingelt if g.kennung == ausser]
    await _austragen(redis, call_id, gewaehlt + selbst)
    if not gewaehlt:
        return
    _im_hintergrund(
        call_id,
        _senden(zugang, gewaehlt, {"art": "abbruch", "call_id": call_id}, session_factory),
    )


__all__ = [
    "GEKLINGELT_HALTBARKEIT_S",
    "GEKLINGELT_PRAEFIX",
    "Geraet",
    "abbrechen",
    "auswaehlen",
    "hintergrund_abwarten",
    "klingeln",
    "schluessel",
]
