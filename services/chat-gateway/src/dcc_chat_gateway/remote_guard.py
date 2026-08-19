"""Rechte-Wache fuer LAUFENDE Fernsteuer-Sitzungen.

Die Zustimmung und die Rechte werden beim Aufbau geprueft
(``routes/ws_remote_handlers.handle_request``) — das genuegt nicht. Ohne eine
zweite Pruefung ueberlebt eine laufende Sitzung Rauswurf, Bann, Rollenentzug und
Kanal-Overwrite bis zum Ablauf des Zugangstokens: bei 15 Minuten Gueltigkeit
sind das 15 Minuten Tastatur- und Mauszugriff auf einem fremden Rechner,
nachdem ein Admin die Rolle genommen hat.

Das Wire-Protokoll v2 (``docs/plans/2026-08-12-input-wire-protokoll-v2.md``,
"Sicherheit und Robustheit") verlangt deshalb beides:

* **Prueflauf im Takt**, hoechstens eine Minute Verzoegerung →
  :func:`remote_perm_audit_loop` (Vorgabe 30 s) ueber
  :func:`audit_remote_sessions`.
* **Sofort** bei ausdruecklichem Rauswurf/Bann → :func:`end_remote_sessions_for_member`,
  gerufen aus ``routes/guilds.py::_remove_guild_member`` und ``routes/bans.py``
  an genau der Stelle, an der der Nutzer schon aus Voice geworfen wird.

Beide Wege enden in ``manager.remote_terminate`` — ein einziger Abbauweg, damit
weder Zeitgeber noch Zustimmungsdialog eines Host-Tabs stehen bleiben.
"""

from __future__ import annotations

import asyncio
import logging

from dcc_shared.permissions import Permissions
from sqlalchemy import select

from dcc_chat_gateway.models import Channel
from dcc_chat_gateway.permissions import has_permission, resolve_permissions
from dcc_chat_gateway.routes._deps import channel_membership

log = logging.getLogger(__name__)

# Takt der Nachpruefung. Der Vertrag erlaubt bis zu einer Minute Verzoegerung;
# 30 s halten den Abstand zum Limit, ohne dass die Last zaehlt — die Schleife
# macht ohne laufende Sitzung ueberhaupt keine Abfrage.
REMOTE_PERM_AUDIT_INTERVAL_S = 30.0

# Absolute Obergrenze einer Sitzung. Eine Zustimmung gilt fuer EINE Sitzung,
# nicht auf Dauer; ohne Deckel bleibt ein vergessener Tab ueber Nacht steuerbar.
# Grosszuegig gewaehlt: die Rechtepruefung oben ist der scharfe Schutz, das hier
# ist der Riegel gegen das Vergessen.
REMOTE_MAX_SESSION_S = 8 * 60 * 60


async def peer_channel_perms(session, channel_id: int, user) -> int | None:
    """Effective channel permissions of ``user``, or ``None`` when they are no
    longer a member of the channel's guild (or the guild is suspended).

    Auch vom Aufbau-Pfad (``handle_request``) benutzt: Aufbau und Nachpruefung
    muessen dieselbe Latte anlegen, sonst beendet der Prueflauf 30 s spaeter,
    was der Aufbau gerade erlaubt hat."""
    channel = await channel_membership(session, channel_id, user.id)
    if channel is None:
        return None
    return await resolve_permissions(session, user, channel.guild_id, channel_id)


async def _end_reason(session, manager, sess, max_session_s: float) -> str | None:
    """Why ``sess`` must die now, or ``None`` when it may live on."""
    if sess.age_s() >= max_session_s:
        return "session_expired"
    controller = manager.remote_socket_user(sess.controller_socket)
    host = manager.remote_socket_user(sess.host_socket)
    if controller is None or host is None:
        # Ein fehlender Peer-Socket hat zwei ganz verschiedene Ursachen, und
        # nur EINE davon ist ein sicherer Grund zum Sofort-Ende (Bughunt
        # 2026-08-19, zweite Runde — der erste Fix hier war zu grob):
        #
        # (a) Eine LAUFENDE Gnadenfrist genau dieser Rolle
        # (`remote_reconnect_registry.py`) — der Socket ist weg, WEIL der
        # Disconnect-Pfad ihn gerade erst befristet hat, und ein
        # `remote_reclaim` kann in den naechsten Sekunden alles wiederherstellen.
        # Das ist der ERWARTETE Zwischenzustand einer Gnadenfrist, kein Anlass
        # zum Ende — bei 30 s Takt und 10 s Frist toetete das fail-closed sonst
        # rund ein Drittel aller Wackler noch WAEHREND ihrer eigenen Gnadenfrist,
        # bevor sie ueberhaupt eine Chance zum Reklamieren hatten.
        #
        # (b) Alles andere — insbesondere der Pubsub-Verteiler, der einen Socket
        # bei Sendefehler oder abgelaufener Sendefrist ueber ``remove_socket``
        # abmeldet, OHNE ihn zu schliessen und OHNE den Disconnect-Pfad (und
        # damit ohne jede Gnadenfrist) zu rufen. Ein Steuernder, der kurz nicht
        # liest (TCP-Gegendruck, Mobilclient mit Sendestau), verliert so seinen
        # Eintrag, steuert aber weiter — dafuer bleibt es beim Sofort-Ende, sonst
        # sagte die Wache fuer diese Sitzung fuer immer "leben lassen".
        #
        # Fehlen BEIDE, muss BEIDE Abwesenheit ueber eine laufende Frist erklaert
        # sein — fehlt auch nur einer ohne Frist, bleibt es beim Sofort-Ende.
        if (controller is None and not manager.remote_disconnect_grace_active(
            sess.session_id, "controller"
        )) or (host is None and not manager.remote_disconnect_grace_active(
            sess.session_id, "host"
        )):
            # Ein Wettlauf mit dem Disconnect-Pfad kostet nichts:
            # ``remote_terminate`` poppt unter dem Lock und ist idempotent, der
            # Zweite findet nichts mehr vor. Der Grund heisst wie dort
            # ``peer_disconnected`` — fuer die Gegenseite ist es genau das, und
            # das Frontend kennt kein neues Wort.
            return "peer_disconnected"
        # Beide Abwesenheiten (falls beide fehlen) sind befristet erklaert —
        # diesen Takt ueberspringen, ohne die Rechte des noch bekannten Peers zu
        # pruefen (der fehlt hier ja gerade nicht zwangslaeufig; ist er da,
        # PRUEFT der Rest der Funktion trotzdem nicht weiter, weil unten sowohl
        # `controller` als auch `host` gebraucht werden und mindestens einer
        # `None` ist). Der naechste Takt (spaetestens 30 s spaeter) greift
        # erneut — kein Fenster bleibt dauerhaft ungeprueft.
        return None
    try:
        cid = int(sess.channel_id)
    except ValueError:
        return "permission_revoked"
    controller_perms = await peer_channel_perms(session, cid, controller)
    if controller_perms is None or not (
        has_permission(controller_perms, Permissions.VIEW_CHANNEL)
        and has_permission(controller_perms, Permissions.REMOTE_CONTROL)
    ):
        return "permission_revoked"
    # Der Host wird gegen dieselbe Latte gemessen wie beim Aufbau: Mitglied UND
    # VIEW_CHANNEL. Wer den Kanal nicht mehr sehen darf, in dem er hergegeben
    # wurde, wird auch nicht weiter gesteuert.
    host_perms = await peer_channel_perms(session, cid, host)
    if host_perms is None or not has_permission(host_perms, Permissions.VIEW_CHANNEL):
        return "permission_revoked"
    return None


async def audit_remote_sessions(
    manager, *, max_session_s: float = REMOTE_MAX_SESSION_S
) -> int:
    """One audit pass over every live session. Returns how many were ended.

    Reuses a single DB session for the whole pass — a pass is normally over
    zero or one session, and the checks are the same three lookups the request
    path already pays."""
    sessions = manager.remote_sessions_snapshot()
    if not sessions:
        return 0
    session_factory = getattr(manager, "_session_factory", None)
    if session_factory is None:
        # Nur in Tests, die den Manager ohne DB verdrahten. Fail-open waere hier
        # falsch, aber ohne DB gibt es nichts zu pruefen — und die Sitzung ohne
        # Grundlage zu beenden waere schlechter als sie stehen zu lassen.
        return 0
    ended = 0
    async with session_factory() as session:
        for sess in sessions:
            reason = await _end_reason(session, manager, sess, max_session_s)
            if reason is None:
                continue
            if await manager.remote_terminate(sess.session_id, reason) is not None:
                ended += 1
                log.info(
                    "remote session ended by audit: reason=%s age=%.0fs",
                    reason,
                    sess.age_s(),
                )
    return ended


async def remote_perm_audit_loop(
    manager, interval: float = REMOTE_PERM_AUDIT_INTERVAL_S
) -> None:
    """Background task: re-check the rights of every live session on a tick.

    Never dies of a failed pass — a DB hiccup must not silently switch the
    whole recheck off (that is exactly the state this task exists to prevent).
    """
    while True:
        try:
            await asyncio.sleep(interval)
            await audit_remote_sessions(manager)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.exception("remote permission audit pass failed")


async def remove_devices_for_member(session, manager, guild_id: int, user_id: int) -> int:
    """Die Standplatz-Geraete eines ausgeschiedenen Mitglieds entfernen.

    **Warum das dazugehoert** (Bughunt 2026-08-16): ein Geraet steht im Kanal
    einer Community und laesst sich von jedem wecken und uebernehmen, der dort
    ``REMOTE_CONTROL`` hat — geprueft wird das RECHT DES RUFERS, nicht die
    Mitgliedschaft des Besitzers. Bliebe die Zeile nach einem Rauswurf oder Bann
    stehen, stuende der Rechner eines Ex-Mitglieds weiter im Raum und waere
    weiter benutzbar. Der Besitzer selbst kaeme nicht einmal mehr heran, um ihn
    auszutragen.

    Die laufende Sitzung raeumt :func:`end_remote_sessions_for_member` ab; hier
    geht es um die Zeile. Gerufen aus denselben beiden Pfaden.
    """
    from dcc_chat_gateway.device_meldungen import device_out  # noqa: PLC0415
    from dcc_chat_gateway.models import Device  # noqa: PLC0415 - App-Boot-Zirkel

    treffer = await session.execute(
        select(Device).where(Device.guild_id == guild_id, Device.owner_user_id == user_id)
    )
    rows = treffer.scalars().all()
    if not rows:
        return 0
    # Den letzten Stand VOR dem Loeschen einsammeln: die Meldung unten braucht
    # Kennung, Standplatz und Namen, und danach gibt es die Zeile nicht mehr.
    stand = [
        (device.id, device.channel_id, device_out(device, manager).model_dump())
        for device in rows
    ]
    for device in rows:
        if manager is not None:
            await manager.end_remote_sessions_for_device(device.id)
        await session.delete(device)
    # **Committen, nicht nur flushen** (Bughunt 2026-08-16). Beide Aufrufer
    # rufen NACH ihrem eigenen Commit; ein blosses Flush haengt damit an keiner
    # Transaktion mehr, die noch jemand abschliesst, und ``get_session`` rollt
    # beim Schliessen zurueck. Beim Bann und beim Rauswurf ging es nur zufaellig
    # durch, weil die anschliessende Moderations-Nachricht committet — beim
    # freiwilligen Verlassen (``leave_guild``) gibt es die nicht, und die
    # Geraetezeilen ueberlebten den Austritt.
    await session.commit()
    log.info("devices removed with member: guild=%s count=%d", guild_id, len(rows))
    if manager is not None:
        # **Und das Verschwinden melden** (Bughunt 2026-08-16): ohne das bleibt
        # in jeder offenen Kanalliste eine Kachel stehen, deren Zeile es nicht
        # mehr gibt — ein Klick darauf endet in 4060. ``delete_device`` macht
        # es laengst so; nur dieser Pfad tat es nicht.
        for device_id, channel_id, daten in stand:
            try:
                await manager.publish_device_change(
                    guild_id=guild_id, channel_id=channel_id, device=daten, removed=True
                )
            except Exception:  # noqa: BLE001  # pragma: no cover
                log.debug("device removal not published", exc_info=True)
            # Nach dem Melden vergessen — davor braucht die Meldung den
            # gemerkten Standplatz (s. ``device_registry.device_forget``).
            manager.device_forget(device_id)
    return len(rows)


async def collect_devices_for_cascade(
    session, manager, *, guild_id: int, channel_id: int | None = None
) -> list[tuple[int, int, dict]]:
    """Standplatz-Geraete einsammeln, bevor eine Kanal- oder Community-Loeschung
    sie per ``ON DELETE CASCADE`` mitnimmt.

    **Warum das dazugehoert** (Bughunt 2026-08-17, ``daten.md``): die
    Datenbankzeile faellt mit dem Kanal bzw. der Community, das In-Prozess-
    Register (``device_registry.py``) merkt davon nichts — Standplatz und
    Bildschirmliste blieben fuer eine Kennung stehen, die es nicht mehr gibt,
    und die Kachel haengt bis zum naechsten Neuladen in einer offenen
    Geraeteliste. Gemeinsame Stelle fuer beide Loeschwege statt zweier
    getrennt gepflegter Kopien.

    Beendet nebenbei jede laufende Fernsteuerung dieser Geraete — dieselbe
    Reihenfolge wie ``remove_devices_for_member``: erst die Sitzung, dann (nach
    dem Commit, ueber :func:`forget_devices_after_cascade`) die Meldung und das
    Vergessen. ``channel_id`` grenzt auf einen einzelnen Kanal ein
    (Kanal-Loeschung); ohne ihn zaehlt die ganze Community
    (Community-Loeschung).

    Muss VOR dem Commit gerufen werden — danach gibt es die Zeilen nicht mehr.
    """
    from dcc_chat_gateway.device_meldungen import device_out  # noqa: PLC0415
    from dcc_chat_gateway.models import Device  # noqa: PLC0415 - App-Boot-Zirkel

    stmt = select(Device).where(Device.guild_id == guild_id)
    if channel_id is not None:
        stmt = stmt.where(Device.channel_id == channel_id)
    rows = (await session.execute(stmt)).scalars().all()
    if not rows:
        return []
    stand = [
        (device.id, device.channel_id, device_out(device, manager).model_dump())
        for device in rows
    ]
    if manager is not None:
        for device in rows:
            await manager.end_remote_sessions_for_device(device.id)
    return stand


async def forget_devices_after_cascade(
    manager, guild_id: int, devices: list[tuple[int, int, dict]]
) -> None:
    """Nach dem Commit: das Register vergisst, was die Kaskade gerade geraeumt
    hat, und meldet das Verschwinden — sonst bleibt die Kachel in jeder offenen
    Geraeteliste stehen, bis jemand neu laedt (s. :func:`collect_devices_for_cascade`).

    Gerufen mit deren Ergebnis, NACH dem Commit. Gleiche Reihenfolge wie
    ``delete_device``: erst melden (der gemerkte Standplatz wird noch
    gebraucht), dann vergessen.
    """
    if manager is None or not devices:
        return
    for device_id, channel_id, daten in devices:
        try:
            await manager.publish_device_change(
                guild_id=guild_id, channel_id=channel_id, device=daten, removed=True
            )
        except Exception:  # noqa: BLE001  # pragma: no cover
            log.debug("device removal not published", exc_info=True)
        manager.device_forget(device_id)


async def end_remote_sessions_for_member(
    session, manager, guild_id: int, user_id: int, *, reason: str = "membership_revoked"
) -> int:
    """Cut every remote session ``user_id`` holds in ``guild_id`` — in EITHER
    role. Returns how many were ended.

    Gerufen aus dem Rauswurf- und dem Bann-Pfad, weil der Takt-Prueflauf oben
    bis zu 30 s braucht und ein ausdruecklicher Rauswurf laut Vertrag *sofort*
    trennen muss. Auf den Server eingegrenzt: wer aus Server A fliegt, verliert
    keine Sitzung in Server B."""
    if manager is None:
        return 0
    mine = [
        sess
        for sess in manager.remote_sessions_snapshot()
        if str(user_id) in (sess.host_user_id, sess.controller_user_id)
    ]
    if not mine:
        return 0  # Normalfall — keine DB-Abfrage fuer den leeren Fall
    rows = await session.execute(select(Channel.id).where(Channel.guild_id == guild_id))
    guild_channels = {str(cid) for cid in rows.scalars()}
    ended = 0
    for sess in mine:
        if sess.channel_id not in guild_channels:
            continue
        if await manager.remote_terminate(sess.session_id, reason) is not None:
            ended += 1
    if ended:
        log.info(
            "remote sessions ended for removed member: guild=%s count=%d", guild_id, ended
        )
    return ended
