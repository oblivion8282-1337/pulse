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

from fastapi import WebSocket

from dcc_chat_gateway.remote_registry import send_to_socket
from dcc_chat_gateway.routes.ws_remote_handlers import _manager, _session_id
from dcc_chat_gateway.security import AuthenticatedUser

log = logging.getLogger(__name__)


async def handle_reclaim(websocket: WebSocket, user: AuthenticatedUser, msg: dict[str, Any]) -> None:
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
    reclaimed = await mgr.remote_reclaim(session_id, role, str(user.id), websocket)
    if reclaimed is None:
        # Falsche Rolle (der andere Peer versucht's, oder die Gnadenfrist
        # dieser Rolle war nie scharf/ist schon abgelaufen).
        await send_to_socket(websocket, frame_failed("no grace window for this role"))
        return
    log.info("remote session %s reclaimed by role=%s", session_id, role)
    await send_to_socket(websocket, frame_ok)
