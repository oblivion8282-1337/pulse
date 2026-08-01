#!/usr/bin/env python3
"""Bewegtes Messbild: dauerhafte, deterministische Bewegung auf jedem Bildschirm.

Warum es das braucht: bei stehendem Bildschirm sind die kodierten Bilder 1-2
Pakete gross — dann gibt es gar keinen Schwall auf der Leitung, und das Ruckeln
ist nicht reproduzierbar. Erst bewegter Inhalt treibt die Bilder auf die
8-12 Pakete, bei denen die Ankunftsluecken beobachtet wurden. `testsrc2` allein
taugt nicht als Ersatz: es ist ein Rauschmuster (Sonderfall fuer den Encoder),
kein fliessender Inhalt.

Das Bild hier hat beides: weiche, wandernde Verlaeufe ueber die ganze Flaeche
(jeder Block aendert sich in jedem Bild ein wenig — wie Kameraschwenk oder
Spielszene) und ein detailreiches Feld, das auf einer Lissajous-Bahn wandert
(harte Kanten in Bewegung). Deterministisch: feste Seeds, feste Bahn — zwei
Laeufe sehen denselben Inhalt.

Die Wiedergabe laeuft ueber mpv als **maximiertes rahmenloses Fenster, NICHT
Vollbild**: ein echtes Vollbild-Fenster legt KWin ueber das
"immer oben"-Zeitmuster (nachgemessen 2026-07-27, 61 Bilder ohne Muster), ein
maximiertes bleibt in der normalen Ebene und die Balken darueber lesbar.

Standalone zum Ansehen:  ./bewegtbild.py --fps 60
Als Modul:               datei(fps) erzeugt/liefert die Datei, abspielen() startet mpv.
"""

from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from harness import HERE

BREITE, HOEHE = 2560, 1440
SEKUNDEN = 30  # Schleifenlaenge; mpv loopt


def datei(fps: int, sekunden: int = SEKUNDEN) -> Path:
    """Bewegtbild-Datei fuer diese Bildrate — erzeugt sie beim ersten Mal.

    Hoch kodiert (25 Mbps AV1), damit die Datei selbst keine sichtbaren
    Artefakte beitraegt — der Encoder unter Test soll den Inhalt sehen, nicht
    die Kompressionsfehler der Vorlage. NVDEC spielt das muehelos ab.
    """
    ziel = HERE / f"bewegt-{fps}.mkv"
    if ziel.exists():
        return ziel
    print(f"[bewegtbild] erzeuge {ziel.name} ({BREITE}x{HOEHE}, {fps} fps, {sekunden} s) ...",
          flush=True)
    # Bahn des Detailfelds: Lissajous mit teilerfremden Perioden (7 s / 5 s) —
    # wiederholt sich erst nach 35 s, wandert also die ganze Schleife ueber.
    ov_x = f"(main_w-overlay_w)/2 + (main_w/3)*sin(2*PI*t/7)"
    ov_y = f"(main_h-overlay_h)/2 + (main_h/4)*sin(2*PI*t/5)"
    r = subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i",
        f"gradients=s={BREITE}x{HOEHE}:r={fps}:n=5:speed=0.04:seed=7",
        "-f", "lavfi", "-i", f"testsrc2=s=640x360:r={fps}",
        "-filter_complex", f"[0][1]overlay=x='{ov_x}':y='{ov_y}':format=auto",
        # AV1 via libsvtav1 (User-Vorgabe: kein HEVC in der Kette, auch nicht
        # als Vorlage). NICHT av1_nvenc: dessen Dateien scheiterten am
        # NVDEC-Rueckweg in mpv ("No sequence header available", mpv beendet
        # sich) — der svt-av1-Bitstrom traegt die Sequence-Header korrekt.
        "-t", str(sekunden), "-pix_fmt", "yuv420p10le",
        "-c:v", "libsvtav1", "-preset", "7", "-crf", "18",
        "-g", str(fps * 2),
        "-color_primaries", "bt709", "-color_trc", "bt709",
        "-colorspace", "bt709", "-color_range", "tv",
        str(ziel),
    ], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg scheiterte: {r.stderr.strip()[-500:]}")
    return ziel


def abspielen(pfad: Path, log) -> list[subprocess.Popen]:
    """mpv auf jedem Bildschirm, maximiert + rahmenlos (siehe Modul-Docstring)."""
    schirme = int(os.environ.get("PULSE_SCREENS", "3"))
    laeufe = []
    for i in range(schirme):
        # `--hwdec=auto` (loest auf Vulkan-Decode auf) mit dem Standard-VO.
        # NICHT `--vo=dmabuf-wayland`: das erzwingt einen hwdec-Typ, den
        # NVIDIA nicht liefert — mpv bricht mit "Error while decoding frame
        # (hardware decoding)" ab und ZEIGT NICHTS, ohne dass es von aussen
        # auffaellt (Fenster erscheint kurz, Prozess endet). Genau so lief
        # eine Messreihe versehentlich ohne Bewegtbild.
        laeufe.append(subprocess.Popen(
            ["mpv", "--no-audio", "--loop-file=inf",
             "--window-maximized=yes", "--no-border", f"--screen={i}",
             "--hwdec=auto",
             "--no-osc", "--no-input-default-bindings",
             "--profile=low-latency", str(pfad)],
            stdout=log, stderr=log,
        ))
    return laeufe


def auch_bei_sigterm_aufraeumen() -> None:
    """SIGTERM in ein `SystemExit` verwandeln, damit `finally` noch laeuft.

    **Ohne das ueberleben die mpv-Prozesse jedes `kill`.** Python beendet sich
    bei SIGTERM sofort und ohne `finally`; die drei mpv (einer je Bildschirm)
    laufen mit `--loop-file=inf` und `--hwdec=auto` weiter und dekodieren
    endlos auf der GPU. Strg-C raeumt auf, `pkill` nicht — und genau `pkill`
    steht in jedem Skript, das das Bewegtbild nebenher startet.

    Am 2026-08-01 hat das mehrere Messungen entwertet, ohne sich als Fehler zu
    zeigen: sechs vergessene mpv hielten `gpu_busy_percent` auf 99, die
    Hardware-Dekodierung fiel von 159 auf 30 Bilder je Sekunde, und der
    Messlauf sah aus, als koenne die Karte kein H.264. Erst der Vergleich
    derselben Datei mit und ohne die Leichen brachte es heraus.
    """
    def _weiter(_sig: int, _rahmen: object) -> None:
        raise SystemExit(0)

    for sig in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, _weiter)


def beenden(laeufe: list[subprocess.Popen]) -> None:
    for p in laeufe:
        p.terminate()
    for p in laeufe:
        try:
            p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            p.kill()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fps", type=int, default=60)
    ap.add_argument("--secs", type=float, default=0,
                    help="0 = laufen lassen bis Strg-C")
    args = ap.parse_args()
    pfad = datei(args.fps)
    log = open(HERE / "bewegtbild-mpv.log", "w")
    auch_bei_sigterm_aufraeumen()
    laeufe = abspielen(pfad, log)
    print(f"[bewegtbild] laeuft auf allen Bildschirmen ({pfad.name})", flush=True)
    try:
        if args.secs > 0:
            time.sleep(args.secs)
        else:
            while True:
                time.sleep(3600)
    except KeyboardInterrupt:
        pass
    finally:
        beenden(laeufe)
    return 0


if __name__ == "__main__":
    sys.exit(main())
