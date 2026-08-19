"""Abbau einer Fernsteuer-Sitzung — ``remote_end`` und Disconnect.

Eigenes Modul, weil beide Ausloeser denselben Weg nehmen muessen (sonst bleibt
mal der Zeitgeber, mal ein Zustimmungsdialog stehen) und der Zustimmungs-
Handshake in :mod:`routes.ws_remote_handlers` zusammen mit dem Abbau die
Groessen-Policy (§12.1) sprengt.

Rollen statt Sockets: wer eine Sitzung beenden darf und wer die Nachricht
bekommt, haengt an der **Rolle**, nicht daran, welchen Socket wir gerade vor uns
haben. Der Host hat waehrend der Wartezeit womoeglich mehrere Tabs offen —
``host_socket`` ist bis zur Zustimmung nur der Stellvertreter.

Der Disconnect-Pfad beendet eine ANGENOMMENE Sitzung seit 2026-08-19 nicht
mehr sofort, sondern gibt ihr eine kurze Gnadenfrist
(:mod:`remote_reconnect_registry`) — die Annahme (``remote_reclaim``) liegt in
:mod:`routes.ws_remote_reconnect`, aus demselben Groessen-Grund wie die
Aufteilung hier.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import WebSocket

from dcc_chat_gateway.remote_registry import send_to_socket
from dcc_chat_gateway.routes.ws_remote_handlers import _err, _manager, _session_id
from dcc_chat_gateway.security import AuthenticatedUser

log = logging.getLogger(__name__)


async def _end_and_notify_peer(mgr, session_id: str, websocket: WebSocket, reason: str) -> None:
    """Tear a session down on behalf of ``websocket`` and tell the other peer.

    Ein Abbauweg fuer beide Ausloeser (``remote_end`` und Disconnect): Zeitgeber
    loeschen, Sitzung atomar entfernen, Gegenseite benachrichtigen. Die Reihenfolge
    ist Absicht — ohne das ``remote_end``-Ergebnis abzuwarten wuerden zwei
    gleichzeitige Abbauten die Gegenseite doppelt benachrichtigen."""
    mgr.remote_cancel_timeout(session_id)
    removed = await mgr.remote_end(session_id)
    if removed is None:
        return
    # Die Gegenseite haengt an der ROLLE des Abbauenden. Mit "ist es der
    # host_socket?" bekam ein zweiter Host-Tab, der die Sitzung beendet, die
    # Nachricht an den Host statt an den Steuernden geschickt — der Steuernde
    # haette weiter eine laufende Sitzung angezeigt.
    is_controller = websocket is removed.controller_socket
    frame = {"op": "remote_ended", "session_id": removed.session_id, "reason": reason}
    await send_to_socket(removed.host_socket if is_controller else removed.controller_socket, frame)
    if removed.state == "active":
        # Beendet ein ZWEITER Tab des Hosts (nicht der, der zugestimmt hat),
        # erfaehrt der zustimmende Tab es sonst nie und zeigt weiter eine
        # laufende Fernsteuerung an.
        if not is_controller and websocket is not removed.host_socket:
            await send_to_socket(removed.host_socket, frame)
        return
    # War die Sitzung noch nicht angenommen, steht der Zustimmungsdialog auf
    # JEDEM Host-Tab (``host_socket`` ist nur der Stellvertreter). Bleibt er
    # stehen, haengt der Dialog, und ein spaeteres "Zulassen" laeuft in 4053, was
    # das Frontend in der Phase 'incoming' verschluckt: der Host waere danach
    # fuer alle unerreichbar.
    #
    # Und: eine wartende Sitzung, die ohne Antwort stirbt, IST eine Absage —
    # dieselbe Sperrfrist wie bei "Nein" und Aussitzen. Ohne sie war der
    # Selbstabbruch das Schlupfloch: anfragen, Dialog springt auf jedem Host-Tab
    # auf, sofort ``remote_end``, Sperrfrist bleibt null, beliebig wiederholbar.
    mgr.remote_note_refused(removed.host_user_id, removed.controller_user_id)
    await mgr.remote_dismiss_host_tabs(removed, answered=websocket)


async def handle_end(
    websocket: WebSocket, user: AuthenticatedUser, msg: dict[str, Any]
) -> None:
    session_id = _session_id(msg.get("session_id"))
    if not session_id:
        await _err(websocket, 4050, "session_id required")
        return
    mgr = _manager(websocket)
    if mgr is None:
        return
    sess = mgr.remote_get(session_id)
    if sess is None:
        return  # idempotent
    # Steuernder: SOCKET-Identitaet — seine Sitzung haengt an genau dieser
    # Verbindung, und er darf sie in jedem Zustand beenden, auch waehrend sie
    # noch auf die Zustimmung wartet (er kennt sie seit ``remote_pending``).
    # Host: NUTZER-Identitaet — solange die Sitzung wartet, ist ``host_socket``
    # nur der Stellvertreter-Tab, und jeder andere Tab des Hosts bekam auf sein
    # ``remote_end`` ein 4053, konnte die Anfrage also gar nicht abbrechen.
    if websocket is not sess.controller_socket and str(user.id) != sess.host_user_id:
        await _err(websocket, 4053, "not a session peer")
        return
    await _end_and_notify_peer(mgr, session_id, websocket, "peer_ended")


async def cleanup_remote_on_disconnect(websocket: WebSocket, manager) -> None:
    """Socket closing: a still-PENDING session (no consent yet — just a dialog
    on the other side) ends immediately, as before. An ACTIVE session instead
    gets a short grace window (`remote_reconnect_registry.py`,
    REMOTE_DISCONNECT_GRACE_S) before it ends — added 2026-08-19 after a
    working session died 37s in on the shared remote-dev-stack, where a socket
    of EITHER peer drops every few minutes (any backend sync there reloads
    uvicorn, which drops every connected socket). Traffic toward the dropped
    peer is silently swallowed for the length of the window (`send_to_socket`
    already tolerates a gone socket); a `remote_reclaim` within the window
    hands the session its new socket and nothing else needs to happen."""
    for sess in manager.remote_sessions_for_socket(websocket):
        if sess.state != "active":
            try:
                await _end_and_notify_peer(
                    manager, sess.session_id, websocket, "peer_disconnected"
                )
            except Exception:  # noqa: BLE001
                log.exception(
                    "remote disconnect cleanup failed for pending session %s", sess.session_id
                )
            continue
        role = "host" if websocket is sess.host_socket else "controller"

        async def _on_grace_expired(session_id: str, _role: str, ws: WebSocket = websocket) -> None:
            try:
                await _end_and_notify_peer(manager, session_id, ws, "peer_disconnected")
            except Exception:  # noqa: BLE001
                log.exception(
                    "remote disconnect cleanup (after grace) failed for session %s", session_id
                )

        manager.remote_schedule_disconnect_grace(sess.session_id, role, _on_grace_expired)
