#!/usr/bin/env python3
"""Messbarer Ton fuer den Pruefstand: Dauertraeger + Zeitmarken, lautlos.

Zwei Fragen soll der Ton beantworten koennen, und dafuer traegt er zwei Dinge:

* **Uebertragungsfehler** — ein Dauertraeger (440 Hz). Jede Luecke, jedes
  Verstummen und jedes Verschlucken ist im Mitschnitt als Einbruch der
  Traeger-Energie sichtbar. Stille als Testsignal taugt nicht: sie ist von
  einem Aussetzer nicht unterscheidbar.
* **A/V-Versatz** — ein kurzer 3-kHz-Beep exakt an jeder vollen Sekunde der
  Signalzeit. Im Mitschnitt steht dann: der Beep k liegt bei Ton-Zeitstempel X,
  und die Zeitbalken im Bild sagen, welche Wanduhrzeit das Bild bei Zeitstempel
  X zeigt. Die Differenz ist der Versatz, den ein Zuschauer erlebt.

Der Weg zur Wanduhr: `pw-play` wird mit kleiner Latenzvorgabe gestartet und der
Startzeitpunkt protokolliert (`*.start.json`). Beep k ist damit auf
`start + k Sekunden` verankert — mit der Unsicherheit der Wiedergabelatenz
(Groessenordnung der Latenzvorgabe). Fuer VERAENDERUNG des Versatzes im Lauf
(Drift, Sprung nach einem Aussetzer) spielt diese Konstante keine Rolle; fuer
die absolute Zahl ist sie die Messgrenze und ist im Ergebnis auszuweisen.

Lautlos: eigener Null-Sink (`pactl module-null-sink`), `pw-play --target`
dorthin. Der Audio-Router des Sidecars linkt App-Streams unabhaengig von deren
Ziel-Sink auf seinen Capture-Sink — der Ton landet im Stream, ohne dass die
Lautsprecher etwas davon wissen.

Standalone:  ./tonsignal.py --secs 60   (spielt und raeumt danach auf)
Als Modul:   mit Tonquelle(sekunden) as q: ...  (q.start_wall_ms ist der Anker)
"""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import time
import wave
from pathlib import Path

import numpy as np

from harness import HERE

RATE = 48000
SINK = "pulse_mess_stumm"
TRAEGER_HZ = 440.0
TRAEGER_AMP = 0.1
BEEP_HZ = 3000.0
BEEP_AMP = 0.5
BEEP_MS = 40
RAMPE_MS = 5


def erzeugen(sekunden: int, ziel: Path) -> Path:
    """WAV schreiben: Traeger durchgehend, Beep an jeder vollen Sekunde.

    Deterministisch und samplegenau — Beep k beginnt exakt bei Sample
    ``k * RATE``. Die Rampen (Raised Cosine) verhindern Klicks, die im
    Spektrum wie Breitbandfehler aussaehen.
    """
    n = sekunden * RATE
    t = np.arange(n, dtype=np.float64) / RATE
    signal = TRAEGER_AMP * np.sin(2 * math.pi * TRAEGER_HZ * t)

    beep_n = RATE * BEEP_MS // 1000
    rampe_n = RATE * RAMPE_MS // 1000
    tb = np.arange(beep_n, dtype=np.float64) / RATE
    beep = BEEP_AMP * np.sin(2 * math.pi * BEEP_HZ * tb)
    huelle = np.ones(beep_n)
    huelle[:rampe_n] = 0.5 - 0.5 * np.cos(math.pi * np.arange(rampe_n) / rampe_n)
    huelle[-rampe_n:] = huelle[:rampe_n][::-1]
    beep *= huelle
    for k in range(sekunden):
        signal[k * RATE: k * RATE + beep_n] += beep

    pcm = (np.clip(signal, -1, 1) * 32767).astype("<i2")
    stereo = np.repeat(pcm[:, None], 2, axis=1)  # beide Kanaele identisch
    with wave.open(str(ziel), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(stereo.tobytes())
    return ziel


class Tonquelle:
    """Null-Sink anlegen, Signal hineinspielen, alles wieder abbauen."""

    def __init__(self, sekunden: int, label: str = "ton") -> None:
        self.sekunden = sekunden
        self.wav = HERE / f"tonsignal-{sekunden}s.wav"
        self.startdatei = HERE / f"tonsignal-{label}.start.json"
        self.modul_id: str | None = None
        self.p: subprocess.Popen | None = None
        self.start_wall_ms: int | None = None

    def __enter__(self) -> "Tonquelle":
        if not self.wav.exists():
            erzeugen(self.sekunden, self.wav)
        r = subprocess.run(
            ["pactl", "load-module", "module-null-sink", f"sink_name={SINK}",
             "rate=48000", "sink_properties=device.description=PulseMessStumm"],
            capture_output=True, text=True,
        )
        if r.returncode != 0:
            raise RuntimeError(f"Null-Sink scheiterte: {r.stderr.strip()}")
        self.modul_id = r.stdout.strip()
        # Kleine Latenzvorgabe: sie ist die Unsicherheit des Wanduhr-Ankers.
        self.start_wall_ms = int(time.time() * 1000)
        self.p = subprocess.Popen(
            ["pw-play", "--target", SINK, "--latency", "20ms", str(self.wav)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        self.startdatei.write_text(json.dumps({
            "start_wall_ms": self.start_wall_ms,
            "wav": self.wav.name,
            "latenzvorgabe_ms": 20,
            "traeger_hz": TRAEGER_HZ, "beep_hz": BEEP_HZ, "beep_ms": BEEP_MS,
        }, indent=1))
        return self

    def __exit__(self, *exc) -> None:
        if self.p is not None:
            self.p.terminate()
            try:
                self.p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.p.kill()
        if self.modul_id:
            subprocess.run(["pactl", "unload-module", self.modul_id],
                           capture_output=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--secs", type=int, default=60)
    args = ap.parse_args()
    with Tonquelle(args.secs) as q:
        print(f"[tonsignal] spielt {args.secs} s in Sink '{SINK}' "
              f"(Anker {q.start_wall_ms})", flush=True)
        try:
            q.p.wait(timeout=args.secs + 10)
        except (subprocess.TimeoutExpired, KeyboardInterrupt):
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
