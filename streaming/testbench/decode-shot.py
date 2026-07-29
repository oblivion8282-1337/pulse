#!/usr/bin/env python3
"""Liest die Zeitmuster-Balken aus einem Bildschirmfoto zurück.

**Wozu.** Die Sonde für die Ende-zu-Ende-Latenz sitzt IM nativen Player
(`probe.rs`) und liest den Balken aus dem dekodierten Bild. Für den Browser gibt
es diesen Zugriff nicht. Also physisch messen: ein Foto über beide Bildschirme
enthält den LIVE-Balken (Quell-Schirm) und den VERZÖGERTEN Balken (Wiedergabe-
Schirm) im selben Augenblick. Die Differenz der beiden Zähler ist die Latenz.

**Warum das trägt.** Beide Schirme sind 2560x1440 und die Wiedergabe läuft im
Vollbild, das Muster ist also unverzerrt und die Klötze sind wieder 32 Punkte
breit. Bei anderer Skalierung wäre dieser Weg nicht gangbar.

    ./decode-shot.py foto.png --quelle-x 2560 --wiedergabe-x 0
"""

from __future__ import annotations

import argparse
import sys

from pattern_format import BLOCK, BLOCKS, COUNTER_BITS, MARKER, POSITIONS
from PIL import Image

WRAP = 1 << COUNTER_BITS


def bit_at(img: Image.Image, x: int, y: int) -> int | None:
    """Ein Klotz → 1 (hell) oder 0 (dunkel); None, wenn er weder noch ist.

    Gemittelt über die MITTE des Klotzes (halbe Kantenlänge), nicht über die
    ganze Fläche: die Ränder sind nach Skalierung und Kompression weich, die
    Mitte bleibt eindeutig.
    """
    q = BLOCK // 4
    box = img.crop((x + q, y + q, x + BLOCK - q, y + BLOCK - q)).convert("L")
    # `tobytes()` statt `getdata()`: letzteres ist seit Pillow 12 überholt und
    # fliegt in 14 raus. Nach `convert("L")` ist ein Byte genau ein Bildpunkt.
    px = box.tobytes()
    if not px:
        return None
    m = sum(px) / len(px)
    if m >= 170:
        return 1
    if m <= 85:
        return 0
    return None


def lies_balken(img: Image.Image, ox: int, oy: int) -> int | None:
    """Zähler an EINER Stelle lesen; None, wenn Erkennungsmuster nicht passt."""
    bits: list[int] = []
    for i in range(BLOCKS):
        b = bit_at(img, ox + i * BLOCK, oy)
        if b is None:
            return None
        bits.append(b)
    if bits[: len(MARKER)] != MARKER:
        return None
    wert = 0
    for b in bits[len(MARKER):]:
        wert = (wert << 1) | b
    return wert


def lies_schirm(img: Image.Image, x_off: int) -> tuple[int | None, int]:
    """Erste lesbare Stelle auf einem Schirm. Liefert (Zähler, Trefferzahl)."""
    treffer = [v for (x, y) in POSITIONS
               if (v := lies_balken(img, x_off + x, y)) is not None]
    if not treffer:
        return None, 0
    # Mehrere Stellen zeigen denselben Augenblick; die häufigste gewinnt, das
    # faengt eine halb verdeckte Stelle ab.
    haeufig = max(set(treffer), key=treffer.count)
    return haeufig, len(treffer)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("foto")
    ap.add_argument("--quelle-x", type=int, default=2560,
                    help="X-Position des Schirms, der aufgenommen wird")
    ap.add_argument("--wiedergabe-x", type=int, default=0,
                    help="X-Position des Schirms mit der Wiedergabe")
    args = ap.parse_args()

    img = Image.open(args.foto)
    live, n_live = lies_schirm(img, args.quelle_x)
    spaet, n_spaet = lies_schirm(img, args.wiedergabe_x)

    print(f"Foto {img.width}x{img.height}")
    print(f"  Quelle    (x={args.quelle_x:5d}): Zaehler {live}   ({n_live} von 12 Stellen lesbar)")
    print(f"  Wiedergabe(x={args.wiedergabe_x:5d}): Zaehler {spaet}   ({n_spaet} von 12 Stellen lesbar)")
    if live is None or spaet is None:
        print("  -> nicht auswertbar", file=sys.stderr)
        return 1
    d = (live - spaet) % WRAP
    print(f"  -> Latenz {d} ms")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
