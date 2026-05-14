"""Token-Redaction für Sidecar-Responses und GSR-Log-Forwarding.

Die Push-URL trägt den Stream-Token entweder als ``?pass=<token>``
(RTMP/RTMPS) oder als ``streamid=publish:<path>:<user>:<token>`` (SRT)
in Klartext. Sie taucht damit in zwei Pfaden auf, die NIE den Token
durchlassen dürfen:

1. ``StreamController.last_argv`` — fließt über ``op_build_argv``,
   ``op_start`` und ``op_state`` als IPC-Response in den Renderer und
   kann dort über DevTools / CSS-Selectors zu einem JS-Kontext-Leak werden.
2. ``gpu-screen-recorder`` schreibt die Verbindung beim Connect auf
   stderr (z.B. ``Successfully connected to rtmps://…?pass=xxx``). Die
   Zeile wird vom ``_reader_loop`` an ``on_log`` durchgereicht und landet
   im Frontend-Diagnose-Pane.

``redact_token_string`` ersetzt den Token-Wert durch ``***``. Andere
Felder (``user=``, ``streamid=publish:<path>``) bleiben unverändert,
damit Diagnosen weiterhin sinnvoll sind.
"""
from __future__ import annotations

import re
from collections.abc import Iterable

# RTMP/RTMPS: ``?pass=<token>`` oder ``&pass=<token>``
_PASS_RE = re.compile(r"((?:[?&])pass=)([^&\s'\"]+)")
# Defensive: ``?token=<token>`` oder ``&token=<token>``
_TOKEN_QS_RE = re.compile(r"((?:[?&])token=)([^&\s'\"]+)")
# SRT: ``streamid=publish:<path>:<user>:<token>`` (genau drei ``:``-Trenner
# nach ``publish:``). Wir redacten nur das letzte Segment.
_SRT_STREAMID_RE = re.compile(
    r"(streamid=publish:[^:&\s'\"]+:[^:&\s'\"]+:)([^&\s'\"]+)"
)

_REPLACEMENT = "***"


def redact_token_string(value: str) -> str:
    """Ersetzt Stream-Token in einer beliebigen Zeichenkette durch ``***``.

    Idempotent (wiederholtes Aufrufen ändert nichts).
    """
    s = _PASS_RE.sub(lambda m: f"{m.group(1)}{_REPLACEMENT}", value)
    s = _TOKEN_QS_RE.sub(lambda m: f"{m.group(1)}{_REPLACEMENT}", s)
    s = _SRT_STREAMID_RE.sub(lambda m: f"{m.group(1)}{_REPLACEMENT}", s)
    return s


def redact_argv(argv: Iterable[str]) -> list[str]:
    """Wendet ``redact_token_string`` auf jedes Element einer argv-Liste an."""
    return [redact_token_string(a) for a in argv]
