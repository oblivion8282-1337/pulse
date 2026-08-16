"""WebSocket op handlers for Pulse-Fernsteuerung (remote control).

The gateway is the **consent gate** plus a relay for two small payload kinds —
it never carries video (that rides the HQ-stream path). These handlers own the
consent handshake and forward SDP/ICE between the peer sockets (the P2P fallback
branch). Session bookkeeping lives in :mod:`remote_registry` (in-process,
single-pod).

Op flow::

    controller --remote_request--> gateway --remote_pending--> controller
                                   gateway --remote_request--> host (all tabs)
    host       --remote_respond--> gateway --remote_response--> both peers
    peer       --remote_signal---> gateway --remote_signal---> the *other* peer
    controller --remote_input----> gateway --remote_input----> host
    peer       --remote_end------> gateway --remote_ended----> the *other* peer

``remote_pending`` geht an den Steuernden, sobald die Sitzung angelegt ist und
**bevor** die Einladung an die Host-Tabs geht: ohne dieses Frame kennt der
Steuernde seine ``session_id`` erst mit der Zustimmung und kann bis dahin weder
abbrechen noch eine fremde Antwort von seiner eigenen unterscheiden.

Der Abbau (``remote_end``, Disconnect) liegt in
:mod:`routes.ws_remote_teardown`, der Eingabe-Weiterleiter in
:mod:`routes.ws_remote_input` (Wire-Protokoll v2, Spezifikation:
``docs/plans/2026-08-12-input-wire-protokoll-v2.md``) — drei Module, weil alle
zusammen die Groessen-Policy (§12.1) sprengen und der Abbau von zwei Seiten
(Op und Disconnect) gerufen wird.

Handler mit **verbindungsgebundenem Zustand** (die Bremsen) bekommen den
``WSOpContext``, die uebrigen nur Socket und Nutzer.

Error frames are fire-and-forget (``_err``) — the socket is never closed:
  * 4050 required field missing / invalid (input: bad slot, bad base64, or a
    batch over the limits — those frames are dropped, the session survives)
  * 4051 no access (not a member / no VIEW_CHANNEL / no REMOTE_CONTROL)
  * 4052 host not reachable (offline, not a member, or cannot see the channel)
  * 4053 no matching session / not a peer / input from the host, not the controller
  * 4054 host already has an active session
  * 4055 the host just refused (or ignored) an invite — cooldown running
  * 4056 der Rufer fragt zu schnell hintereinander an (Bremse, s. unten)
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable
from typing import Any

from fastapi import WebSocket

from dcc_chat_gateway.permissions import Permissions, has_permission, resolve_permissions
from dcc_chat_gateway.remote_guard import peer_channel_perms
from dcc_chat_gateway.remote_registry import send_to_socket
from dcc_chat_gateway.routes._deps import channel_membership
from dcc_chat_gateway.routes.ws_ops_registry import WSOpContext
from dcc_chat_gateway.security import AuthenticatedUser

log = logging.getLogger(__name__)

# Mindestpause zwischen zwei ``remote_request`` derselben Verbindung. Eine
# Anfrage kostet drei DB-Abfragen (Mitgliedschaft, Rechte des Rufers, Rechte des
# Hosts) und laesst beim Gegenueber einen modalen Dialog aufspringen; alle
# anderen teuren Ops auf diesem Socket (``resync``, ``typing``, ``send``) haben
# laengst eine Bremse, diese hier hatte gar keine. Zwei Sekunden liegen weit
# ueber dem legitimen Takt (ein Klick) und weit unter der Zustimmungsfrist.
_REQUEST_MIN_INTERVAL_S = 2.0

# Deckel und Nutzlastgrenze fuer ``remote_signal`` — der Zwilling von
# ``remote_input``: derselbe Weiterleiter, derselbe Empfaenger, nur SDP/ICE
# statt Eingabe-Frames. Der Deckel lag bisher nur auf ``remote_input``, womit
# ein Steuernder ueber ``remote_signal`` genau das tun konnte, was dort
# verhindert wird. 60/s liegt weit ueber einem ICE-Trickle-Schwall (einige
# Dutzend Kandidaten in der ersten Sekunde); 8 KiB fassen ein SDP-Angebot
# bequem und liegen unter der globalen 16-KiB-Frame-Grenze.
_SIGNAL_MAX_MESSAGES_PER_S = 60
_SIGNAL_MAX_DATA_BYTES = 8 * 1024

# Welche Arten der Weiterleiter durchlaesst. Drei davon sind die Verhandlung des
# direkten Eingabekanals (SDP/ICE); ``vorrang`` und ``zeiger`` sind die beiden
# Auskuenfte, die in die GEGENRICHTUNG laufen — der Host meldet, dass er selbst
# an Maus und Tastatur sitzt und die Fremdeingabe deshalb gerade verwirft
# (``streaming/win-hq-sidecar/src/remote_input/wache.rs``), bzw. welche FORM
# sein Zeiger gerade hat, damit der Steuernde I-Balken und Groessenpfeile sieht,
# obwohl das Cursor-Echo den Host-Zeiger aus dem Bild nimmt
# (``.../remote_input/zeigerform.rs``). Sie reiten hier mit, statt eigene Ops zu
# bekommen: derselbe Empfaenger, dieselbe Bindung an die per Consent bestaetigte
# Sitzung, derselbe Deckel — und ein paar Nachrichten je Sekunde fallen daneben
# nicht ins Gewicht.
#
# Der Gateway deutet den Inhalt so wenig wie bei SDP/ICE; wer eine Art an die
# falsche Seite schickt, findet dort keinen Abnehmer (``$lib/remote/vorrang.ts``
# und ``$lib/remote/zeigerform.ts`` hoeren nur als Steuernder zu). **Mit
# ``RemoteSignalKind`` synchron halten** (``web/src/lib/ws/handlers/types.ts``).
_SIGNAL_KINDS = ("offer", "answer", "ice", "vorrang", "zeiger")


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
    ctx: WSOpContext,
    msg: dict[str, Any],
    *,
    session_factory: Callable,
) -> None:
    websocket, user = ctx.websocket, ctx.user
    cid_int = _int_or_none(msg.get("channel_id"))
    host_uid = _int_or_none(msg.get("host_user_id"))
    if cid_int is None or host_uid is None or host_uid == user.id:
        await _err(websocket, 4050, "channel_id and a different host_user_id required")
        return
    mgr = _manager(websocket)
    if mgr is None:
        return
    # Bremse VOR den DB-Abfragen — sonst zahlt der Gateway die Flut, die sie
    # abwehren soll. Steht vor der Rechtepruefung, verraet also nichts ueber
    # Kanal oder Host (die Antwort haengt nur am eigenen Takt des Rufers).
    now = time.monotonic()
    waiting = _REQUEST_MIN_INTERVAL_S - (now - ctx.last_remote_request)
    if waiting > 0:
        await _err(
            websocket, 4056, f"too many remote requests, retry in {int(waiting) + 1}s"
        )
        return
    ctx.last_remote_request = now
    cid = str(cid_int)
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
        # Den Host als ``AuthenticatedUser`` aus seiner offenen Verbindung holen,
        # nicht aus der id nachbauen: der Resolver liest ``is_admin``/``is_owner``
        # daraus, und ein nachgebauter Nutzer mit is_admin=False wuerde einem
        # Instanz-Admin faelschlich VIEW_CHANNEL absprechen.
        host_sockets = mgr.remote_user_sockets(host_uid)
        host_user = mgr.remote_socket_user(host_sockets[0]) if host_sockets else None
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
    # Socket-Liste FRISCH holen: zwischen dem Lesen oben und hier liegen drei
    # ``await`` auf der Datenbank. Schloss der Stellvertreter-Tab in diesem
    # Fenster, bekaeme die Sitzung einen toten ``host_socket`` (Host bis zum
    # Zeitgeber blockiert), und ein inzwischen geoeffneter Tab bekaeme keine
    # Einladung, spaeter aber ein ``remote_canceled``.
    host_sockets = mgr.remote_user_sockets(host_uid)
    if not host_sockets:
        await _err(websocket, 4052, "host not reachable", audit=True)
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
    # Der Steuernde erfaehrt seine Sitzung SOFORT — vor der Faecherung. Bekaeme
    # er sie erst mit der Zustimmung, koennte er in der Wartezeit weder
    # abbrechen noch eine Antwort als die zu seiner Anfrage erkennen.
    await send_to_socket(
        websocket,
        {
            "op": "remote_pending",
            "session_id": sess.session_id,
            "channel_id": cid,
            "host_user_id": str(host_uid),
        },
    )
    frame = {
        "op": "remote_request",
        "session_id": sess.session_id,
        "channel_id": cid,
        "from_user_id": str(user.id),
    }
    # **Welches GERAET gemeint ist**, sofern der Rufer es an einer Geraete-Kachel
    # angefragt hat (Bughunt 2026-08-16). Die Einladung geht an alle Tabs des
    # Hosts — also auch an seinen Laptop, wenn dort dasselbe Konto laeuft. Ohne
    # diese Angabe koennte dort jemand zustimmen, und der Steuernde saehe den
    # Werkstatt-PC, waehrend seine Eingaben an den Laptop gingen (sie fielen dort
    # zwar meist als „unbekannter Platz" durch, aber eben nicht zwingend).
    # Weitergereicht und NICHT geprueft: welcher Rechner welches Geraet ist,
    # weiss nur er selbst — er lehnt still ab, wenn er nicht gemeint ist.
    geraet = str(msg.get("device_id") or "").strip()
    if geraet:
        frame["device_id"] = geraet
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
    # Ist der Host ein eingetragenes Standplatz-Geraet, steht es ab jetzt als
    # „belegt" in der Kanalliste — samt Namen dessen, der steuert. Die Zuordnung
    # laeuft ueber den SOCKET: die Sitzung kennt ihren Host als Verbindung, und
    # erst das Geraeteregister weiss, welcher Rechner das ist. Fehlertolerant,
    # denn eine Zustimmung darf nie an einer Anzeige haengen.
    geraet = mgr.device_for_socket(websocket)
    if geraet is not None:
        try:
            mgr.device_set_busy(geraet, sess.controller_user_id, websocket)
            await mgr.publish_device_state(geraet)
        except Exception:  # noqa: BLE001  # pragma: no cover
            log.debug("device busy state not published", exc_info=True)


def _signal_data_too_large(data: Any) -> bool:
    """Ist die SDP/ICE-Nutzlast groesser als erlaubt? Gemessen an ihrer
    JSON-Laenge — ``data`` kam selbst aus JSON, ist also serialisierbar."""
    try:
        return len(json.dumps(data, separators=(",", ":"))) > _SIGNAL_MAX_DATA_BYTES
    except (TypeError, ValueError):  # nicht serialisierbar → nicht weiterreichen
        return True


async def handle_signal(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    websocket = ctx.websocket
    # Der Deckel steht VOR allem anderen — wie beim Eingabe-Weiterleiter: sonst
    # zahlt der Gateway die Ablehnung einer Flut mit je einer Log- und einer
    # Antwortnachricht und verstaerkt sie, statt sie zu daempfen. Verworfen wird
    # still (kein 4050): eine Flut zu beantworten ist Teil des Problems.
    count = ctx.remote_signal_rate.hit()
    if count > _SIGNAL_MAX_MESSAGES_PER_S:
        if count == _SIGNAL_MAX_MESSAGES_PER_S + 1:
            # Genau einmal je Fenster, und auf DEBUG: der Deckel greift vor
            # jeder Autorisierung, INFO gehoert erst dahinter (s. ``_err``).
            log.debug("remote signal rate cap hit for user=%s — dropping", ctx.user.id)
        return
    session_id = _session_id(msg.get("session_id"))
    kind = msg.get("kind")
    data = msg.get("data")
    if not session_id or kind not in _SIGNAL_KINDS or data is None:
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
    # Groessenpruefung erst hier: sie kostet ein ``json.dumps``, und das soll
    # nur zahlen, wer die Sitzung wirklich hat.
    if _signal_data_too_large(data):
        await _err(websocket, 4050, "signal data too large")
        return
    await send_to_socket(
        peer,
        {"op": "remote_signal", "session_id": session_id, "kind": kind, "data": data},
    )
