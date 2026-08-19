"""``remote_reclaim`` — die Annahme-Seite der Gnadenfrist aus
:mod:`remote_reconnect_registry`.

Eigenes Modul, aus demselben Groessen-Grund wie ``ws_remote_teardown``/
``ws_remote_input``/``ws_remote_geraet`` (:mod:`routes.ws_remote_handlers` lag
schon bei 427 von 500 Zeilen).

Antwort ueber ZWEI eigene Rahmen statt dem numerierten `_err`-Weg (4050-4059):
jene Codes werden vom Client nur waehrend eines offenen Zustimmungsdialogs
beachtet (`remote/session.svelte.ts::_error`, Phase 'requesting'/'incoming')
— ein Reclaim laeuft aber waehrend `phase === 'active'`, wo dieser Weg gar
nicht zuhoert. ``remote_reclaimed``/``remote_reclaim_failed`` sind deshalb
eigene, gezielt gehoerte Rahmen.
"""

from __future__ import annotations

import logging
from typing import Any

from dcc_shared.permissions import Permissions
from fastapi import WebSocket

from dcc_chat_gateway.permissions import has_permission
from dcc_chat_gateway.remote_guard import peer_channel_perms
from dcc_chat_gateway.remote_registry import send_to_socket
from dcc_chat_gateway.routes.ws_remote_handlers import _manager, _session_id
from dcc_chat_gateway.security import AuthenticatedUser

log = logging.getLogger(__name__)


async def handle_reclaim(
    websocket: WebSocket,
    user: AuthenticatedUser,
    msg: dict[str, Any],
    *,
    session_factory: Any,
) -> None:
    session_id = _session_id(msg.get("session_id"))
    frame_ok = {"op": "remote_reclaimed", "session_id": session_id}

    def frame_failed(reason: str) -> dict[str, Any]:
        return {"op": "remote_reclaim_failed", "session_id": session_id, "reason": reason}

    if not session_id:
        await send_to_socket(websocket, frame_failed("session_id required"))
        return
    mgr = _manager(websocket)
    if mgr is None:
        return
    sess = mgr.remote_get(session_id)
    if sess is None:
        # Kein "gescheitert, versuch's nochmal" — die Sitzung ist entweder
        # laengst durch die abgelaufene Gnadenfrist beendet (der Client bekommt
        # ohnehin gleich das zugehoerige `remote_ended` hinterher, sobald seine
        # eigene lokale Frist ablaeuft) oder nie so weit gekommen.
        await send_to_socket(websocket, frame_failed("session gone"))
        return
    role = (
        "host"
        if str(user.id) == sess.host_user_id
        else "controller"
        if str(user.id) == sess.controller_user_id
        else None
    )
    if role is None:
        await send_to_socket(websocket, frame_failed("not a session peer"))
        return
    # **Rechte erneut pruefen** (Bughunt 2026-08-19, zweite Runde) — vor der
    # Gnadenfrist war jeder Reconnect eine frische `remote_request` mit voller
    # Rechtepruefung; ein Reclaim war der einzige Weg, an dem eine laufende
    # Sitzung OHNE erneute Pruefung weiterlief. Ein Bann bleibt unabhaengig
    # davon dicht (`end_remote_sessions_for_member` entfernt die Sitzung ganz,
    # der Reclaim scheitert dann schon oben an "session gone"); hier geht es um
    # einen blossen Rollen- oder Overwrite-Entzug OHNE Bann, den sonst nur der
    # 30-s-Prueflauf faengt (`remote_guard.py::audit_remote_sessions`).
    try:
        cid = int(sess.channel_id)
    except ValueError:
        await send_to_socket(websocket, frame_failed("bad channel"))
        return
    async with session_factory() as db:
        perms = await peer_channel_perms(db, cid, user)
    if perms is None or not has_permission(perms, Permissions.VIEW_CHANNEL):
        await send_to_socket(websocket, frame_failed("no access"))
        return
    if role == "controller" and not has_permission(perms, Permissions.REMOTE_CONTROL):
        await send_to_socket(websocket, frame_failed("no access"))
        return
    reclaimed = await mgr.remote_reclaim(session_id, role, str(user.id), websocket)
    if reclaimed is None:
        # Falsche Rolle (der andere Peer versucht's, oder die Gnadenfrist
        # dieser Rolle war nie scharf/ist schon abgelaufen).
        await send_to_socket(websocket, frame_failed("no grace window for this role"))
        return
    # Ist der Host ein eingetragenes Standplatz-Geraet, muss die Belegung
    # ("belegt" + wer steuert) den neuen Socket wieder tragen — sonst zeigt
    # das Geraet sich nach dem Reclaim faelschlich als "bereit", waehrend die
    # Sitzung laengst laeuft (Bughunt 2026-08-19, zweite Runde, unabhaengig auf
    # zwei Pruefen gefunden). `sess.device_id`, NICHT `device_for_socket`: der
    # neue Socket hat sein eigenes `device_announce` zu diesem Zeitpunkt meist
    # noch nicht geschickt (das laeuft client-seitig NACH diesem Reclaim, nach
    # `refreshMonitors()`), `device_for_socket(websocket)` faende also nichts.
    if role == "host" and reclaimed.device_id is not None:
        try:
            geraet_id = int(reclaimed.device_id)
            mgr.device_set_busy(geraet_id, reclaimed.controller_user_id, websocket)
            await mgr.publish_device_state(geraet_id)
        except Exception:  # noqa: BLE001  # pragma: no cover
            log.debug("device busy state not restored after reclaim", exc_info=True)
    log.info("remote session %s reclaimed by role=%s", session_id, role)
    await send_to_socket(websocket, frame_ok)
