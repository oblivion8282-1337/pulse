"""``remote_input`` — der Eingabe-Weiterleiter der Fernsteuerung.

Wire-Protokoll v2, Abschnitt "Die Huelle auf dem Serverweg"
(``docs/plans/2026-08-12-input-wire-protokoll-v2.md``). Der Gateway prueft
Sitzung, Rolle, Groesse und Takt — und **parst die Frames nicht**: das Protokoll
ein zweites Mal in Python nachzubauen hiesse, es an zwei Stellen zu pflegen,
ohne dass der Gateway etwas davon haette.

Eigenes Modul, weil der Weiterleiter als einziger ``remote_*``-Op
**verbindungsgebundenen Zustand** braucht (den Sekundendeckel) und deshalb den
``WSOpContext`` bekommt statt nur Socket und Nutzer — der Zustimmungs-Handshake
in :mod:`routes.ws_remote_handlers` hat damit nichts zu tun.

Ablehnungen verwerfen immer nur die Frames *dieser* Nachricht; die Sitzung
bleibt stehen. Wer eine Grenze ueberschreitet, soll eine Mausbewegung verlieren,
nicht seine Sitzung.
"""

from __future__ import annotations

import base64
import logging
from typing import Any

from dcc_shared.streaming import SLOT_MAX

from dcc_chat_gateway.remote_registry import send_to_socket
from dcc_chat_gateway.routes.ws_ops_registry import WSOpContext
from dcc_chat_gateway.routes.ws_remote_handlers import _err, _manager, _session_id

log = logging.getLogger(__name__)

# Grenzen je Nachricht (Protokoll v2, "Grenzen"). Sie schuetzen den *Gateway*,
# nicht den Host — der ist fuer sich selbst fail-closed. Der groesste Frame ist
# 5 Byte, ein gutartiger Steuernder kommt nie in ihre Naehe.
MAX_INPUT_FRAMES = 32
MAX_INPUT_DECODED_BYTES = 1024

# Deckel je Sekunde. Die Grenzen oben formen nur eine EINZELNE Nachricht; ohne
# Takt-Deckel kostet ein Verstoss nichts und ein Steuernder flutet mit
# Leitungsgeschwindigkeit Gateway und Host. Der Steuernde gibt Bewegungen im
# Bildtakt ab, also grob 120 Nachrichten/s bei 120 Hz — der Deckel liegt
# deutlich darueber, damit ein Stau beim Nachholen nicht in die Grenze laeuft.
MAX_INPUT_MESSAGES_PER_S = 300


def _within_rate(ctx: WSOpContext) -> bool:
    """Zaehlt diese Nachricht in das Ein-Sekunden-Fenster der Verbindung und
    sagt, ob sie noch durchdarf.

    Das Fenster **springt**, es rollt nicht (Begruendung an
    :class:`~routes.ws_ops_registry.SecondWindow`): an der Fenstergrenze passen
    kurz bis zu 600 Nachrichten durch. Bei hoechstens 1024 dekodierten Byte je
    Nachricht ist das folgenlos — hier stand frueher "rollend", was schlicht
    falsch war."""
    count = ctx.remote_input_rate.hit()
    if count <= MAX_INPUT_MESSAGES_PER_S:
        return True
    if count == MAX_INPUT_MESSAGES_PER_S + 1:
        # Genau einmal je Fenster: eine Zeile je verworfener Nachricht waere
        # dieselbe Flut, nur im Log. Und auf DEBUG, nicht INFO: der Deckel
        # greift VOR jeder Autorisierung — genau die Stelle, an der ein
        # beliebiger eingeloggter Nutzer sonst das Protokoll fluten kann
        # (dieselbe Regelung wie ``_err(audit=...)``).
        log.debug("remote input rate cap hit for user=%s — dropping", ctx.user.id)
    return False


def _input_payload_error(msg: dict[str, Any]) -> str | None:
    """``None`` when ``slot`` and ``frames`` are well-formed and within the
    per-message limits, else the reason for the 4050. Frames are only
    *measured*: the decoded bytes are discarded, never interpreted."""
    slot = msg.get("slot")
    if not isinstance(slot, int) or isinstance(slot, bool) or slot < 0:
        # Fehlend, kein Ganzzahl-Typ oder negativ = Huellenfehler, kein
        # "unbekannter Platz": das Rennen, das die Verwerf-Regel weiter unten
        # tolerieren soll (Stream endet zwischen Absenden und Ankunft), kann
        # keinen negativen Index erzeugen — nur ein kaputter oder boesartiger
        # Sender kann das. Zu gross dagegen ist unbekannt (s. handle_input).
        return "slot must be a non-negative integer"
    frames = msg.get("frames")
    if not isinstance(frames, list) or not frames:
        return "frames must be a non-empty list"
    if len(frames) > MAX_INPUT_FRAMES:
        return f"at most {MAX_INPUT_FRAMES} frames per message"
    total = 0
    for frame in frames:
        if not isinstance(frame, str):
            return "frames must be base64 strings"
        try:
            total += len(base64.b64decode(frame, validate=True))
        except ValueError:  # bad alphabet/padding, or a non-ASCII string
            return "frames must be base64 strings"
        if total > MAX_INPUT_DECODED_BYTES:
            return f"at most {MAX_INPUT_DECODED_BYTES} decoded bytes per message"
    return None


async def handle_input(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    """Forward input frames from the controller to the host, unchanged."""
    websocket = ctx.websocket
    # Der Deckel steht VOR allem anderen — auch vor ``_err``. Sonst zahlt der
    # Gateway die Ablehnung einer Flut mit je einer Log- und einer
    # Antwort-Nachricht und verstaerkt sie damit, statt sie zu daempfen.
    if not _within_rate(ctx):
        return
    session_id = _session_id(msg.get("session_id"))
    if not session_id:
        await _err(websocket, 4050, "session_id required")
        return
    mgr = _manager(websocket)
    if mgr is None:
        return
    sess = mgr.remote_get(session_id)
    if sess is None or sess.state != "active":
        await _err(websocket, 4053, "no active session")
        return
    # One-way street: only the controller sends. The host is the injector, so
    # input arriving from it would mean it is driving itself.
    if websocket is not sess.controller_socket:
        await _err(websocket, 4053, "only the controlling peer may send input")
        return
    problem = _input_payload_error(msg)
    if problem is not None:
        await _err(websocket, 4050, problem)
        return
    # Platz ausserhalb der Grenze = **unbekannter Platz**, nicht Protokollfehler
    # (v2, praezisiert 2026-08-12): still verwerfen, Sitzung stehen lassen,
    # und den Wert NICHT auf 0 zurechtbiegen — ein verbogener Platz waere ein
    # Klick auf dem falschen Bildschirm. Ohne diese Zeile war der Gateway
    # lockerer als der Host, und genau der Unterschied beendete die Sitzung.
    # Die Obergrenze kommt aus ``dcc_shared.streaming`` (dieselbe Zahl, die die
    # Stream-Token begrenzt); wie viele Streams wirklich laufen, weiss nur der
    # Host — der verwirft in seiner Aufloesung ebenso still.
    if msg["slot"] > SLOT_MAX:
        log.debug("remote input for out-of-range slot %s dropped", msg["slot"])
        return
    # ``slot`` selects one of the host's concurrent streams; resolving it to a
    # source rectangle is the host's job.
    await send_to_socket(
        sess.host_socket,
        {
            "op": "remote_input",
            "session_id": session_id,
            "slot": msg["slot"],
            "frames": msg["frames"],
        },
    )
