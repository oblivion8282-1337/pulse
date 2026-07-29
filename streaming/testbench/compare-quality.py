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
die Aufnahme. Gelöst über die Bildinhalte selbst — Zeitstempel taugen nicht, das
wären zwei Uhren mit unbekanntem Versatz.

Zugeordnet wird **Bild für Bild**, nicht über einen einmal gesuchten Versatz.
Ein fester Versatz setzt voraus, dass beide Seiten im Gleichschritt laufen; sie
tun es nicht (s. `match_frames`). Am 2026-07-27 kostete diese Annahme an echtem
Spielmaterial 9 dB Streuung — bei einem gesuchten Unterschied von rund 1 dB.

Die Kontrollzahl steht in der Ausgabe: laufen beide Seiten im Gleichschritt,
deckt sich die Zahl der Aufnahmebilder mit der Spanne der Referenzbilder
("100 Bilder ueber 100 Referenzbilder"). Weichen sie ab, hat eine Seite gedoppelt
oder ausgelassen.

    ./compare-quality.py --ref ref-basis.raw --rec rec-basis.mkv --frames 100
"""

from __future__ import annotations

import argparse
import json
import re
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


def decode_to_raw(rec: Path, pix_fmt: str, out: Path, frames: int) -> None:
    """Aufnahme in dasselbe Rohformat wie die Referenz umwandeln.

    ``-fps_mode passthrough`` ist hier **nicht optional**. Der Mitschnitt des
    Players ist Matroska mit der uebliche Zeitbasis 1/1000; ffmpeg leitet daraus
    ``r_frame_rate = 1000/1`` ab und fuellt beim Schreiben nach Rohvideo auf
    diese Rate auf — jedes Bild wird rund siebzehnmal wiederholt. Verglichen
    wuerde dann eine vervielfachte Aufnahme gegen die echte Referenz: die
    Zuordnung findet noch das erste Bild, laeuft danach weg, und die Zahlen
    sehen aus wie ein katastrophaler Qualitaetsverlust (PSNR 17 statt 28 dB).

    Gefunden am 2026-07-27 an echtem Spielmaterial. Mit `testsrc2` fiel es nicht
    auf, weil dort ohnehin alles schlecht aussieht — ein Grund mehr, nicht auf
    synthetischem Material zu messen. **Die frueheren Qualitaetszahlen aus
    diesem Werkzeug sind damit nicht belastbar** (s. `profiles/`).
    """
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(rec),
           "-fps_mode", "passthrough",
           "-frames:v", str(frames), "-f", "rawvideo", "-pix_fmt", pix_fmt, str(out)]
    subprocess.run(cmd, check=True)


def signatures(path: Path, count: int, pix_fmt: str, w: int, h: int) -> list[np.ndarray]:
    """Grob unterabgetastete Helligkeit je Bild — die Grundlage der Zuordnung.

    Ein 16er-Raster reicht: gesucht wird "welches Bild ist es", nicht "wie gut
    ist es". Voll aufgeloest zu vergleichen waere bei 600 Referenzbildern ein
    Vielfaches an Zeit fuer dasselbe Ergebnis.
    """
    out = []
    for i in range(count):
        try:
            out.append(luma(path, i, pix_fmt, w, h)[::16, ::16].astype(np.int16))
        except SystemExit:
            break
    return out


def match_frames(ref_sig: list[np.ndarray], rec_sig: list[np.ndarray],
                 vorlauf: int) -> tuple[list[int], float]:
    """Zu JEDEM Aufnahmebild sein Referenzbild — nicht ein fester Versatz.

    Ein fester Versatz setzt voraus, dass beide Seiten Bild fuer Bild im
    Gleichschritt laufen. Sie tun es nicht: der Rohmitschnitt schreibt bei
    660 MB/s nicht garantiert jedes Bild, und der Sender kann Bilder doppeln
    oder auslassen. Am 2026-07-27 an echtem Spielmaterial gemessen, was das
    anrichtet: das erste Bildpaar passte auf 28,9 dB, das hundertste auf 19,5 —
    eine Streuung von 9 dB, waehrend der gesuchte Unterschied zwischen zwei
    Encoder-Einstellungen bei etwa 1 dB liegt. So gemessen ist jede Aussage
    Zufall.

    Deshalb monoton weitersuchen: jedes Aufnahmebild darf im Referenzstrom
    stehenbleiben oder vorruecken, nie zurueck. Das faengt Doppler und
    Auslasser auf beiden Seiten ab.
    """
    zuordnung: list[int] = []
    abstaende: list[float] = []
    stand = 0
    for r in rec_sig:
        bis = min(len(ref_sig), stand + vorlauf + 1)
        kandidaten = range(stand, bis)
        if not kandidaten:
            break
        j = min(kandidaten, key=lambda k: float(np.abs(ref_sig[k] - r).mean()))
        zuordnung.append(j)
        abstaende.append(float(np.abs(ref_sig[j] - r).mean()))
        stand = j
    return zuordnung, float(np.mean(abstaende)) if abstaende else float("inf")


def start_offset(ref_sig: list[np.ndarray], erstes: np.ndarray) -> int:
    """Wo die Aufnahme im Referenzstrom beginnt (einmalige Grobsuche)."""
    return min(range(len(ref_sig)), key=lambda i: float(np.abs(ref_sig[i] - erstes).mean()))


def metrics(ref: Path, rec_raw: Path, pix_fmt: str, w: int, h: int,
            zuordnung: list[int]) -> None:
    count = len(zuordnung)
    fb = frame_bytes(pix_fmt, w, h)
    common = ["-f", "rawvideo", "-pix_fmt", pix_fmt, "-s", f"{w}x{h}", "-r", "60"]
    with tempfile.TemporaryDirectory() as td:
        log = Path(td) / "vmaf.json"
        # Die zugeordneten Referenzbilder in AUFNAHME-Reihenfolge herausschreiben.
        # Damit stehen sich anschliessend zwei gleich lange Stroeme Bild fuer Bild
        # gegenueber und ffmpeg muss nichts mehr ausrichten.
        trimmed = Path(td) / "ref_matched.raw"
        with ref.open("rb") as src, trimmed.open("wb") as dst:
            for j in zuordnung:
                src.seek(j * fb)
                dst.write(src.read(fb))
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
    ap.add_argument("--frames", type=int, default=60, help="wie viele Bilder vergleichen")
    ap.add_argument("--vorlauf", type=int, default=6,
                    help="wie weit die Zuordnung je Bild hoechstens vorruecken darf")
    args = ap.parse_args()

    pts = args.ref.with_suffix(".pts")
    pix_fmt, w, h, ref_frames = read_header(pts)
    print(f"Referenz: {ref_frames} Bilder, {pix_fmt}, {w}x{h}")

    with tempfile.TemporaryDirectory() as td:
        rec_raw = Path(td) / "rec.raw"
        decode_to_raw(args.rec, pix_fmt, rec_raw, args.frames + 8)
        ref_sig = signatures(args.ref, ref_frames, pix_fmt, w, h)
        rec_sig = signatures(rec_raw, args.frames, pix_fmt, w, h)
        if not ref_sig or not rec_sig:
            raise SystemExit("keine Bilder zum Zuordnen")
        beginn = start_offset(ref_sig, rec_sig[0])
        zuordnung, abstand = match_frames(ref_sig[beginn:], rec_sig, args.vorlauf)
        zuordnung = [beginn + j for j in zuordnung]
        if len(zuordnung) < 8:
            raise SystemExit("zu wenige zuordenbare Bilder")
        spanne = zuordnung[-1] - zuordnung[0]
        print(f"Zuordnung: Aufnahmebild 0 -> Referenzbild {beginn}, "
              f"{len(zuordnung)} Bilder ueber {spanne} Referenzbilder "
              f"(mittlere Abweichung {abstand:.2f})")
        # Die Kontrolle: laufen beide Seiten im Gleichschritt, deckt sich die
        # Spanne mit der Bildzahl. Weicht sie stark ab, hat eine Seite Bilder
        # gedoppelt oder ausgelassen — die Zahlen bleiben gueltig (jedes Paar ist
        # einzeln zugeordnet), aber es ist ein Hinweis auf ein Problem davor.
        if spanne < len(zuordnung) * 0.8 or spanne > len(zuordnung) * 1.25:
            print("  HINWEIS: Referenz und Aufnahme laufen nicht im Gleichschritt "
                  f"({len(zuordnung)} Aufnahmebilder auf {spanne} Referenzbilder).",
                  file=sys.stderr)
        if abstand > 12.0:
            print("  WARNUNG: die Abweichung ist hoch — die Zuordnung ist womoeglich "
                  "falsch, und dann sind alle Zahlen unten wertlos.", file=sys.stderr)
        metrics(args.ref, rec_raw, pix_fmt, w, h, zuordnung)
    return 0


if __name__ == "__main__":
    sys.exit(main())
