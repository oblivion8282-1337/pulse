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
    ("p1", ["-preset", "p1"]),
    ("p2", ["-preset", "p2"]),
    ("p3", ["-preset", "p3"]),
    ("heute_p4", []),
    ("p5", ["-preset", "p5"]),
    ("p6", ["-preset", "p6"]),
    ("p7", ["-preset", "p7"]),
]


def encode(ref: Path, pix_fmt: str, w: int, h: int, fps: int, kbps: int,
           extra: list[str], out: Path, frames: int) -> float:
    """Kodiert und liefert die reine Encode-Dauer in Sekunden."""
    cmd = encode_cmd(ref, pix_fmt, w, h, fps, kbps, frames, out, post=extra)
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
    args = ap.parse_args()

    pix_fmt, w, h = read_header(args.ref.with_suffix(".pts"))
    print(f"Referenz {args.ref.name}: {pix_fmt} {w}x{h}, {args.frames} Bilder, "
          f"{args.kbps} kbps, {args.fps} fps")
    print(f"{'Variante':18s} {'VMAF':>8s} {'PSNR':>8s} {'SSIM':>8s} "
          f"{'Encode s':>9s} {'x Echtzeit':>11s}")

    echtzeit = args.frames / args.fps
    with tempfile.TemporaryDirectory() as td:
        gewaehlt = [v.strip() for v in args.nur.split(",") if v.strip()]
        for name, extra in VARIANTEN:
            if gewaehlt and name not in gewaehlt:
                continue
            out = Path(td) / f"{name}.mkv"
            dauer = encode(args.ref, pix_fmt, w, h, args.fps, args.kbps, extra,
                           out, args.frames)
            m = measure_vmaf(out, args.ref, pix_fmt, w, h, args.fps, args.frames)
            print(f"{name:18s} {m['vmaf']:8.3f} {m['psnr_y']:8.3f} "
                  f"{m['float_ssim']:8.4f} {dauer:9.2f} {echtzeit / dauer:11.1f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
