"""Gemeinsames Format des Zeitmuster-Balkens.

MUSS mit `pulse-player/src/probe.rs` übereinstimmen. Vier Werkzeuge teilen sich
dieses Format: zwei malen den Balken (`latency-pattern.py` auf jedem Bildschirm,
`pattern-one.py` auf genau einem), zwei lesen ihn zurück (`dump-latency.py` aus
dem Rohmitschnitt, `decode-shot.py` aus einem Bildschirmfoto). Vorher stand es
vier Mal wortgleich da — eine Formatänderung hätte vier Fundstellen treffen
müssen, ohne dass ein Vergessen an einer davon auffällt (der Player läse dann
einfach nichts mehr). Deshalb hier an EINER Stelle.
"""

from __future__ import annotations

BLOCK = 32                      # Kantenlänge eines Klotzes in Bildpunkten
MARKER = [1, 0, 1, 1, 0, 0, 1, 0]   # Erkennungsmuster vor dem Zähler
COUNTER_BITS = 16               # Zähler in Millisekunden, läuft nach 65,5 s um
BLOCKS = len(MARKER) + COUNTER_BITS
BAR_W = BLOCKS * BLOCK
# Zwölf Stellen, an denen ein Balken steht (linke obere Ecke, in Bildpunkten des
# jeweiligen Bildschirms). Passt bis 2560x1440.
POSITIONS = [(x, y) for y in (64, 400, 800, 1200) for x in (64, 880, 1696)]
