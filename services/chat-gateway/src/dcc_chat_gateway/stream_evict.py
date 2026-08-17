"""Die eigene laufende HQ-Uebertragung eines Betroffenen beim Bann/Rauswurf beenden.

**Warum es das gibt.** ``stream_revoke.py`` nebenan sperrt nur die LESE-Seite:
die Token, mit denen ein Gebannter FREMDE Streams anschaut. Die SENDE-Seite —
die eigene Uebertragung des Betroffenen — blieb unberuehrt: der Sidecar auf
seinem Rechner pusht unveraendert weiter, und der media-svc-Poller
(``poller.py::reconcile_once``) haelt den Kanal auf „live", solange MediaMTX den
Pfad noch fuehrt (Bughunt 2026-08-17, ``streaming.md``).

**Warum ein Grabstein und nicht nur ``stream:active`` loeschen reicht nicht**:
die Live-Anzeige (``stream:channel:<cid>``) leitet der Poller JEDE Runde neu aus
MediaMTX' eigener Pfadliste ab — unabhaengig von ``stream:active``, das nur
Metadaten (Label, Bittiefe) traegt. Nur der ``stream:stopping``-Grabstein
(sonst vom Selbst-Stop in ``media-svc/routes.py::stop_stream`` gesetzt) laesst
den Poller einen weiterhin publizierenden Pfad als beendet behandeln — siehe
die Erklaerung an ``poller.py::reconcile_once`` ("Honor explicit-stop
suppression"). Ohne ihn nimmt der naechste Poll-Durchlauf den Publisher wieder
auf, egal wie oft ``stream:active`` geloescht wird.

**Was das NICHT beendet**: die tatsaechliche Medienverbindung zu Zuschauern, die
bereits vor dem Bann per WHEP verbunden sind — dafuer muesste MediaMTX' eigene
Kick-API (``POST /v3/webrtcsessions/kick/<id>`` bzw. das RTMPS-Gegenstueck)
bemueht werden, was media-svc voraussetzt (nur der Dienst mit MediaMTX-API-
Zugriff) und hier bewusst NICHT gebaut wird. Innerhalb eines Poll-Intervalls
(``poll_interval_s``, Vorgabe 3s) verschwindet der Kanal aus der Live-Anzeige,
neue Zuschauer bekommen ueber ``GET /whep`` kein Token mehr (der Datensatz ist
weg), und der Selbst-Heilungs-Pfad des Pollers raeumt ``stream:active``
endgueltig auf. Ein serverseitiger Verbindungsabbruch fuer schon verbundene
Zuschauer bleibt ein offener Folgeschritt.

**Discovery statt Blindschreiben ueber alle 99 Plaetze**: anders als
``stop_stream`` (das den eigenen Aufrufer stoppt und deshalb blind ueber jeden
moeglichen Platz schreibt) sucht dieser Pfad hier per SCAN nach tatsaechlich
vorhandenen ``stream:active``-Eintraegen — ein Bann trifft potenziell mehrere
Kanaele einer Community, blindes Schreiben ueber alle Plaetze in jedem Kanal
waere unnoetig teuer. Auf die Community eingegrenzt, genau wie
``revoke_read_tokens_for_viewer`` nebenan: wer aus Server A fliegt, darf seine
laufende Uebertragung in Server B nicht verlieren.

**Redis-Key-Namen dupliziert**: das Praefix ``stream:active:``/``stream:stopping:``
lebt kanonisch in ``dcc_media_svc.streamkeys`` (kein ``dcc-shared``-Import von
dort moeglich, siehe die Begruendung dort). Hier reicht die reine
String-Ersetzung ``active`` → ``stopping`` auf dem SCAN-Treffer — dieselbe Form,
die ``user_purge.py`` fuer den Loesch-Fall schon ungeprueft nutzt.

**Best-effort gegenueber Redis**, dieselbe Haltung wie ``stream_revoke``: ein
Bann darf nicht an einer klemmenden Verbindung scheitern.
"""

from __future__ import annotations

from typing import Any

import structlog
from sqlalchemy import select

from dcc_chat_gateway.models import Channel

log = structlog.get_logger(__name__)

# Deckt sich mit media-svc's ``stop_suppression_s`` (Vorgabe 30s) — der Grabstein
# muss mindestens ein Poll-Intervall ueberdauern, damit der Poller die
# Unterdrueckung sicher sieht, bevor sie verfaellt.
_STOP_SUPPRESSION_S = 30

# Notbremse wie in ``stream_revoke.py``: reale Treffer je Bann bleiben klein
# (ein paar Plaetze je Kanal), das hier ist nur eine Grenze gegen einen
# entarteten Schluesselraum.
_MAX_SCHLUESSEL = 500


def _grabstein_schluessel(aktiv_key: bytes | str) -> str:
    """``stream:active:channel-...`` → ``stream:stopping:channel-...`` — reine
    Praefix-Ersetzung, siehe Modul-Docstring."""
    text = aktiv_key.decode() if isinstance(aktiv_key, bytes) else aktiv_key
    return text.replace("stream:active:", "stream:stopping:", 1)


async def end_active_streams_for_member(
    redis: Any, session: Any, guild_id: int, user_id: int, *, grund: str
) -> int:
    """Jede laufende HQ-Uebertragung von ``user_id`` **in dieser Community**
    beenden (im Sinne von: den Poller sie als beendet behandeln lassen).

    Gibt zurueck, wie viele (Kanal, Platz)-Paare betroffen waren."""
    if redis is None:
        log.info("stream_evict_skipped", grund="kein redis", user_id=str(user_id))
        return 0
    rows = await session.execute(select(Channel.id).where(Channel.guild_id == guild_id))
    channel_ids = [str(cid) for cid in rows.scalars()]
    if not channel_ids:
        return 0
    uid = str(user_id)
    getroffen = 0
    try:
        for cid in channel_ids:
            muster = f"stream:active:channel-{cid}-{uid}*"
            aktive_keys: list[bytes | str] = []
            abgeschnitten = False
            async for key in redis.scan_iter(match=muster, count=100):
                aktive_keys.append(key)
                if len(aktive_keys) >= _MAX_SCHLUESSEL:
                    abgeschnitten = True
                    break
            if abgeschnitten:
                log.warning(
                    "stream_evict_limit", user_id=str(user_id), channel_id=cid,
                    limit=_MAX_SCHLUESSEL,
                )
            if not aktive_keys:
                continue
            async with redis.pipeline(transaction=False) as pipe:
                for aktiv_key in aktive_keys:
                    pipe.set(
                        _grabstein_schluessel(aktiv_key), "1", ex=_STOP_SUPPRESSION_S
                    )
                pipe.delete(*aktive_keys)
                await pipe.execute()
            getroffen += len(aktive_keys)
    except Exception:  # noqa: BLE001 — ein Bann darf an Redis nicht scheitern.
        log.exception("stream_evict_failed", user_id=str(user_id))
        return 0
    if getroffen:
        log.info(
            "stream_evict", user_id=str(user_id), getroffen=getroffen, grund=grund
        )
    return getroffen
