"""Gemeinsamer Code fuer die Offline-Sweeps (sweep-offline.py, sweep-resolution.py).

Beide vergleichen einen neu kodierten av1_nvenc-Strom per libvmaf gegen dieselbe
Referenz und unterscheiden sich nur darin, WAS zwischen Kodierung und Vergleich
zusaetzlich passiert (Preset vs. Skalierung). Dieses Modul buendelt den Teil, der
identisch ist.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

VMAF_MODEL = "/usr/share/model/vmaf_v0.6.1.json"


def read_header(pts: Path) -> tuple[str, int, int]:
    kopf = pts.read_text().splitlines()[0]
    m = re.search(r"pix_fmt=(\S+)\s+size=(\d+)x(\d+)", kopf)
    if not m:
        raise SystemExit(f"{pts}: Kopfzeile unlesbar: {kopf}")
    return m.group(1), int(m.group(2)), int(m.group(3))


def run_ffmpeg(cmd: list[str], was: str) -> None:
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stderr[-1500:], file=sys.stderr)
        raise SystemExit(f"{was} fehlgeschlagen")


def encode_cmd(ref: Path, pix_fmt: str, w: int, h: int, fps: int, kbps: int,
                frames: int, out: Path, *, pre: list[str] = (),
                post: list[str] = (), codec: str = "av1_nvenc") -> list[str]:
    """Gemeinsames NVENC-Kommando. `pre` sitzt vor `-c:v` (Skalierungsfilter),
    `post` dahinter vor der Ausgabedatei (Preset/Variante) — Reihenfolge bewusst
    getrennt, weil beide Sweeps sie an unterschiedlicher Stelle brauchen."""
    return [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", pix_fmt, "-s", f"{w}x{h}", "-r", str(fps),
        "-i", str(ref), "-frames:v", str(frames),
        *pre,
        "-c:v", codec, "-tune", "ll", "-rc", "cbr",
        "-b:v", f"{kbps}k", "-maxrate", f"{kbps}k",
        "-b_ref_mode", "0", "-zerolatency", "1", "-delay", "0", "-g", str(fps * 2),
        *post,
        str(out),
    ]


def measure_vmaf(enc: Path, ref: Path, pix_fmt: str, w: int, h: int, fps: int,
                  frames: int, dist_scale: str = "") -> dict[str, float]:
    """Vergleicht enc gegen ref per libvmaf (VMAF/PSNR/SSIM, gepoolt). `dist_scale`
    (z.B. "1920:1080:flags=lanczos") skaliert die kodierte Seite vor dem Vergleich
    hoch — fuer den Aufloesungs-Sweep; leer laesst sie unveraendert."""
    with tempfile.TemporaryDirectory() as td:
        log = Path(td) / "vmaf.json"
        vor_skalierung = f"scale={dist_scale}," if dist_scale else ""
        graph = (
            f"[0:v]{vor_skalierung}format=yuv420p10le[d];[1:v]format=yuv420p10le[r];"
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
        run_ffmpeg(cmd, "libvmaf")
        pooled = json.loads(log.read_text()).get("pooled_metrics", {})
        return {k: pooled.get(k, {}).get("mean", float("nan"))
                for k in ("vmaf", "psnr_y", "float_ssim")}
