"""WebSocket op handlers for Pulse-Fernsteuerung (remote control).

The gateway is the **consent gate** plus a relay for two small payload kinds —
it never carries video (that rides the HQ-stream path). These handlers own the
consent handshake, forward SDP/ICE between the peer sockets (the P2P fallback
branch), and pass the controller's **input frames** to the host. Session
bookkeeping lives in :mod:`remote_registry` (in-process, single-pod).

Op flow::

    controller --remote_request--> gateway --remote_request--> host (all tabs)
    host       --remote_respond--> gateway --remote_response--> both peers
    peer       --remote_signal---> gateway --remote_signal---> the *other* peer
    controller --remote_input----> gateway --remote_input----> host
    peer       --remote_end------> gateway --remote_ended----> the *other* peer

``remote_input`` lives in :mod:`routes.ws_remote_input` (wire protocol v2, spec:
``docs/plans/2026-08-12-input-wire-protokoll-v2.md``) — its own module because
the relay carries per-connection flood state that the consent handshake here
has no business knowing, and both together burst the §12.1 size policy.

Error frames are fire-and-forget (``_err``) — the socket is never closed:
  * 4050 required field missing / invalid (input: bad slot, bad base64, or a
    batch over the limits — those frames are dropped, the session survives)
  * 4051 no access (not a member / no VIEW_CHANNEL / no REMOTE_CONTROL)
  * 4052 host not reachable (offline, not a member, or cannot see the channel)
  * 4053 no matching session / not a peer / input from the host, not the controller
  * 4054 host already has an active session
  * 4055 the host just refused (or ignored) an invite — cooldown running
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from fastapi import WebSocket

from dcc_chat_gateway.permissions import Permissions, has_permission, resolve_permissions
from dcc_chat_gateway.remote_guard import peer_channel_perms
from dcc_chat_gateway.remote_registry import send_to_socket
from dcc_chat_gateway.routes._deps import channel_membership
from dcc_chat_gateway.security import AuthenticatedUser

log = logging.getLogger(__name__)


def _int_or_none(value: object) -> int | None:
    """Parse a stringified snowflake (channel_id / host_user_id) to int, or
    ``None`` when it is missing or malformed."""
    s = str(value or "").strip()
    if not s:
        return None
    try:
        return int(s)
    except ValueError:
        return None


def _session_id(value: object) -> str:
    return str(value or "").strip()


def _manager(websocket: WebSocket):
    return getattr(websocket.app.state, "connection_manager", None)


async def _err(websocket: WebSocket, code: int, msg: str, *, audit: bool = False) -> None:
    """Reject one op. Der Code allein genuegt (4051 = kein Zugriff, 4052 = Host
    nicht erreichbar, …); Nutzdaten stehen bewusst nicht drin.

    ``audit=True`` heisst INFO, sonst DEBUG. Am 2026-08-12 im Zwei-Geraete-Test
    war eine Ablehnung am Client nur als ausbleibende Wirkung sichtbar (toter
    Knopf) — deshalb ueberhaupt eine Zeile. Sie stand aber VOR jeder
    Autorisierung: ein beliebiger eingeloggter Nutzer konnte mit missgeformten
    ``remote_*``-Ops unbegrenzt INFO-Zeilen erzeugen und damit das Protokoll
    fluten. INFO gibt es jetzt nur noch, wenn der Rufer die Rechtepruefung
    bereits bestanden hat — genau die Faelle, die im Test die Frage
    beantworteten ("Host nicht erreichbar", "schon belegt")."""
    if audit:
        log.info("remote op rejected: code=%s msg=%s", code, msg)
    else:
        log.debug("remote op rejected: code=%s msg=%s", code, msg)
    await websocket.send_json({"op": "error", "code": code, "msg": msg})


async def handle_request(
    websocket: WebSocket,
    user: AuthenticatedUser,
    msg: dict[str, Any],
    *,
    session_factory: Callable,
) -> None:
    cid_int = _int_or_none(msg.get("channel_id"))
    host_uid = _int_or_none(msg.get("host_user_id"))
    if cid_int is None or host_uid is None or host_uid == user.id:
        await _err(websocket, 4050, "channel_id and a different host_user_id required")
        return
    mgr = _manager(websocket)
    if mgr is None:
        return
    cid = str(cid_int)
    host_sockets = mgr.remote_user_sockets(host_uid)
    # Den Host als ``AuthenticatedUser`` aus seiner offenen Verbindung holen,
    # nicht aus der id nachbauen: der Resolver liest ``is_admin``/``is_owner``
    # daraus, und ein nachgebauter Nutzer mit is_admin=False wuerde einem
    # Instanz-Admin faelschlich VIEW_CHANNEL absprechen.
    host_user = mgr.remote_socket_user(host_sockets[0]) if host_sockets else None
    async with session_factory() as session:
        channel = await channel_membership(session, cid_int, user.id)
        if channel is None:
            # Same 4051 whether the channel is hidden or the caller isn't a
            # member — never confirm a hidden channel's existence.
            await _err(websocket, 4051, "no access")
            return
        perms = await resolve_permissions(session, user, channel.guild_id, cid_int)
        if not has_permission(perms, Permissions.VIEW_CHANNEL) or not has_permission(
            perms, Permissions.REMOTE_CONTROL
        ):
            await _err(websocket, 4051, "no access")
            return
        if not host_sockets or host_user is None:
            # Der haeufigste Grund fuer "der Knopf tut nichts": der Host ist zwar
            # Mitglied, hat aber gerade keine offene Verbindung. Die Zeile im Log
            # trennt das von "gar nicht angekommen".
            await _err(websocket, 4052, "host not reachable", audit=True)
            return
        # Der Host muss Mitglied sein UND den Kanal sehen duerfen. Ohne den
        # VIEW_CHANNEL-Teil wurde bisher jemand zur Hergabe seines Rechners in
        # einem Kanal eingeladen, den er selbst nicht sehen darf. Dieselbe
        # Funktion, die die Rechte-Wache spaeter im Takt anlegt — die beiden
        # Latten duerfen nicht auseinanderlaufen, sonst beendet der Prueflauf
        # sofort, was der Aufbau gerade erlaubt hat. Kein Stream-Check:
        # Fernsteuerung ist unabhaengig vom HQ-Streaming.
        host_perms = await peer_channel_perms(session, cid_int, host_user)
        if host_perms is None or not has_permission(host_perms, Permissions.VIEW_CHANNEL):
            await _err(websocket, 4052, "host not reachable")
            return
    # Sperrfrist nach Absage/Aussitzen. Sie steht hinter der Rechtepruefung,
    # damit ein Unberechtigter aus der Antwort nicht ablesen kann, ob der Host
    # gerade jemand anderem abgesagt hat.
    wait_s = mgr.remote_refusal_wait_s(str(host_uid), str(user.id))
    if wait_s > 0:
        await _err(
            websocket, 4055, f"host declined recently, retry in {int(wait_s) + 1}s", audit=True
        )
        return
    log.info(
        "remote request accepted for relay: channel=%s host_sockets=%d",
        cid,
        len(host_sockets),
    )
    sess = await mgr.remote_create(cid, host_uid, host_sockets[0], user.id, websocket)
    if sess is None:
        await _err(websocket, 4054, "host already has an active remote session", audit=True)
        return
    frame = {
        "op": "remote_request",
        "session_id": sess.session_id,
        "channel_id": cid,
        "from_user_id": str(user.id),
    }
    # Zeitgeber VOR der Faecherung scharfstellen. Jedes ``send_to_socket``
    # unten ist ein await: antwortet ein Host-Tab mitten in der Faecherung,
    # loeschte der Accept einen Zeitgeber, den es noch gar nicht gab — und der
    # danach gestellte liefe 30 s lang auf einer bereits beendeten Sitzung
    # weiter und hielte deren Socket-Referenz am Leben.
    mgr.remote_schedule_timeout(sess.session_id, websocket)
    for hs in host_sockets:
        await send_to_socket(hs, frame)


async def handle_respond(
    websocket: WebSocket, user: AuthenticatedUser, msg: dict[str, Any]
) -> None:
    session_id = _session_id(msg.get("session_id"))
    accept = msg.get("accept")
    if not session_id or not isinstance(accept, bool):
        await _err(websocket, 4050, "session_id and boolean accept required")
        return
    mgr = _manager(websocket)
    if mgr is None:
        return
    sess = mgr.remote_get(session_id)
    # Only the invited host may answer their own session.
    if sess is None or sess.host_user_id != str(user.id):
        await _err(websocket, 4053, "no such session")
        return
    # Only a still-pending session may be answered. A second respond of EITHER
    # polarity — a second host tab, or the same tab changing its mind after
    # accepting — must NOT tear down or re-notify an already-active session
    # (decline would otherwise `remote_end` a live session; both would fan out a
    # stale `remote_canceled`). Bail before any side effect so accept and decline
    # are symmetric with the activate guard below.
    if sess.state != "pending":
        await _err(websocket, 4053, "session already answered")
        return
    # EVERY side effect (dismiss/notify/teardown) must happen only AFTER this tab
    # atomically wins the answer — otherwise, in a concurrent double-answer, a
    # losing tab's `remote_dismiss_host_tabs` broadcast could reach and reset the
    # winning tab (orphaning a live session). Accept wins via `remote_activate`
    # (pending→active CAS), decline via `remote_end_if_pending` (pop-if-pending);
    # the loser gets 4053 and touches nothing.
    if not accept:
        removed = await mgr.remote_end_if_pending(session_id)
        if removed is None:
            await _err(websocket, 4053, "session already answered")
            return
        mgr.remote_cancel_timeout(session_id)
        # "Nein" haelt eine Weile. Ohne Sperrfrist kostet eine Absage nichts und
        # ein Berechtigter kann dem Host den modalen Dialog beliebig oft vor die
        # Nase setzen — Belaestigung mit Bordmitteln.
        mgr.remote_note_refused(removed.host_user_id, removed.controller_user_id)
        await mgr.remote_dismiss_host_tabs(removed, answered=websocket)
        await send_to_socket(
            removed.controller_socket,
            {"op": "remote_response", "session_id": session_id, "accepted": False},
        )
        return
    if not await mgr.remote_activate(session_id):
        await _err(websocket, 4053, "no such session")
        return
    mgr.remote_cancel_timeout(session_id)
    # This socket now owns the live session (authoritative host peer for signal
    # forwarding). Only the winner dismisses the other tabs → no tab can dismiss
    # the winner.
    sess.host_socket = websocket
    await mgr.remote_dismiss_host_tabs(sess, answered=websocket)
    frame = {"op": "remote_response", "session_id": session_id, "accepted": True}
    await send_to_socket(sess.controller_socket, frame)
    await send_to_socket(websocket, frame)


async def handle_signal(
    websocket: WebSocket, user: AuthenticatedUser, msg: dict[str, Any]
) -> None:
    session_id = _session_id(msg.get("session_id"))
    kind = msg.get("kind")
    data = msg.get("data")
    if not session_id or kind not in ("offer", "answer", "ice") or data is None:
        await _err(websocket, 4050, "session_id, kind and data required")
        return
    mgr = _manager(websocket)
    if mgr is None:
        return
    sess = mgr.remote_get(session_id)
    if sess is None or sess.state != "active":
        await _err(websocket, 4053, "no active session")
        return
    if websocket is sess.host_socket:
        peer = sess.controller_socket
    elif websocket is sess.controller_socket:
        peer = sess.host_socket
    else:
        await _err(websocket, 4053, "not a session peer")
        return
    await send_to_socket(
        peer,
        {"op": "remote_signal", "session_id": session_id, "kind": kind, "data": data},
    )


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
    other = (
        removed.controller_socket
        if websocket is removed.host_socket
        else removed.host_socket
    )
    await send_to_socket(
        other,
        {"op": "remote_ended", "session_id": removed.session_id, "reason": reason},
    )
    # War die Sitzung noch nicht angenommen, steht der Zustimmungsdialog auf
    # JEDEM Host-Tab (``host_socket`` ist nur der Stellvertreter). Bleibt er
    # stehen, haengt der Dialog, und ein spaeteres "Zulassen" laeuft in 4053, was
    # das Frontend in der Phase 'incoming' verschluckt: der Host waere danach
    # fuer alle unerreichbar.
    if removed.state != "active":
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
    if websocket is not sess.host_socket and websocket is not sess.controller_socket:
        await _err(websocket, 4053, "not a session peer")
        return
    await _end_and_notify_peer(mgr, session_id, websocket, "peer_ended")


async def cleanup_remote_on_disconnect(websocket: WebSocket, manager) -> None:
    """Socket closing: end every remote session this socket was a peer of and
    tell the other peer immediately — no grace window (unlike watch parties)."""
    for sess in manager.remote_sessions_for_socket(websocket):
        try:
            await _end_and_notify_peer(manager, sess.session_id, websocket, "peer_disconnected")
        except Exception:  # noqa: BLE001
            log.exception("remote disconnect cleanup failed for session %s", sess.session_id)
