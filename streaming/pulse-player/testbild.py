#!/usr/bin/env python3
"""Erzeugt ein Testbild, das 8 bit von 10 bit unterscheidbar macht.

Warum das noetig ist: ob eine Kette wirklich mehr als 8 bit traegt, laesst
sich an normalem Bildmaterial NICHT ablesen — Kamerabilder und Desktops
enthalten genug Rauschen und Kanten, um Quantisierungsstufen zu verdecken.
Sichtbar wird der Unterschied nur an einem sehr flachen Verlauf.

Aufbau (von oben nach unten):
  1. Verlauf, auf 8 bit gerastert  -> sichtbare Streifen, IMMER
  2. Verlauf in voller 10-bit-Aufloesung -> glatt, NUR auf einer 10-bit-Kette
  3. dieselben zwei Streifen noch einmal, direkt aneinandergrenzend, damit
     man die Kante zwischen ihnen vergleichen kann

Die Rechnung dahinter: der Verlauf laeuft ueber `SPAN` Codewerte (10-bit-Skala)
auf voller Breite. In 8 bit gibt es darin nur SPAN/4 Stufen, jede also rund
4x breiter — bei 2560 Pixeln und SPAN=128 sind das 32 Stufen zu 80 Pixeln
gegenueber 128 Stufen zu 20 Pixeln. Der Bereich liegt bewusst im unteren
Drittel der Helligkeit, wo das Auge Stufen am ehesten sieht.

Ausgabe ist YUV420P10LE, weil das der Pixelspeicher ist, den ein 10-bit-Encoder
direkt annimmt — so entsteht die Quantisierung ausschliesslich dort, wo sie
gewollt ist, und nicht beim Umrechnen.
"""

import subprocess
import sys
from pathlib import Path

import numpy as np

WIDTH, HEIGHT = 2560, 1440
SECONDS = 60
FPS = 30

# Startwert und Umfang des Verlaufs in 10-bit-Codewerten (Studio-Bereich
# beginnt bei 64). Flach genug, dass 8-bit-Stufen breit und sichtbar werden.
BASE = 96
SPAN = 128


def gradient_row(width: int, eight_bit: bool) -> np.ndarray:
    """Ein Verlauf ueber die volle Breite, wahlweise auf 8 bit gerastert."""
    ramp = BASE + (np.arange(width, dtype=np.float64) / max(width - 1, 1)) * SPAN
    if eight_bit:
        # Auf das 8-bit-Raster zwingen: in 10-bit-Codewerten ist eine
        # 8-bit-Stufe genau 4 Einheiten breit.
        ramp = np.floor(ramp / 4.0) * 4.0
    return ramp.astype(np.uint16)


def build_luma() -> np.ndarray:
    """Y-Ebene: vier waagerechte Baender, abwechselnd 8 und 10 bit."""
    luma = np.zeros((HEIGHT, WIDTH), dtype=np.uint16)
    bands = [True, False, True, False]  # True = auf 8 bit gerastert
    band_h = HEIGHT // len(bands)
    for i, eight in enumerate(bands):
        top = i * band_h
        bottom = HEIGHT if i == len(bands) - 1 else top + band_h
        luma[top:bottom, :] = gradient_row(WIDTH, eight)

    # Duenne Trennlinien, damit die Baender auch dann abgrenzbar sind, wenn
    # der Verlauf selbst glatt ist.
    for i in range(1, len(bands)):
        y = i * band_h
        luma[y - 1 : y + 1, :] = 940  # Studio-Weiss
    return luma


def main() -> int:
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd()
    out_dir.mkdir(parents=True, exist_ok=True)

    luma = build_luma()
    # Neutrales Chroma: 512 ist die Mitte der 10-bit-Skala, also farblos.
    chroma = np.full((HEIGHT // 2, WIDTH // 2), 512, dtype=np.uint16)
    frame = luma.tobytes() + chroma.tobytes() + chroma.tobytes()

    raw = out_dir / "testbild-10bit.yuv"
    with raw.open("wb") as fh:
        fh.write(frame)
    print(f"Rohbild: {raw} ({raw.stat().st_size / 1024:.0f} KiB)")

    common = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "yuv420p10le",
        "-s", f"{WIDTH}x{HEIGHT}", "-r", str(FPS),
        "-stream_loop", str(SECONDS * FPS - 1), "-i", str(raw),
    ]
    # Beschriftung nur, wenn eine Schrift gefunden wird — sie ist Beiwerk.
    font = "/usr/share/fonts/TTF/DejaVuSans.ttf"
    labels = ""
    if Path(font).exists():
        parts = []
        for i, text in enumerate(["8 bit", "10 bit", "8 bit", "10 bit"]):
            y = i * (HEIGHT // 4) + 40
            parts.append(
                f"drawtext=fontfile={font}:text='{text}':x=40:y={y}"
                f":fontsize=48:fontcolor=white@0.85:box=1:boxcolor=black@0.5:boxborderw=12"
            )
        labels = ",".join(parts)

    # Verlustfrei, und das ist keine Uebervorsicht: bei CRF 18 hat SVT-AV1
    # gemessen 79 statt der erzeugten 33 Helligkeitsstufen in das oberste Band
    # gerechnet. Ein Testbild, dessen Stufenzahl der Encoder veraendert, misst
    # den Encoder statt die Anzeigekette. Statisches Bild -> die Dateien
    # bleiben trotzdem klein.
    targets = [
        # AV1 10 bit: derselbe Codec wie der HQ-Stream.
        ("testbild-10bit-av1.mp4", ["-c:v", "libsvtav1", "-preset", "6", "-crf", "0",
                                    "-svtav1-params", "lossless=1",
                                    "-pix_fmt", "yuv420p10le"]),
        # HEVC 10 bit: breiteste Unterstuetzung in lokalen Playern (mpv).
        ("testbild-10bit-hevc.mp4", ["-c:v", "libx265", "-x265-params", "lossless=1",
                                     "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1"]),
    ]
    for name, codec_args in targets:
        cmd = list(common)
        if labels:
            cmd += ["-vf", labels]
        cmd += codec_args + ["-t", str(SECONDS), str(out_dir / name)]
        subprocess.run(cmd, check=True)
        print(f"Video:   {out_dir / name}")

    # Standbild in voller Praezision — fuer Vergleiche ausserhalb von Playern.
    png = out_dir / "testbild-10bit.png"
    subprocess.run(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
         "-f", "rawvideo", "-pix_fmt", "yuv420p10le",
         "-s", f"{WIDTH}x{HEIGHT}", "-i", str(raw),
         "-frames:v", "1", "-pix_fmt", "rgb48be", str(png)],
        check=True,
    )
    print(f"Standbild: {png}")
    raw.unlink()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
