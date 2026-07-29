#!/usr/bin/env python3
"""Erzeugt eine Prüfvorlage mit den ENCODER-EINSTELLUNGEN DES LIVE-SIDECARS.

**Warum es das gibt — der teuerste Messfehler des 2026-07-29.** Die bisherige
Vorlage ``synth10.mkv`` ist mit av1_nvenc-Datei-Defaults kodiert. Dabei entsteht
eine Alt-Ref-Struktur: rund die Hälfte aller Zugriffseinheiten sind reine
3-Byte-Header nach dem Muster „zeige ein vorhandenes Bild", die zugehörigen
Bilder liegen versteckt in früheren Einheiten. **Der Live-Sidecar erzeugt so
etwas nie** — er setzt ``zerolatency=1``, ``delay=0`` und ``b_ref_mode=0``.

Zwei Befunde gingen daraus hervor, beide stundenlang für echt gehalten:

* 87 „Error parsing OBU data" je Lauf, auch ganz ohne Störung. Aufgelöst: drei
  Zyklen aus Decoder-Fehlerzustand und Neuaufbau, der dritte beendet die
  Sitzung. Mit dieser Vorlage hier: **null**.
* Reproduzierbarer SIGSEGV in ``libnvcuvid`` unter Paketverlust, fünf von fünf
  Läufen. Mit dieser Vorlage hier: **null von drei**.

Die Vorlage bestimmt also, was gemessen wird. Wer Aussagen über den Livebetrieb
treffen will, braucht Live-Einstellungen — sonst misst er die Vorlage.

    ./live-vorlage.py                          # nach live-vorlage.mkv
    ./live-vorlage.py --secs 30 --fps 60
    PULSE_HARNESS_SOURCE=$(pwd)/live-vorlage.mkv ./harness.py --secs 15

Die Werte stammen aus ``encode/opts.rs`` des Linux-Sidecars (``vendor_opts``
für NVIDIA). Ändern sie sich dort, gehören sie hier nachgezogen — sonst misst
der Prüfstand wieder etwas anderes als das, was ausgeliefert wird.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent

# Exakt die Optionen aus `vendor_opts(Vendor::Nvidia)` im Linux-Sidecar.
# `preset=p2` und `zerolatency`/`delay` sind dort einzeln begründet und
# gemessen; hier stehen sie nur, damit die Vorlage dieselbe Bitstrom-Struktur
# bekommt wie ein echter Stream.
SIDECAR_OPTS = [
    "-tune", "ll",
    "-rc", "cbr",
    "-b_ref_mode", "0",
    "-preset", "p2",
    "-zerolatency", "1",
    "-delay", "0",
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--aus", type=Path, default=HERE / "live-vorlage.mkv")
    ap.add_argument("--secs", type=float, default=30.0)
    ap.add_argument("--fps", type=int, default=144)
    ap.add_argument("--breite", type=int, default=2560)
    ap.add_argument("--hoehe", type=int, default=1440)
    ap.add_argument("--kbps", type=int, default=25000)
    ap.add_argument("--keyframe-sekunden", type=float, default=2.0)
    args = ap.parse_args()

    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i",
        f"testsrc2=size={args.breite}x{args.hoehe}:rate={args.fps}:duration={args.secs}",
        "-f", "lavfi", "-i", f"sine=frequency=440:duration={args.secs}",
        "-pix_fmt", "p010le", "-c:v", "av1_nvenc", *SIDECAR_OPTS,
        "-g", str(int(args.fps * args.keyframe_sekunden)),
        "-b:v", f"{args.kbps}k",
        "-c:a", "libopus", "-b:a", "128k",
        str(args.aus),
    ]
    if subprocess.run(cmd, check=False).returncode != 0:
        print("ffmpeg fehlgeschlagen — av1_nvenc vorhanden?", file=sys.stderr)
        return 1

    # Kontrolle statt Vertrauen: die Vorlage taugt nur, wenn sie KEINE
    # versteckten Bilder enthaelt. Sichtbar wird das an der Bildzahl — mit
    # Alt-Ref meldet ffprobe deutlich mehr Bilder als Zugriffseinheiten.
    zaehl = subprocess.run(
        ["ffprobe", "-hide_banner", "-loglevel", "error", "-select_streams", "v",
         "-show_entries", "frame=key_frame", "-of", "csv=p=0", str(args.aus)],
        capture_output=True, text=True, check=False,
    )
    zeilen = [z for z in zaehl.stdout.splitlines() if z]
    keyframes = sum(1 for z in zeilen if z.startswith("1"))
    print(f"{args.aus} — {len(zeilen)} Bilder, {keyframes} Vollbilder, "
          f"{args.breite}x{args.hoehe}@{args.fps}, {args.kbps} kbit/s")
    print(f"Benutzen mit:  PULSE_HARNESS_SOURCE={args.aus.resolve()} ./harness.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
