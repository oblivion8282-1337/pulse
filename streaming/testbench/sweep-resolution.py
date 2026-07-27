#!/usr/bin/env python3
"""Aufloesung gegen Bitrate: lohnt es sich, Pixel gegen Bits zu tauschen?

Hintergrund: die Bitrate ist bei 10 Mbit/s gedeckelt (VPS-Uplink, s. CLAUDE.md),
und die Messung vom 2026-07-27 hat gezeigt, dass am Encoder nichts mehr zu holen
ist. Damit bleibt genau ein Hebel: WENIGER PIXEL. 1080p bei 10 Mbit/s hat mehr
als die doppelte Bitrate je Bildpunkt wie 1440p.

Der Vergleich muss fair sein, und das ist der Kern dieses Skripts: ein
1080p-Strom landet beim Zuschauer auf derselben Flaeche und wird dort
hochgezogen. Gemessen wird deshalb **kleiner kodiert, wieder auf die
Originalgroesse hochskaliert, gegen das Original** — der Skalierungsverlust
gehoert zum Handel und darf nicht unterschlagen werden. Wer den kleinen Strom
gegen ein ebenso kleines Original misst, misst sich das Ergebnis schoen.

    ./sweep-resolution.py --ref ref-basis-spiel.raw --kbps 10000 4000
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

VMAF_MODEL = "/usr/share/model/vmaf_v0.6.1.json"

AUFLOESUNGEN = [(2560, 1440), (1920, 1080), (1600, 900), (1280, 720)]


def read_header(pts: Path) -> tuple[str, int, int]:
    kopf = pts.read_text().splitlines()[0]
    m = re.search(r"pix_fmt=(\S+)\s+size=(\d+)x(\d+)", kopf)
    if not m:
        raise SystemExit(f"{pts}: Kopfzeile unlesbar: {kopf}")
    return m.group(1), int(m.group(2)), int(m.group(3))


def run(cmd: list[str], was: str) -> None:
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stderr[-1500:], file=sys.stderr)
        raise SystemExit(f"{was} fehlgeschlagen")


def encode(ref: Path, pix_fmt: str, quelle: tuple[int, int], ziel: tuple[int, int],
           fps: int, kbps: int, frames: int, out: Path) -> None:
    """Auf die Zielgroesse skalieren und kodieren — wie es der Sender taete."""
    vf = [] if ziel == quelle else ["-vf", f"scale={ziel[0]}:{ziel[1]}:flags=lanczos"]
    run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", pix_fmt, "-s", f"{quelle[0]}x{quelle[1]}",
        "-r", str(fps), "-i", str(ref), "-frames:v", str(frames),
        *vf,
        "-c:v", "av1_nvenc", "-tune", "ll", "-rc", "cbr",
        "-b:v", f"{kbps}k", "-maxrate", f"{kbps}k",
        "-b_ref_mode", "0", "-zerolatency", "1", "-delay", "0", "-g", str(fps * 2),
        str(out),
    ], "Encode")


def measure(ref: Path, enc: Path, pix_fmt: str, quelle: tuple[int, int],
            fps: int, frames: int) -> dict[str, float]:
    """Aufnahme auf Originalgroesse hochziehen und gegen das Original messen."""
    w, h = quelle
    with tempfile.TemporaryDirectory() as td:
        log = Path(td) / "vmaf.json"
        graph = (
            f"[0:v]scale={w}:{h}:flags=lanczos,format=yuv420p10le[d];"
            "[1:v]format=yuv420p10le[r];"
            "[d][r]libvmaf=feature='name=psnr|name=float_ssim'"
            f":model=path={VMAF_MODEL}:log_path={log}:log_fmt=json"
        )
        r = subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-i", str(enc),
            "-f", "rawvideo", "-pix_fmt", pix_fmt, "-s", f"{w}x{h}", "-r", str(fps),
            "-i", str(ref),
            "-frames:v", str(frames), "-lavfi", graph, "-f", "null", "-",
        ], capture_output=True, text=True)
        if r.returncode != 0:
            print(r.stderr[-1500:], file=sys.stderr)
            raise SystemExit("libvmaf fehlgeschlagen")
        pooled = json.loads(log.read_text()).get("pooled_metrics", {})
        return {k: pooled.get(k, {}).get("mean", float("nan"))
                for k in ("vmaf", "psnr_y", "float_ssim")}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", required=True, type=Path)
    ap.add_argument("--kbps", type=int, nargs="+", default=[10000])
    ap.add_argument("--fps", type=int, default=60)
    ap.add_argument("--frames", type=int, default=400)
    args = ap.parse_args()

    pix_fmt, w, h = read_header(args.ref.with_suffix(".pts"))
    quelle = (w, h)
    print(f"Referenz {args.ref.name}: {pix_fmt} {w}x{h}, {args.frames} Bilder, "
          f"{args.fps} fps — kleiner kodiert, auf {w}x{h} hochgezogen gemessen")
    print(f"{'Aufloesung':12s} {'kbps':>6s} {'bit/Punkt':>10s} "
          f"{'VMAF':>8s} {'PSNR':>8s} {'SSIM':>8s}")

    with tempfile.TemporaryDirectory() as td:
        for kbps in args.kbps:
            for ziel in AUFLOESUNGEN:
                out = Path(td) / f"{ziel[0]}x{ziel[1]}-{kbps}.mkv"
                encode(args.ref, pix_fmt, quelle, ziel, args.fps, kbps,
                       args.frames, out)
                m = measure(args.ref, out, pix_fmt, quelle, args.fps, args.frames)
                bpp = kbps * 1000 / (ziel[0] * ziel[1] * args.fps)
                print(f"{ziel[0]}x{ziel[1]:<6d} {kbps:6d} {bpp:10.4f} "
                      f"{m['vmaf']:8.3f} {m['psnr_y']:8.3f} {m['float_ssim']:8.4f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
