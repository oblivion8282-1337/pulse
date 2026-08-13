"""Lese-Token eines Zuschauers sperren, wenn er die Community verliert.

**Warum es das gibt.** Das WHEP-Lese-Token eines Zuschauers ist an Kanal und
Streamer gebunden, **nicht an ihn selbst**, und es wird nicht verbraucht — der
mediamtx-auth-hook nimmt es die volle Laufzeit lang an (eine Stunde). Der
Mitgliedschafts-Check sitzt eine Ebene davor, beim Ausstellen, und wird danach
nie wieder durchlaufen. Wer aus einer Community entfernt oder gebannt wurde,
konnte deshalb bis zu eine Stunde weiterschauen und die Adresse weitergeben
(Bughunt 2026-08-13, ``docs/plans/2026-08-13-lese-token-nach-rauswurf.md``).

**Warum das Token nicht einfach an die Person gebunden wird**: MediaMTX ruft den
auth-hook nur mit dem Token aus der Adresse auf. Dort gibt es keine
Nutzeridentität — es ist kein angemeldeter Weg. Der Hook *kann* nicht prüfen,
wer da abruft. Deshalb bleibt nur, das Token beim Rechteentzug aktiv wegzunehmen.

**Was das NICHT löst**: wer die Adresse vor dem Rauswurf weitergegeben hat, dem
nimmt dieser Weg sie ebenfalls weg — die Token sind dieselben. Wer sich das
Token aber ausserhalb kopiert hat und einen anderen Pfad kennt, bleibt
unberührt. Eine kürzere Laufzeit wäre die Ergänzung dafür; sie braucht vorher
eine Messung, ob MediaMTX das Token während einer laufenden Übertragung erneut
prüft (sonst reisst sie allen Zuschauern das Bild ab).

**Best-effort gegenüber Redis, mit Absicht.** Ein Bann darf nicht daran
scheitern, dass Redis gerade klemmt. Redis-Fehler werden protokolliert, nicht
geworfen — dieselbe Haltung wie bei ``voice_evict`` und
``end_remote_sessions_for_member`` nebenan. **Datenbankfehler dagegen schlagen
durch**, genau wie beim Nachbarn: sie gehören dem Bann-Vorgang selbst, und ein
verschluckter Fehler auf der gemeinsamen Session würde erst eine Zeile später
zuschlagen — beim Verschicken der Moderations-Nachricht, mit einer Folgemeldung
statt der Ursache.
"""

from __future__ import annotations

from typing import Any

import structlog
from dcc_shared.streaming import read_cache_channel, read_cache_scan_pattern, token_key
from sqlalchemy import select

from dcc_chat_gateway.models import Channel

log = structlog.get_logger(__name__)

# Obergrenze je Aufruf, gezählt auf den Treffern **dieser Community**. Ein
# Zuschauer hat je Streamer und Platz ein Token; über eine Community sind das
# realistisch ein paar Dutzend. Die Grenze ist eine Notbremse gegen einen
# entarteten Schlüsselraum, keine Erwartung — wird sie erreicht, steht das im
# Protokoll, statt still abzuschneiden.
#
# Wichtig, dass hier die **gefilterten** Treffer zählen und nicht die
# durchsuchten: sonst könnte ein Zuschauer mit vielen Token in anderen
# Communities die Token dieser Community aus dem Fenster drücken — der Bann
# sperrte dann nichts, und zwar ausgerechnet dort, wo es zählt.
_MAX_SCHLUESSEL = 500


async def revoke_read_tokens_for_viewer(
    redis: Any, session: Any, guild_id: int, viewer_id: int | str, *, grund: str
) -> int:
    """Die Lese-Token von ``viewer_id`` **in dieser Community** löschen.
    Gibt zurück, wie viele Schlüssel gefallen sind.

    Löscht beides: den Nachschlage-Schlüssel (damit ein Wiederverbinden ein
    frisches Token holt und dabei erneut auf Mitgliedschaft geprüft wird) UND
    den Token-Datensatz selbst (damit das bereits ausgehändigte Token sofort
    ungültig ist — das ist der eigentliche Zweck).

    **Auf die Community eingegrenzt**, genau wie
    ``end_remote_sessions_for_member`` nebenan: wer aus Server A fliegt, darf
    seine laufenden Übertragungen in Server B nicht verlieren. Die Community
    steht nicht im Schlüssel, nur der Kanal — deshalb erst die Kanalliste holen,
    dann die Suchtreffer dagegen filtern.
    """
    if redis is None:
        log.info("stream_revoke_skipped", grund="kein redis", viewer_id=str(viewer_id))
        return 0
    rows = await session.execute(select(Channel.id).where(Channel.guild_id == guild_id))
    guild_channels = {str(cid) for cid in rows.scalars()}
    if not guild_channels:
        return 0
    geloescht = 0
    try:
        cache_keys: list[bytes] = []
        abgeschnitten = False
        async for key in redis.scan_iter(match=read_cache_scan_pattern(str(viewer_id)), count=100):
            if read_cache_channel(key) not in guild_channels:
                continue
            cache_keys.append(key)
            if len(cache_keys) >= _MAX_SCHLUESSEL:
                abgeschnitten = True
                break
        if abgeschnitten:
            log.warning("stream_revoke_limit", viewer_id=str(viewer_id), limit=_MAX_SCHLUESSEL)
        if not cache_keys:
            return 0
        # Die Token-Werte holen, BEVOR die Nachschlage-Schlüssel fallen — sonst
        # bleiben die Token-Datensätze als Waisen liegen und gelten weiter.
        werte = await redis.mget(cache_keys)
        token_keys = [
            token_key(w.decode() if isinstance(w, bytes) else w) for w in werte if w
        ]
        geloescht = await redis.delete(*cache_keys, *token_keys)
    except Exception:  # noqa: BLE001
        # Ein Bann darf an Redis nicht scheitern.
        log.exception("stream_revoke_failed", viewer_id=str(viewer_id))
        return 0
    if geloescht:
        log.info("stream_revoke", viewer_id=str(viewer_id), geloescht=geloescht, grund=grund)
    return geloescht
