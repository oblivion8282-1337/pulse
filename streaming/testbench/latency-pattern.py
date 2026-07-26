#!/usr/bin/env python3
"""Zeitmuster für die Ende-zu-Ende-Messung: das Bild trägt die Uhrzeit selbst.

Malt auf JEDEN Bildschirm ein Vollbild-Fenster, in dem an zwölf festen Stellen
ein Balken aus schwarzen und weißen Klötzen steht. Der Balken kodiert die
Millisekunden seit einer gemeinsamen Epoche — also eine Uhr, die durch die ganze
Kette mitreist: Aufnahme, Encoder, Netz, MediaMTX, Decoder, Fenster.

Der Player liest den Balken aus dem DEKODIERTEN Bild zurück
(`PULSE_PLAYER_LATENCY_PROBE=1`, `src/probe.rs`) und rechnet
`jetzt - abgelesene Zeit`. Damit braucht die Messung kein Bildschirmfoto, keine
Texterkennung und keine Fensterposition.

Drei Entscheidungen, die nicht offensichtlich sind:

* **Vollbild auf jedem Bildschirm.** Unter Wayland darf ein Fenster seine
  Position nicht selbst setzen, Vollbild auf einem bestimmten Ausgang aber schon.
  Weil nicht feststeht, welchen Bildschirm der Sender aufnimmt, wird jeder
  bemalt.
* **Durchsichtig und ganz nach vorn.** Zuerst lag das Fenster ganz hinten, mit
  schwarzer Fläche. Das ging, solange nichts anderes auf dem Bildschirm lief —
  sobald für eine Qualitäts- oder Bitratenmessung ein Video abgespielt wurde,
  verdeckte dieses das Muster und die Sonde fand nichts mehr. Umgekehrt hätte
  eine deckende Fläche vorn den Bildinhalt verdeckt und die Bitrate auf nahezu
  null gedrückt. Durchsichtig mit undurchsichtigen Balken löst beides: der
  Inhalt bleibt sichtbar, die Uhr auch. Mausklicks gehen hindurch.
* **Zwölf Kopien des Balkens.** Das Player-Fenster verdeckt einen Teil des
  Musters, und wo es liegt, ist unbekannt. Der Player probiert die zwölf Stellen
  durch und nimmt die erste unverdeckte.

Aufruf (die Epoche MUSS mit dem Player übereinstimmen):

    PULSE_LATENCY_EPOCH_MS=$(date +%s%3N) ./latency-pattern.py
"""

from __future__ import annotations

import os
import sys
import time

from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QColor, QPainter
from PySide6.QtWidgets import QApplication, QWidget

# ── Musterformat — MUSS mit `pulse-player/src/probe.rs` übereinstimmen ────────
BLOCK = 32                      # Kantenlänge eines Klotzes in Bildpunkten
MARKER = [1, 0, 1, 1, 0, 0, 1, 0]   # Erkennungsmuster vor dem Zähler
COUNTER_BITS = 16               # Zähler in Millisekunden, läuft nach 65,5 s um
BLOCKS = len(MARKER) + COUNTER_BITS
BAR_W = BLOCKS * BLOCK
# Zwölf Stellen, an denen ein Balken steht (linke obere Ecke, in Bildpunkten des
# jeweiligen Bildschirms). Passt bis 2560x1440.
POSITIONS = [(x, y) for y in (64, 400, 800, 1200) for x in (64, 880, 1696)]


class PatternWindow(QWidget):
    def __init__(self, epoch_ms: int) -> None:
        super().__init__()
        self.epoch_ms = epoch_ms
        self.setWindowTitle("Pulse Latenz-Muster")
        # Nach hinten, kein Rahmen, kein Eingabe-Fokus: das Fenster soll die
        # Bedienung nicht stören, es soll nur sichtbar sein.
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.WindowDoesNotAcceptFocus
        )
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        # Klicks gehen durch — sonst waere der halbe Bildschirm blockiert.
        self.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
        # KEIN Füllen der ganzen Fläche: das kostete auf drei Bildschirmen so
        # viel Leistung, dass die Messung ihre eigene Last mitmaß (Dekodieren
        # stieg von 1,6 auf 4,8 ms, die Aufnahme fiel auf 30 Bilder). Gezeichnet
        # werden nur die Balken.
        # 8 ms Raster. Der Zähler wird beim Zeichnen aus der Uhr gelesen, ist
        # also immer exakt; das Raster bestimmt nur, wie alt der angezeigte Wert
        # höchstens ist. Nachgemessen am 2026-07-26: mit 2 ms wurde die
        # Ende-zu-Ende-Zahl SCHLECHTER (98,4 statt 96,1 ms) und die Aufnahme
        # brach auf 6 Bilder ein — häufiger zu zeichnen kostet mehr, als die
        # feinere Auflösung bringt. Nicht "optimieren".
        self.timer = QTimer(self)
        self.timer.setInterval(8)
        self.timer.timeout.connect(self._refresh)
        self.timer.start()

    def _refresh(self) -> None:
        """Nur die Balken für ungültig erklären, nicht die ganze Fläche.

        Ein `update()` ohne Bereich lässt Qt 2560x1440 Bildpunkte neu malen, und
        das dreimal (ein Fenster je Bildschirm) — genug Last, um die Messung zu
        verfälschen. Mit Bereichen sind es 12 x 768 x 36 Punkte.
        """
        for x0, y0 in POSITIONS:
            self.update(x0, y0, BAR_W, BLOCK + 4)

    def paintEvent(self, _event) -> None:  # noqa: N802 (Qt-Namensschema)
        counter = int(time.time() * 1000 - self.epoch_ms) & 0xFFFF
        bits = MARKER + [(counter >> (COUNTER_BITS - 1 - i)) & 1 for i in range(COUNTER_BITS)]
        p = QPainter(self)
        # Deckend zeichnen statt zu überlagern. Nötig ist es beim heutigen
        # Aufbau nicht — jeder Klotz wird in jedem Durchgang vollflächig neu
        # gefüllt, ein Wechsel von 1 auf 0 überschreibt also dieselbe Fläche.
        # Es steht als Absicherung da, falls je halbdurchsichtig oder mit
        # weichen Kanten gezeichnet wird: dann blieben ohne diesen Modus auf
        # einem durchsichtigen Fenster Reste stehen.
        p.setCompositionMode(QPainter.CompositionMode.CompositionMode_Source)
        white, black = QColor(255, 255, 255), QColor(0, 0, 0)
        for x0, y0 in POSITIONS:
            if x0 + BAR_W > self.width() or y0 + BLOCK > self.height():
                continue
            for i, bit in enumerate(bits):
                p.fillRect(x0 + i * BLOCK, y0, BLOCK, BLOCK, white if bit else black)
            # Weißer Strich unter dem Balken: macht den Ort für einen Menschen
            # auffindbar, wenn die Messung mal von Hand nachgesehen wird.
            p.fillRect(x0, y0 + BLOCK, BAR_W, 4, white)
        p.end()


def main() -> int:
    epoch = os.environ.get("PULSE_LATENCY_EPOCH_MS")
    if not epoch or not epoch.isdigit():
        print("PULSE_LATENCY_EPOCH_MS fehlt (Millisekunden seit 1970)", file=sys.stderr)
        return 2
    app = QApplication(sys.argv)
    windows = []
    for screen in app.screens():
        w = PatternWindow(int(epoch))
        w.setScreen(screen)
        w.setGeometry(screen.geometry())
        w.showFullScreen()
        # Nach `show` noch einmal auf den Bildschirm festnageln: Qt setzt den
        # Screen sonst beim Anzeigen nach eigenem Gutdünken.
        if w.windowHandle() is not None:
            w.windowHandle().setScreen(screen)
        windows.append(w)
    print(f"Muster auf {len(windows)} Bildschirm(en), Epoche {epoch}", flush=True)
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
