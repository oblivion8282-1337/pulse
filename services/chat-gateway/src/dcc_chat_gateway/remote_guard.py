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
        # Fail-closed: ein Peer-Socket, den der Manager nicht mehr kennt, hat
        # keinen Nutzer mehr — und ohne Nutzer kann die Wache seine Rechte nicht
        # pruefen. Hier stand "den Abbau besitzt der Disconnect-Pfad"; das war
        # falsch, denn ``_ws_user`` wird an einer ZWEITEN Stelle geleert: der
        # Pubsub-Verteiler meldet einen Socket bei Sendefehler oder abgelaufener
        # Sendefrist ueber ``remove_socket`` ab, OHNE ihn zu schliessen und ohne
        # den Disconnect-Pfad zu rufen. Ein Steuernder, der kurz nicht liest
        # (TCP-Gegendruck, Mobilclient mit Sendestau), verlor damit seinen
        # Eintrag, steuerte aber weiter — und die Wache sagte fuer diese Sitzung
        # fuer immer "leben lassen": Rollenentzug und Kanal-Overwrite blieben
        # bis zu acht Stunden wirkungslos.
        #
        # Ein Wettlauf mit dem Disconnect-Pfad kostet nichts: ``remote_terminate``
        # poppt unter dem Lock und ist idempotent, der Zweite findet nichts mehr
        # vor. Der Grund heisst wie dort ``peer_disconnected`` — fuer die
        # Gegenseite ist es genau das, und das Frontend kennt kein neues Wort.
        return "peer_disconnected"
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
    from dcc_chat_gateway.models import Device  # noqa: PLC0415 - App-Boot-Zirkel

    rows = (
        await session.execute(
            select(Device).where(Device.guild_id == guild_id, Device.owner_user_id == user_id)
        )
    ).scalars().all()
    if not rows:
        return 0
    for device in rows:
        if manager is not None:
            await manager.end_remote_sessions_for_device(device.id)
        await session.delete(device)
    await session.flush()
    log.info("devices removed with member: guild=%s count=%d", guild_id, len(rows))
    return len(rows)


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
