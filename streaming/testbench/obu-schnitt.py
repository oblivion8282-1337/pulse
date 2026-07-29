#!/usr/bin/env python3
"""Trennt einen AV1-OBU-Strom in Zugriffseinheiten und wirft gezielt welche weg.

Bildet nach, was ``depacket/mod.rs::Assembler`` bei Paketverlust tut: die
betroffene Zugriffseinheit wird KOMPLETT verworfen, nicht beschädigt
weitergereicht. Damit lässt sich die Frage „baut der Decoder nach einem Verlust
die Intra-Refresh-Streifen wieder ein?" ohne Netz, ohne MediaMTX, ohne Portal
und ohne ``sudo`` beantworten — in Sekunden statt in einer Messreihe.

Gegenstück ist ``heilung.py``, das die dekodierten Bilder auswertet. Der Befund
vom 2026-07-29 steht in ``profiles/decoder-2026-07-29-intra-refresh.json``.

**Encoder-Einstellungen sind nicht egal.** Ein Datei-Encode mit av1_nvenc-
Defaults enthält versteckte Bilder (Alt-Ref: ein ``FRAME_HDR`` allein in der
Einheit heißt „zeige ein vorhandenes Bild"), und eine solche 5-Byte-Einheit zu
verwerfen kostet gar kein Referenzbild — der Test ginge als „kein Problem"
durch. Mit den Live-Einstellungen des Sidecars verschwinden sie::

    ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=60:duration=5 \\
      -pix_fmt p010le -c:v av1_nvenc -tune ll -rc cbr -b_ref_mode 0 \\
      -preset p2 -zerolatency 1 -delay 0 -intra-refresh 1 -forced-idr 1 \\
      -g 600 -b:v 4000k -f obu live-ir.obu

Danach ist eine Zugriffseinheit genau ein Bild. Die Ausgabe unten meldet die
Einheitengröße mit; ein zweistelliger Wert ist das Warnzeichen.

    ./obu-schnitt.py live-ir.obu kaputt.obu --weg 150
    ./obu-schnitt.py live-ir.obu kaputt.obu --weg 150,151,152
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

OBU_TEMPORAL_DELIMITER = 2


def leb128(buf: bytes, pos: int) -> tuple[int, int]:
    """(Wert, neue Position). Gegenstück zu ``depacket/av1.rs``."""
    wert = 0
    for i in range(8):
        if pos >= len(buf):
            raise ValueError("LEB128 laeuft ueber das Ende hinaus")
        b = buf[pos]
        pos += 1
        wert |= (b & 0x7F) << (i * 7)
        if not b & 0x80:
            return wert, pos
    raise ValueError("LEB128 laenger als 8 Byte")


def obus(buf: bytes):
    """Liefert (typ, start, ende) je OBU im Low-Overhead-Format."""
    pos = 0
    while pos < len(buf):
        start = pos
        kopf = buf[pos]
        typ = (kopf >> 3) & 0x0F
        hat_ext = bool(kopf & 0x04)
        hat_groesse = bool(kopf & 0x02)
        pos += 1
        if hat_ext:
            pos += 1
        if not hat_groesse:
            raise ValueError(f"OBU bei {start} ohne Groessenfeld — nicht Low-Overhead")
        laenge, pos = leb128(buf, pos)
        pos += laenge
        if pos > len(buf):
            raise ValueError(f"OBU bei {start} reicht ueber das Dateiende")
        yield typ, start, pos


def einheiten(buf: bytes) -> list[tuple[int, int]]:
    """Zugriffseinheiten als (start, ende) — geschnitten am Temporal Delimiter."""
    grenzen = [start for typ, start, _ in obus(buf) if typ == OBU_TEMPORAL_DELIMITER]
    if not grenzen:
        raise ValueError("kein Temporal Delimiter gefunden")
    grenzen.append(len(buf))
    return list(zip(grenzen[:-1], grenzen[1:], strict=True))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("ein", type=Path)
    ap.add_argument("aus", type=Path)
    ap.add_argument("--weg", default="",
                    help="Indizes der zu verwerfenden Einheiten, komma-getrennt")
    args = ap.parse_args()

    buf = args.ein.read_bytes()
    liste = einheiten(buf)
    weg = {int(x) for x in args.weg.split(",") if x.strip()}
    if unbekannt := {i for i in weg if i >= len(liste)}:
        print(f"Index ausserhalb: {sorted(unbekannt)} (nur {len(liste)} Einheiten)",
              file=sys.stderr)
        return 1

    args.aus.write_bytes(b"".join(buf[a:b] for i, (a, b) in enumerate(liste) if i not in weg))
    print(f"{len(liste)} Einheiten gelesen, {len(weg)} verworfen "
          f"-> {len(liste) - len(weg)} geschrieben")
    for i in sorted(weg):
        a, b = liste[i]
        gr = b - a
        hinweis = "  <- VERDAECHTIG KLEIN, vermutlich nur 'zeige vorhandenes Bild'" if gr < 100 else ""
        print(f"  Einheit {i}: {gr} Byte verworfen{hinweis}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
