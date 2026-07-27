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
import json
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

VMAF_MODEL = "/usr/share/model/vmaf_v0.6.1.json"

# Name -> zusaetzliche Encoder-Optionen. Leer = heutiger Stand des Sidecars
# (tune=ll, rc=cbr, zerolatency, delay=0, kein preset -> ffmpeg-Default p4).
VARIANTEN: list[tuple[str, list[str]]] = [
    ("heute", []),
    ("heute_wdh", []),
    ("p6aqmp", ["-preset", "p6", "-spatial-aq", "1", "-aq-strength", "8",
                "-multipass", "qres"]),
    ("bframes", ["-preset", "p6", "-spatial-aq", "1", "-aq-strength", "8",
                 "-bf", "3", "-b_ref_mode", "middle"]),
    # `-delay` erwartet eine nicht-negative Zahl; der ffmpeg-Default ist INT_MAX
    # ("Encoder entscheidet"). -1 ist ausserhalb des Bereichs.
    ("ohne_zerolat", ["-preset", "p6", "-spatial-aq", "1", "-aq-strength", "8",
                      "-zerolatency", "0", "-delay", "2147483647"]),
    ("bf_ohne_zl", ["-preset", "p6", "-spatial-aq", "1", "-aq-strength", "8",
                    "-bf", "3", "-b_ref_mode", "middle",
                    "-zerolatency", "0", "-delay", "2147483647"]),
]


def read_header(pts: Path) -> tuple[str, int, int]:
    kopf = pts.read_text().splitlines()[0]
    m = re.search(r"pix_fmt=(\S+)\s+size=(\d+)x(\d+)", kopf)
    if not m:
        raise SystemExit(f"{pts}: Kopfzeile unlesbar: {kopf}")
    return m.group(1), int(m.group(2)), int(m.group(3))


def encode(ref: Path, pix_fmt: str, w: int, h: int, fps: int, kbps: int,
           extra: list[str], out: Path, frames: int) -> float:
    """Kodiert und liefert die reine Encode-Dauer in Sekunden."""
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", pix_fmt, "-s", f"{w}x{h}", "-r", str(fps),
        "-i", str(ref), "-frames:v", str(frames),
        "-c:v", "av1_nvenc", "-tune", "ll", "-rc", "cbr",
        "-b:v", f"{kbps}k", "-maxrate", f"{kbps}k",
        "-b_ref_mode", "0", "-zerolatency", "1", "-delay", "0",
        "-g", str(fps * 2),
        *extra, str(out),
    ]
    start = time.monotonic()
    r = subprocess.run(cmd, capture_output=True, text=True)
    dauer = time.monotonic() - start
    if r.returncode != 0:
        print(r.stderr[-1500:], file=sys.stderr)
        raise SystemExit(f"Encode fehlgeschlagen: {' '.join(extra) or 'heute'}")
    return dauer


def measure(ref: Path, enc: Path, pix_fmt: str, w: int, h: int, fps: int,
            frames: int) -> dict[str, float]:
    with tempfile.TemporaryDirectory() as td:
        log = Path(td) / "vmaf.json"
        graph = (
            "[0:v]format=yuv420p10le[d];[1:v]format=yuv420p10le[r];"
            "[d][r]libvmaf=feature='name=psnr|name=float_ssim'"
            f":model=path={VMAF_MODEL}:log_path={log}:log_fmt=json"
        )
        cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-i", str(enc),
            "-f", "rawvideo", "-pix_fmt", pix_fmt, "-s", f"{w}x{h}", "-r", str(fps),
            "-i", str(ref),
            "-frames:v", str(frames), "-lavfi", graph, "-f", "null", "-",
        ]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            print(r.stderr[-1500:], file=sys.stderr)
            raise SystemExit("libvmaf fehlgeschlagen")
        pooled = json.loads(log.read_text()).get("pooled_metrics", {})
        return {k: pooled.get(k, {}).get("mean", float("nan"))
                for k in ("vmaf", "psnr_y", "float_ssim")}


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
            m = measure(args.ref, out, pix_fmt, w, h, args.fps, args.frames)
            print(f"{name:18s} {m['vmaf']:8.3f} {m['psnr_y']:8.3f} "
                  f"{m['float_ssim']:8.4f} {dauer:9.2f} {echtzeit / dauer:11.1f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
