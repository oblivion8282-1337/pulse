#!/usr/bin/env python3
"""Misst, ob und wann sich ein Decoder nach einem Paketverlust wieder erholt.

Gegenstück zu ``obu-schnitt.py``: das erzeugt den beschädigten Strom, das hier
wertet die dekodierten Bilder aus. Verglichen wird die Luma-Ebene Bild für Bild
gegen das ungestörte Original, mit zwei Größen:

* **PSNR gegen das Original** — 100 dB heißt byte-gleich, unter ~25 dB ist es
  sichtbar kaputt. Steigt die Kurve nach dem Verlust wieder, hat der Decoder
  einen Einstiegspunkt bekommen und das Bild erholt sich. (Bis zum 2026-08-21
  stand hier „baut die Intra-Refresh-Streifen ein" — die Betriebsart ist
  entfernt, gemessen wird jetzt die Erholung am nächsten Vollbild.)
* **Änderung zum Vorbild** — unterscheidet „eingefroren" (100 dB, also
  identisch mit dem Vorgänger) von „läuft, aber falsch".

Die zweite Größe ist der Grund, warum es dieses Werkzeug gibt. Die Bildzahl
allein lügt: am 2026-07-28 meldete der Player 60 Bilder je Sekunde und zeigte
trotzdem durchgehend dasselbe Bild — ``av1_cuvid`` wiederholt bei fehlender
Referenz still das letzte gute Bild, ohne eine einzige Fehlermeldung. Wer nur
zählt, sieht einen gesunden Decoder.

Die Zuordnung fängt den Versatz ab, den die verworfene Einheit erzeugt: ab dem
Verlustpunkt wird jedes Bild gegen mehrere Kandidaten geprüft und der beste
genommen. Ein fester Versatz wäre dieselbe Falle, die in ``compare-quality.py``
schon einmal eine falsche Aussage in die Doku getragen hat.

**Beim Dekodieren ``-fps_mode passthrough`` setzen** — ohne das dupliziert
ffmpeg Bilder und die Zuordnung ist Makulatur::

    ffmpeg -c:v av1_cuvid -i kaputt.obu -fps_mode passthrough \\
      -pix_fmt yuv420p10le -f rawvideo kaputt.yuv
    ./heilung.py orig.yuv kaputt.yuv --verlust 150

Der Befund vom 2026-07-29 stand in
``profiles/decoder-2026-07-29-intra-refresh.json``; die Akte ist am 2026-08-21
mit der Betriebsart gelöscht worden.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

# Ab hier gilt ein Bild als wieder brauchbar. Bewusst deutlich unter den
# 100 dB der Byte-Gleichheit: nach einem Keyframe ist die Erholung exakt, bei
# einer teilweisen Erholung waere sie es nicht — die Schwelle darf den zweiten
# Fall nicht wegdefinieren. (Der Fall, an dem das bis zum 2026-08-21 haengen
# blieb, war der Intra-Refresh-Zyklus; die Schwelle bleibt trotzdem grosszuegig,
# weil auch ein Vollbild-Strom zwischendurch nur naeherungsweise heilt.)
SAUBER_DB = 40.0
# Zwei Bilder gelten als identisch, wenn PSNR darueber liegt (Rundung).
STEHT_DB = 99.0


def bilder(pfad: Path, breite: int, hoehe: int):
    """Nur die Luma-Ebene je Bild (yuv420p10le)."""
    y_bytes = breite * hoehe * 2
    voll = breite * hoehe * 3  # inkl. der beiden halb aufgelösten Farbebenen
    roh = np.fromfile(pfad, dtype=np.uint8)
    for i in range(len(roh) // voll):
        start = i * voll
        yield roh[start:start + y_bytes].view(np.uint16).astype(np.float32)


def psnr(a: np.ndarray, b: np.ndarray) -> float:
    mse = float(np.mean((a - b) ** 2))
    return 100.0 if mse == 0.0 else 10.0 * np.log10((1023.0**2) / mse)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("original", type=Path)
    ap.add_argument("gestoert", type=Path)
    ap.add_argument("--breite", type=int, default=1280)
    ap.add_argument("--hoehe", type=int, default=720)
    ap.add_argument("--verlust", type=int, required=True,
                    help="Index der verworfenen Einheit")
    ap.add_argument("--suchweite", type=int, default=3,
                    help="Kandidaten fuer die Zuordnung nach dem Verlust")
    args = ap.parse_args()

    orig = list(bilder(args.original, args.breite, args.hoehe))
    gest = list(bilder(args.gestoert, args.breite, args.hoehe))
    if not orig or not gest:
        print("leere Eingabe — Bildgroesse falsch angegeben?", file=sys.stderr)
        return 1
    print(f"Original {len(orig)} Bilder, gestoert {len(gest)} Bilder, "
          f"Verlust bei {args.verlust}")

    zeilen = []
    for i, bild in enumerate(gest):
        # Vor dem Verlust ist die Zuordnung 1:1; danach kann sie sich um die
        # verworfenen Einheiten verschieben, deshalb der kleine Suchbereich.
        kandidaten = [i] if i < args.verlust else range(i, min(i + args.suchweite + 1, len(orig)))
        treffer, passt_zu = max(((psnr(bild, orig[k]), k) for k in kandidaten if k < len(orig)),
                                default=(0.0, -1))
        aenderung = psnr(bild, gest[i - 1]) if i else 100.0
        zeilen.append((i, treffer, passt_zu, aenderung))

    print(f"\n{'Bild':>5} {'PSNR':>7} {'passt zu':>9} {'Aenderung':>10}")
    for i, p, k, aend in zeilen:
        if args.verlust - 2 <= i <= args.verlust + 12 or i % 25 == 0 or i == len(zeilen) - 1:
            steht = "  <- steht" if aend >= STEHT_DB else ""
            print(f"{i:5d} {p:7.1f} {k:9d} {aend:10.1f}{steht}")

    nach = [p for i, p, _, _ in zeilen if i > args.verlust]
    if not nach:
        print(f"\nNach dem Verlust: KEIN Bild mehr ausgegeben "
              f"(Strom endet bei {len(zeilen) - 1})")
        return 0

    steht = sum(1 for i, _, _, a in zeilen if i > args.verlust and a >= STEHT_DB)
    print(f"\nNach dem Verlust: {len(nach)} Bilder, PSNR min {min(nach):.1f} "
          f"mittel {sum(nach) / len(nach):.1f} max {max(nach):.1f}")
    print(f"Davon unveraendert zum Vorbild (eingefroren): {steht}")
    geheilt = next((i for i, p, _, _ in zeilen if i > args.verlust and p >= SAUBER_DB), None)
    if geheilt is None:
        print(f"NIE wieder sauber (kein Bild ueber {SAUBER_DB:.0f} dB)")
    else:
        print(f"Wieder ueber {SAUBER_DB:.0f} dB ab Bild {geheilt} "
              f"({geheilt - args.verlust} Bilder nach dem Verlust)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
