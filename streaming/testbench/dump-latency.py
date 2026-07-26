#!/usr/bin/env python3
"""Wie lange braucht ein Bild von der Anzeige bis zum Encoder?

Der letzte unbeobachtete Posten der Kette. Alle anderen sind direkt gemessen
(Encoder im Sender, Ankunft-bis-Schirm im Player, Ende zu Ende über das
Zeitmuster) — dieser war bisher nur aus dem Vergleich zweier Bildraten
erschlossen.

Funktioniert, weil zwei Uhrzeiten zusammentreffen:

* **im Bild** steht die Uhrzeit, zu der es gemalt wurde (das Zeitmuster von
  `latency-pattern.py`),
* **in der `.pts`-Liste** steht die Uhrzeit, zu der genau dieses Bild beim
  Encoder ankam (zweite Spalte, vom Sender geschrieben).

Die Differenz ist Aufnahme plus Farbumrechnung. Zusammen mit den übrigen Posten
bleibt als Rest genau das, was der Zwischenserver kostet.

Voraussetzung: ein Lauf mit BEIDEM — `--quality` (schreibt den Mitschnitt) und
`--e2e` (zeigt das Zeitmuster):

    ./real-harness.py --secs 12 --fps 60 --kbps 4000 --quality --e2e --label z
    ./dump-latency.py --ref ref-z.raw
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import numpy as np

BLOCK = 32
MARKER = [1, 0, 1, 1, 0, 0, 1, 0]
COUNTER_BITS = 16
POSITIONS = [(x, y) for y in (64, 400, 800, 1200) for x in (64, 880, 1696)]


def read_bar(luma: np.ndarray, x0: int, y0: int) -> int | None:
    cy = y0 + BLOCK // 2
    bits = len(MARKER) + COUNTER_BITS
    if cy >= luma.shape[0] or x0 + bits * BLOCK > luma.shape[1]:
        return None
    out = []
    for i in range(bits):
        v = int(luma[cy, x0 + i * BLOCK + BLOCK // 2])
        if v <= 70:
            out.append(0)
        elif v >= 180:
            out.append(1)
        else:
            return None
    if out[: len(MARKER)] != MARKER:
        return None
    counter = 0
    for bit in out[len(MARKER):]:
        counter = (counter << 1) | bit
    return counter


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", required=True, type=Path)
    ap.add_argument("--epoch", type=int, default=None,
                    help="Epoche des Musters; ohne Angabe aus dem Lauf-Log geraten")
    args = ap.parse_args()

    pts_path = args.ref.with_suffix(".pts")
    lines = pts_path.read_text().splitlines()
    m = re.search(r"pix_fmt=(\S+)\s+size=(\d+)x(\d+)", lines[0])
    if not m:
        raise SystemExit(f"{pts_path}: Kopfzeile unlesbar")
    pix_fmt, w, h = m.group(1), int(m.group(2)), int(m.group(3))
    wide = pix_fmt.endswith("10le")
    # 4:2:0 heisst 1,5 Werte je Bildpunkt; bei 10 bit sind es zwei Bytes je Wert.
    frame_bytes = w * h * 3 if wide else w * h * 3 // 2

    entries = []
    for line in lines[1:]:
        parts = line.split()
        if len(parts) == 2:
            entries.append((int(parts[0]), int(parts[1])))
    if not entries:
        raise SystemExit("keine Zeilen mit Wanduhr — Sender zu alt für diese Messung")

    if args.epoch is None:
        raise SystemExit(
            "--epoch fehlt. Die Epoche steht im Player-Log der Sitzung "
            "('Latenz-Sonde aktiv (Epoche ...)')."
        )

    lat = []
    misses = 0
    hit = None
    with args.ref.open("rb") as f:
        for i, (_pts, wall_ms) in enumerate(entries):
            f.seek(i * frame_bytes)
            raw = f.read(w * h * (2 if wide else 1))
            if len(raw) < w * h * (2 if wide else 1):
                break
            if wide:
                luma = (np.frombuffer(raw, dtype="<u2").reshape(h, w) >> 8).astype(np.uint8)
            else:
                luma = np.frombuffer(raw, dtype=np.uint8).reshape(h, w)
            counter = read_bar(luma, *hit) if hit else None
            if counter is None:
                for pos in POSITIONS:
                    counter = read_bar(luma, *pos)
                    if counter is not None:
                        hit = pos
                        break
            if counter is None:
                misses += 1
                continue
            elapsed = (wall_ms - args.epoch) & 0xFFFF
            ms = (elapsed - counter) & 0xFFFF
            if ms > 2000:
                misses += 1
                continue
            lat.append(ms)

    if not lat:
        print(f"kein Muster im Mitschnitt gefunden ({misses} Bilder)", file=sys.stderr)
        return 1
    a = np.array(lat)
    print(f"Anzeige bis Encoder-Eingang: {len(a)} Bilder, Mittel {a.mean():.1f} ms, "
          f"min {a.min():.0f}, max {a.max():.0f}, {misses} ohne Muster")
    return 0


if __name__ == "__main__":
    sys.exit(main())
