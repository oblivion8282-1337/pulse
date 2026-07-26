#!/usr/bin/env python3
"""Bildqualität messen: was ankommt gegen das, was hineinging.

Zwei Eingaben:

* `--ref` — der verlustfreie Mitschnitt des Encoder-EINGANGS, den der Sender mit
  `PULSE_DUMP_RAW` schreibt (Rohbilder plus eine `.pts`-Liste, deren Kopfzeile
  Format und Größe nennt).
* `--rec` — die Aufnahme des Zuschauers, die der Player mit seiner
  `record`-Operation schreibt: der EMPFANGENE Bitstrom, ohne Neukodierung.

Dazwischen liegt genau das, was gemessen werden soll: der Encoder. Alles davor
(Aufnahme, Farbumrechnung) steckt in beiden Seiten gleich und fällt heraus.

Das unangenehme Teilproblem ist die **Zuordnung**. Die beiden Seiten haben
verschiedene Zeitleisten, und der Mitschnitt beginnt nicht bei demselben Bild wie
die Aufnahme. Gelöst über die Bildinhalte selbst: das erste Bild der Aufnahme
wird gegen die ersten `--search` Bilder der Referenz gehalten und die Stelle mit
der kleinsten mittleren Abweichung gewählt. Wer stattdessen die Zeitstempel
vergleicht, vergleicht zwei Uhren mit unbekanntem Versatz.

    ./compare-quality.py --ref ref-basis.raw --rec rec-basis.mkv
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

VMAF_MODEL = "/usr/share/model/vmaf_v0.6.1.json"


def read_header(pts_path: Path) -> tuple[str, int, int, int]:
    """(pix_fmt, breite, hoehe, anzahl bilder) aus der pts-Liste."""
    lines = pts_path.read_text().splitlines()
    if not lines or not lines[0].startswith("#"):
        raise SystemExit(f"{pts_path}: Kopfzeile fehlt (vom Sender geschrieben)")
    m = re.search(r"pix_fmt=(\S+)\s+size=(\d+)x(\d+)", lines[0])
    if not m:
        raise SystemExit(f"{pts_path}: Kopfzeile unlesbar: {lines[0]}")
    frames = sum(1 for line in lines[1:] if line.strip())
    return m.group(1), int(m.group(2)), int(m.group(3)), frames


def frame_bytes(pix_fmt: str, w: int, h: int) -> int:
    if pix_fmt in ("p010le", "yuv420p10le"):
        return w * h * 3  # 2 Bytes Helligkeit + 1 Byte Farbe je Bildpunkt
    if pix_fmt in ("nv12", "yuv420p"):
        return w * h * 3 // 2
    raise SystemExit(f"unbekanntes Format: {pix_fmt}")


def luma(path: Path, index: int, pix_fmt: str, w: int, h: int) -> np.ndarray:
    """Helligkeitsebene eines Bildes als 8-bit-Feld (zum Vergleichen reicht das)."""
    fb = frame_bytes(pix_fmt, w, h)
    wide = pix_fmt.endswith("10le")
    with path.open("rb") as f:
        f.seek(index * fb)
        raw = f.read(w * h * (2 if wide else 1))
    # Gegen die TATSAECHLICH angeforderte Menge pruefen, nicht gegen w*h: bei
    # 10 bit sind es zwei Bytes je Wert. Sonst rutscht ein am Dateiende
    # abgeschnittenes Bild durch und `reshape` wirft einen unverstaendlichen
    # numpy-Fehler statt der klaren Meldung hier.
    if len(raw) < w * h * (2 if wide else 1):
        raise SystemExit(f"{path}: Bild {index} fehlt oder ist unvollstaendig")
    if wide:
        # Nur das obere Byte: die zehn Bit sitzen bei P010 oben, und für die
        # Zuordnung genügt die groebere Auflösung.
        return np.frombuffer(raw, dtype="<u2").reshape(h, w) >> 8
    return np.frombuffer(raw, dtype=np.uint8).reshape(h, w)


def decode_to_raw(rec: Path, pix_fmt: str, out: Path, frames: int) -> int:
    """Aufnahme in dasselbe Rohformat wie die Referenz umwandeln."""
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(rec),
           "-frames:v", str(frames), "-f", "rawvideo", "-pix_fmt", pix_fmt, str(out)]
    subprocess.run(cmd, check=True)
    return out.stat().st_size


def find_offset(ref: Path, rec_raw: Path, pix_fmt: str, w: int, h: int, search: int) -> int:
    """Bildversatz der Referenz gegenüber der Aufnahme."""
    target = luma(rec_raw, 0, pix_fmt, w, h).astype(np.int16)
    best, best_diff = 0, None
    for i in range(search):
        try:
            cand = luma(ref, i, pix_fmt, w, h).astype(np.int16)
        except SystemExit:
            break
        diff = float(np.abs(cand - target).mean())
        if best_diff is None or diff < best_diff:
            best, best_diff = i, diff
    print(f"Zuordnung: Referenz-Bild {best} entspricht Aufnahme-Bild 0 "
          f"(mittlere Abweichung {best_diff:.2f})")
    if best_diff is not None and best_diff > 12.0:
        print("  WARNUNG: die Abweichung ist hoch — die Zuordnung ist womöglich "
              "falsch, und dann sind alle Zahlen unten wertlos.", file=sys.stderr)
    return best


def metrics(ref: Path, rec_raw: Path, pix_fmt: str, w: int, h: int,
            offset: int, count: int) -> None:
    fb = frame_bytes(pix_fmt, w, h)
    common = ["-f", "rawvideo", "-pix_fmt", pix_fmt, "-s", f"{w}x{h}", "-r", "60"]
    with tempfile.TemporaryDirectory() as td:
        log = Path(td) / "vmaf.json"
        # Die Referenz um den gefundenen Versatz beschneiden, statt in ffmpeg zu
        # rechnen: byteweises Springen ist eindeutig, `-ss` auf Rohvideo nicht.
        trimmed = Path(td) / "ref_trimmed.raw"
        with ref.open("rb") as src, trimmed.open("wb") as dst:
            src.seek(offset * fb)
            shutil.copyfileobj(src, dst)
        # PSNR und SSIM holt libvmaf selbst mit (`feature`) — zwei getrennte
        # Filter waeren zwei Durchgaenge ueber dieselben Rohdaten.
        graph = (
            "[0:v]format=yuv420p10le[d];[1:v]format=yuv420p10le[r];"
            "[d][r]libvmaf=feature='name=psnr|name=float_ssim'"
            f":model=path={VMAF_MODEL}:log_path={log}:log_fmt=json"
        )
        cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            *common, "-i", str(rec_raw),
            *common, "-i", str(trimmed),
            "-frames:v", str(count),
            "-lavfi", graph,
            "-f", "null", "-",
        ]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            print(r.stderr[-2000:], file=sys.stderr)
            raise SystemExit("libvmaf fehlgeschlagen")
        data = json.loads(log.read_text())
        pooled = data.get("pooled_metrics", {})
        print(f"Bilder verglichen: {len(data.get('frames', []))}")
        for name in ("vmaf", "psnr_y", "float_ssim"):
            m = pooled.get(name)
            if m:
                print(f"  {name:12s} Mittel {m['mean']:8.3f}  min {m['min']:8.3f}  "
                      f"max {m['max']:8.3f}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", required=True, type=Path, help="Rohmitschnitt des Senders")
    ap.add_argument("--rec", required=True, type=Path, help="Aufnahme des Players")
    ap.add_argument("--search", type=int, default=120, help="Suchbreite der Zuordnung")
    ap.add_argument("--frames", type=int, default=60, help="wie viele Bilder vergleichen")
    args = ap.parse_args()

    pts = args.ref.with_suffix(".pts")
    pix_fmt, w, h, ref_frames = read_header(pts)
    print(f"Referenz: {ref_frames} Bilder, {pix_fmt}, {w}x{h}")

    with tempfile.TemporaryDirectory() as td:
        rec_raw = Path(td) / "rec.raw"
        decode_to_raw(args.rec, pix_fmt, rec_raw, args.frames + 8)
        offset = find_offset(args.ref, rec_raw, pix_fmt, w, h, args.search)
        usable = min(args.frames, ref_frames - offset)
        if usable < 8:
            raise SystemExit("zu wenige zuordenbare Bilder")
        metrics(args.ref, rec_raw, pix_fmt, w, h, offset, usable)
    return 0


if __name__ == "__main__":
    sys.exit(main())
