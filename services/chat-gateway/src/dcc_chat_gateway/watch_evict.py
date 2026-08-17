"""Eine laufende Watch-Party beim Bann/Rauswurf des Hosts beenden.

**Warum es das gibt** (Bughunt 2026-08-17, ``verbindungen.md`` / Nachtrag
``plugins-watch``): ``handle_control``, ``handle_source_change`` und
``handle_heartbeat`` in ``routes/ws_watch.py`` pruefen nur, ob der Aufrufer noch
derselbe ``host_user_id`` ist wie in der Redis-Party — nie, ob er noch Mitglied
der Community ist. Ein gebannter oder rausgeworfener Host behaelt damit volle
Kontrolle (Play/Pause/Suchen/Quellenwechsel) ueber eine laufende Party, solange
sein Socket offen bleibt.

**Warum die Pruefung hier sitzt und nicht im Takt jedes Herzschlags**: die
Fernsteuerung hat fuer genau dieses Muster zwei Waechter — einen periodischen
Prueflauf (``remote_guard.py::audit_remote_sessions``, alle 30s) UND einen
sofortigen Abbruch am Ereignis, das die Mitgliedschaft aendert
(``end_remote_sessions_for_member``, gerufen aus dem Bann-/Rauswurf-Pfad). Fuer
Watch-Partys uebernimmt dieses Modul nur die zweite Haelfte: ein periodischer
Prueflauf ueber jede laufende Party waere eine DB-Abfrage pro Party alle paar
Sekunden fuer ein Ereignis, das in der Praxis fast nie eintritt (Bann waehrend
eine Party laeuft). Der sofortige Abbruch am Bann-/Rauswurf-/Austritt-Ereignis
kostet dagegen nichts im Normalfall — nur eine Redis-Lesung ueber die Kanaele
der Community, und die meisten Communities haben keine laufende Party. Ein
Herzschlag-Check waere zudem zu spaet UND zu frueh zugleich: die Kontrolle
(play/pause/seek) laeuft ueber ``handle_control``, nicht ueber den Herzschlag,
und ein alle-paar-Sekunden-Takt liesse dieselbe Luecke bestehen, die die
Fernsteuerung bereits einmal gemessen hat (bis zu 30s Fremdzugriff).

**Was NICHT angefasst wird**: ein Betroffener, der nur ZUSCHAUER einer Party
ist (nicht Host), bleibt hier unberuehrt — sein Tile verschwindet ueber die
normale ``guild_member_removed``-Aufraeumung im Client, und Server-seitig gibt
es dafuer keinen Sicherheitsgewinn (Zuschauen ist keine Kontrolle). Die
in-process ``_watchers``-Registratur (``watch_registry.py``) wird bewusst NICHT
angefasst: sie kennt nur Sockets, nicht "beende diesen Host ohne sein Socket",
und ihr Eintrag heilt beim naechsten Verbindungsende oder der naechsten
Watch-Op des Sockets von selbst (dieselbe Abwaegung wie bei
``device_registry.device_withdraw`` fuer Bildschirme: veraltet, aber nie
falsch in Richtung "aktiv").
"""

from __future__ import annotations

from typing import Any

import structlog
from sqlalchemy import select

from dcc_chat_gateway import watchkeys
from dcc_chat_gateway.models import CHANNEL_TYPE_VOICE, Channel

log = structlog.get_logger(__name__)


async def end_watch_parties_for_member(
    session: Any, redis: Any, manager: Any, guild_id: int, user_id: int
) -> int:
    """Jede Watch-Party beenden, die ``user_id`` in ``guild_id`` gerade hostet.

    Gibt zurueck, wie viele Partys beendet wurden."""
    if redis is None:
        return 0
    rows = await session.execute(
        select(Channel.id).where(
            Channel.guild_id == guild_id, Channel.type == CHANNEL_TYPE_VOICE
        )
    )
    channel_ids = [str(cid) for cid in rows.scalars()]
    if not channel_ids:
        return 0
    uid = str(user_id)
    partys = await watchkeys.read_states_for(redis, channel_ids)
    beendet = 0
    for eintrag in partys:
        state = eintrag["state"]
        if str(state.get("host_user_id")) != uid:
            continue
        cid, pid = eintrag["channel_id"], eintrag["party_id"]
        await watchkeys.delete_party(redis, cid, pid)
        if manager is not None:
            # Eine spaeter noch feuernde Kulanzfrist (Host-WS bereits getrennt,
            # Timer laeuft) darf die Party nicht ein zweites Mal — und dann
            # womoeglich fuer einen inzwischen neuen Host — loeschen.
            manager.cancel_host_end(cid, pid)
        beendet += 1
    if beendet:
        log.info(
            "watch_parties_ended_for_member", guild_id=str(guild_id),
            user_id=uid, count=beendet,
        )
    return beendet
