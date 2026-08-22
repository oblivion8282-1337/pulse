#!/usr/bin/env python3
"""Encoder-Einstellungen an IDENTISCHEN Bildern vergleichen.

Warum nicht ueber den Live-Weg (`sweep-encoder.sh`): dort nimmt jeder Lauf einen
anderen Ausschnitt auf, und die Schwankung des Bildinhalts ist groesser als der
gesuchte Unterschied. Am 2026-07-27 gemessen: dieselbe Einstellung dreimal
gefahren ergab VMAF 33,7 / 35,9 / 36,3 — eine Spanne von 2,6 Punkten, waehrend
die Encoder-Einstellungen untereinander um etwa denselben Betrag auseinander
lagen. So gemessen sieht jede Variante mal gut und mal schlecht aus; der erste
Durchgang meldete fuer `p6aq` +5,9 VMAF, ueber vier Laeufe blieben +1,1.

Hier bekommt jede Variante **dieselben Bilder**: der Rohmitschnitt des
Encoder-Eingangs aus EINEM echten Lauf (`PULSE_DUMP_RAW`, also wirklich
aufgenommener Bildschirminhalt, kein synthetisches Muster) wird mit jeder
Einstellung neu kodiert und gegen sich selbst gemessen. Damit faellt die
Inhaltsschwankung vollstaendig weg und uebrig bleibt der Encoder.

Was dieser Weg NICHT zeigt: Latenz und das Verhalten unter echter Last. Der
Gewinner gehoert danach einmal durch den Live-Pruefstand.

    ./sweep-offline.py --ref ref-basis-spiel.raw --kbps 4000
"""

from __future__ import annotations

import argparse
import sys
import tempfile
import time
from pathlib import Path

from vmaf_common import encode_cmd, measure_vmaf, read_header, run_ffmpeg

# Name -> zusaetzliche Encoder-Optionen. Leer = heutiger Stand des Sidecars
# (tune=ll, rc=cbr, zerolatency, delay=0, kein preset -> ffmpeg-Default p4).
VARIANTEN: list[tuple[str, list[str]]] = [
    ("p2", ["-preset", "p2"]),
    ("bf3", ["-preset", "p2", "-bf", "3"]),
    ("bf3_bref", ["-preset", "p2", "-bf", "3", "-b_ref_mode", "middle"]),
    ("bf3_zl0", ["-preset", "p2", "-bf", "3",
                 "-zerolatency", "0", "-delay", "2147483647"]),
    ("lookahead", ["-preset", "p2", "-rc-lookahead", "30"]),
    ("ohne_zerolat", ["-preset", "p2", "-zerolatency", "0", "-delay", "2147483647"]),
    # Hier stand bis zum 2026-08-21 die Variante `intraref` (`-intra-refresh 1
    # -forced-idr 1 -g 600`) — die QUALITAETS-Seite der Abwaegung „verteilte
    # Intra-Zeilen statt IDR-Spitzen". Die Betriebsart ist aus Pulse entfernt
    # (Begruendung im Wurzel-`CLAUDE.md`), die Variante damit gegenstandslos.
    # Wer die Abwaegung „Stoss gegen Bilddetail" heute stellen will, stellt sie
    # ueber den Vollbild-ABSTAND — das misst `vollbild-abstand.py`.
    # Nur Vollbilder (`-g 1`): jedes Bild ist ein eigener Einstiegspunkt, damit
    # faellt der ganze Wiedereinstiegs-Komplex weg (Vollbild auf Anforderung,
    # PLI-Rueckkanal, `MAX_UNITS_WITHOUT_KEYFRAME`). Bezahlt wird das in Bits —
    # wie viel, ist genau die Frage, die dieser Eintrag beantwortet.
    ("allintra", ["-preset", "p2", "-g", "1"]),
]

# Dasselbe fuer VAAPI (AMD/Intel). Eigene Liste, weil KEINE der Optionen oben
# dort existiert — `preset`, `zerolatency`, `b_ref_mode`, `forced-idr` sind
# NVENC-Namen.
# Die Grundeinstellungen kommen aus `vmaf_common.encode_cmd` (rc_mode=CBR,
# async_depth=1), also aus `encode/opts.rs`.
#
# **Bis zum 2026-08-21 stand hier eine dritte Variante `intraref`** samt einem
# langen Absatz darueber, wie man das gepatchte FFmpeg aus
# `streaming/ffmpeg-patches/` in den Aufruf bekommt. Beides ist weg: die
# Betriebsart ist aus Pulse entfernt, und mit ihr die Patches — das Verzeichnis
# heisst heute `streaming/ffmpeg-bau/` und baut unveraenderten Upstream
# (n8.1.1). `av1_vaapi`/`h264_vaapi` kennen `intra_refresh` damit nicht mehr.
#
# **Die Falle von damals bleibt lesenswert, weil sie den Eigenbau ueberhaupt
# betrifft** (2026-08-18 aufgelaufen): `~/.cache/pulse/ffmpeg/prefix/bin/ffmpeg`
# traegt keinen RPATH auf sein eigenes `../lib`, der Programmlader nimmt also
# die Bibliothek der Distribution. Wer mit dem Eigenbau messen will, braucht
# deshalb BEIDES — `PATH` und `LD_LIBRARY_PATH`:
#
#     P=~/.cache/pulse/ffmpeg/prefix
#     PATH=$P/bin:$PATH LD_LIBRARY_PATH=$P/lib ./sweep-offline.py …
#
# `vollbild-abstand.py::eigenbau_ffmpeg` macht genau das von selbst. Fuer
# diesen Sweep ist es freiwillig: die Optionen hier kennt jedes FFmpeg. Wer
# aber gegen eine vorhandene Messakte vergleicht, nimmt denselben Bau wie
# damals, sonst entsteht die Zahl unter einem anderen Encoder.
VARIANTEN_VAAPI: list[tuple[str, list[str]]] = [
    ("heute", []),
    ("allintra", ["-g", "1"]),
]


def varianten_fuer(codec: str) -> list[tuple[str, list[str]]]:
    return VARIANTEN_VAAPI if codec.endswith("_vaapi") else VARIANTEN


def encode(ref: Path, pix_fmt: str, w: int, h: int, fps: int, kbps: int,
           extra: list[str], out: Path, frames: int, codec: str = "av1_nvenc") -> float:
    """Kodiert und liefert die reine Encode-Dauer in Sekunden."""
    cmd = encode_cmd(ref, pix_fmt, w, h, fps, kbps, frames, out, post=extra, codec=codec)
    start = time.monotonic()
    run_ffmpeg(cmd, f"Encode ({' '.join(extra) or 'heute'})")
    return time.monotonic() - start


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", required=True, type=Path)
    ap.add_argument("--kbps", type=int, default=4000)
    ap.add_argument("--fps", type=int, default=60)
    ap.add_argument("--frames", type=int, default=500)
    ap.add_argument("--nur", default="", help="nur diese Varianten (Komma-Liste)")
    # H.264 erbt seit 2026-07-27 dasselbe `preset=p2` wie AV1 (vendor_opts
    # verzweigt nach Hersteller, nicht nach Codec) — gemessen war es dort nie.
    ap.add_argument("--codec", default="av1_nvenc", help="av1_nvenc oder h264_nvenc")
    args = ap.parse_args()

    pix_fmt, w, h = read_header(args.ref.with_suffix(".pts"))
    print(f"Referenz {args.ref.name}: {pix_fmt} {w}x{h}, {args.frames} Bilder, "
          f"{args.kbps} kbps, {args.fps} fps")
    print(f"{'Variante':18s} {'VMAF':>8s} {'PSNR':>8s} {'SSIM':>8s} "
          f"{'Encode s':>9s} {'x Echtzeit':>11s}")

    echtzeit = args.frames / args.fps
    with tempfile.TemporaryDirectory() as td:
        gewaehlt = [v.strip() for v in args.nur.split(",") if v.strip()]
        for name, extra in varianten_fuer(args.codec):
            if gewaehlt and name not in gewaehlt:
                continue
            out = Path(td) / f"{name}.mkv"
            try:
                dauer = encode(args.ref, pix_fmt, w, h, args.fps, args.kbps, extra,
                               out, args.frames, args.codec)
            except SystemExit as e:
                print(f"{name:18s} {'vom Encoder abgelehnt':>36s}  ({e})")
                continue
            m = measure_vmaf(out, args.ref, pix_fmt, w, h, args.fps, args.frames)
            print(f"{name:18s} {m['vmaf']:8.3f} {m['psnr_y']:8.3f} "
                  f"{m['float_ssim']:8.4f} {dauer:9.2f} {echtzeit / dauer:11.1f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
