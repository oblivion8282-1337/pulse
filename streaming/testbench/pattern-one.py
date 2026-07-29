#!/usr/bin/env python3
"""Zeitmuster auf GENAU EINEN Bildschirm malen.

Das Original (`latency-pattern.py`) bemalt jeden Bildschirm, weil dort nicht
feststeht, welchen der Sender aufnimmt. Für den Vergleich mit dem Browser geht
das nicht: der Browser zeigt die Aufnahme 1:1 auf einem ZWEITEN Schirm, und die
Balken des Originals lägen dort exakt über den übertragenen Balken — beide
unlesbar. Deshalb hier nur der Quell-Schirm.

Ausgewählt wird über die X-Position (`PULSE_PATTERN_X`, Vorgabe 2560 = DP-2,
der OLED, den das Portal-Token aufnimmt). Zeichnet mit derselben `PatternWindow`
wie das Original — hier per `importlib` nachgeladen, weil der Bindestrich im
Dateinamen `latency-pattern.py` einen normalen Import verhindert (dasselbe
Vorgehen wie in `fern-harness.py` für `real-harness.py`).

    PULSE_LATENCY_EPOCH_MS=$(date +%s%3N) PULSE_PATTERN_X=2560 ./pattern-one.py
"""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

from PySide6.QtWidgets import QApplication

HERE = Path(__file__).parent
_spec = importlib.util.spec_from_file_location("lp", HERE / "latency-pattern.py")
_lp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_lp)
PatternWindow = _lp.PatternWindow


def main() -> int:
    epoch = os.environ.get("PULSE_LATENCY_EPOCH_MS")
    if not epoch or not epoch.isdigit():
        print("PULSE_LATENCY_EPOCH_MS fehlt", file=sys.stderr)
        return 2
    want_x = int(os.environ.get("PULSE_PATTERN_X", "2560"))
    app = QApplication(sys.argv)
    ziel = next((s for s in app.screens() if s.geometry().x() == want_x), None)
    if ziel is None:
        vorhanden = [s.geometry().x() for s in app.screens()]
        print(f"Kein Schirm bei x={want_x} (vorhanden: {vorhanden})", file=sys.stderr)
        return 2
    w = PatternWindow(int(epoch), title="Pulse Latenz-Muster (ein Schirm)")
    w.setScreen(ziel)
    w.setGeometry(ziel.geometry())
    w.showFullScreen()
    if w.windowHandle() is not None:
        w.windowHandle().setScreen(ziel)
    print(f"Muster auf Schirm bei x={want_x}, Epoche {epoch}", flush=True)
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
