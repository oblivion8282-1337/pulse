#!/usr/bin/env python3
"""Messprogramm fuer den AMD-Encoder-Zweig: Ausgangszustand, Sweep, Nachweis.

Beantwortet die drei Fragen der AMD-Uebergabe (`docs/plans/
2026-07-29-amd-linux-uebergabe.md`) mit Zahlen statt Vermutungen: welche
VAAPI-Einstellung senkt die Latenz, was kostet sie an GPU, und was passiert
dabei mit der Bildqualitaet — je fuer AV1 und H.264.

**Aufbau in drei Phasen, und die Reihenfolge ist der Punkt:**

1. `rauschen` — DIESELBE Einstellung mehrfach. Ohne diese Zahl ist kein
   Unterschied beurteilbar. Auf der NVIDIA-Maschine sah ein vermeintlicher Fix
   nach 33,5 -> 21,4 ms aus und war ueber je fuenf Laeufe 22,5 gegen 21,3.
2. `sichten` — alle Kandidaten, OHNE Qualitaetsmessung. Latenz und GPU-Kosten
   sind die billigen Achsen; damit wird die Liste kurz.
3. `bild` — nur die Anwaerter, MIT verlustfreier Referenz und VMAF. Die
   Qualitaetsmessung kostet je Lauf rund 1 GB Mitschnitt und eine Minute
   Rechenzeit, sie gehoert nicht in die Breite.

**Verschraenkt, nicht blockweise.** Alle Wiederholungen von A und dann alle von
B wuerde jede Drift (Temperatur, Fremdlast, Taktzustand) als Unterschied
zwischen A und B ausweisen. Deshalb Runde fuer Runde ueber alle Varianten.

**Bewegter Inhalt ist Voraussetzung.** Bei stehendem Schirm sind fast alle
Bilder Duplikate, die Bildqualitaet ist bedeutungslos hoch und die GPU-Last
unrealistisch niedrig. Vorher `PULSE_SCREENS=1 ./bewegtbild.py --fps 60`
starten; das Skript prueft es und bricht sonst ab.

Ergebnisse gehen fortlaufend in eine Messakte unter `profiles/` — fortlaufend,
damit ein Abbruch nach zwei Stunden nicht alles mitnimmt.

    ./amd-encoder-sweep.py --phase rauschen
    ./amd-encoder-sweep.py --phase sichten
    ./amd-encoder-sweep.py --phase bild --varianten vorgabe,ad1
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from gemeinsam import laden

# `datei-harness.py` ist als Programm benannt, nicht als Modul — `import` waere
# ein Syntaxfehler. `laden()` ist der Weg des Projekts dafuer.
lauf = laden("datei-harness").lauf

HERE = Path(__file__).resolve().parent
AKTEN = HERE / "profiles"

# Kandidaten je Codec. Der Schluessel ist der Name in der Messakte.
#
# `vorgabe` ist immer, was `opts.rs::vendor_opts` GERADE setzt — der Wert
# verschiebt sich also, sobald dort etwas geaendert wird. Fuer den
# vorher/nachher-Vergleich taugt er deshalb NICHT allein: nach der Aenderung
# vom 2026-07-30 (`async_depth` 3 -> 1) ist `vorgabe` der neue Stand.
#
# Darum gibt es `alt` als ausdrueckliche Wiederherstellung des alten Standes.
# `alt` gegen `vorgabe` ist die Abschlusstabelle, und sie bleibt gueltig, auch
# wenn spaeter jemand die Vorgabe erneut anfasst.
# Was fuer BEIDE Codecs gilt. Getrennt gefuehrt, damit eine echte Abweichung
# zwischen den Codecs unten sichtbar allein steht und nicht mit einem
# Vergessen zu verwechseln ist.
BASIS: dict[str, str] = {
    "vorgabe": "",
    "alt": "async_depth=3",
    # Der Hauptverdacht der Uebergabe-Doku, inzwischen belegt: ffmpeg gibt bei
    # VAAPI erst ein Paket heraus, wenn `async_depth` Bilder in der Schlange
    # stehen — der Vorlauf ist damit (n-1) Bildabstaende.
    "ad1": "async_depth=1",
    "ad2": "async_depth=2",
    # Blockweise Ratenkontrolle — mehr Bits dorthin, wo sie zaehlen.
    "ad1_blbrc": "async_depth=1,blbrc=1",
}

VARIANTEN: dict[str, dict[str, str]] = {
    "av1": BASIS | {
        # Die Qualitaetsstufe. `av1_vaapi` hat KEINE `quality`-Option (nur
        # h264_vaapi hat die); erreichbar ist die Treiber-Vorgabestufe allein
        # ueber das generische `compression_level`.
        "cl4": "compression_level=4",
        "ad1_cl4": "async_depth=1,compression_level=4",
        # Tiles koennen den Encoder parallelisieren; auf einer iGPU offen.
        "ad1_tiles": "async_depth=1,tiles=2x1",
    },
    "h264": BASIS | {
        # NUR h264_vaapi hat `quality` (0 = Treiber-Vorgabe, hoeher = schneller
        # laut ffmpeg-Hilfe — auf AMD ist die Richtung nachzumessen).
        "ad1_q1": "async_depth=1,quality=1",
        "ad1_q4": "async_depth=1,quality=4",
    },
}


def bewegtbild_laeuft() -> bool:
    """Spielt mpv das Messbild? Ohne Bewegung ist die Messung wertlos."""
    r = subprocess.run(["pgrep", "-u", str(os.getuid()), "-af", "mpv"],
                       capture_output=True, text=True)
    return "bewegt" in r.stdout


def akte(name: str) -> Path:
    AKTEN.mkdir(parents=True, exist_ok=True)
    return AKTEN / name


def schreibe(pfad: Path, kopf: dict, zeilen: list[dict]) -> None:
    pfad.write_text(json.dumps({**kopf, "laeufe": zeilen}, indent=2, ensure_ascii=False) + "\n")


def fahre(codec: str, namen: list[str], runden: int, secs: int, fps: int,
          qualitaet: bool, pfad: Path, kopf: dict) -> None:
    zeilen: list[dict] = []
    for runde in range(1, runden + 1):
        for name in namen:
            opts = VARIANTEN[codec][name]
            label = f"{codec}-{name}-r{runde}"
            print(f"[sweep] {label} ({opts or 'Vorgabe'}) …", flush=True)
            e = lauf(codec, opts, secs, label, fps, qualitaet)
            e["variante"] = name
            e["runde"] = runde
            if not e["live"]:
                print(f"[sweep] WARNUNG {label} wurde nicht live", flush=True)
            if e.get("unbekannte_optionen"):
                # Seit `coder` auf H.264 begrenzt ist, darf hier NICHTS mehr
                # stehen. Was doch auftaucht, hat nicht gewirkt — die Zahl
                # dieses Laufs darf nicht gedeutet werden.
                print(f"[sweep] UNGUELTIG {label}: Option(en) ohne Wirkung "
                      f"{e['unbekannte_optionen']}", flush=True)
                e["ungueltig"] = True
            zeilen.append(e)
            schreibe(pfad, kopf, zeilen)   # fortlaufend sichern


def main() -> int:
    a = argparse.ArgumentParser()
    a.add_argument("--phase", required=True, choices=["rauschen", "sichten", "bild"])
    a.add_argument("--codec", default="beide", choices=["av1", "h264", "beide"])
    a.add_argument("--runden", type=int, default=0, help="0 = Vorgabe je Phase")
    a.add_argument("--secs", type=int, default=30)
    a.add_argument("--fps", type=int, default=60)
    a.add_argument("--varianten", default="", help="Komma-Liste, leer = alle")
    a.add_argument("--datum", required=True, help="fuer den Aktennamen, z.B. 2026-07-30")
    n = a.parse_args()

    if not bewegtbild_laeuft():
        print("bewegtbild.py laeuft nicht — ohne Bewegung ist die Messung wertlos.",
              file=sys.stderr)
        return 2

    runden = n.runden or {"rauschen": 5, "sichten": 3, "bild": 3}[n.phase]
    qualitaet = n.phase == "bild"
    codecs = ["av1", "h264"] if n.codec == "beide" else [n.codec]

    for codec in codecs:
        if n.phase == "rauschen":
            namen = ["vorgabe"]
        elif n.varianten:
            namen = [v for v in n.varianten.split(",") if v in VARIANTEN[codec]]
        else:
            namen = list(VARIANTEN[codec])
        pfad = akte(f"amd-{n.phase}-{n.datum}-{codec}.json")
        kopf = {
            "was": f"AMD-VAAPI {codec}, Phase {n.phase}",
            "maschine": "AMD Radeon 780M (Phoenix, VCN 4.0), Mesa 26.1.5, FFmpeg 8.1.2",
            "aufnahme": "Portal/PipeWire 2560x1440, bewegtbild.py als Inhalt",
            "ziel": "Datei (kein RTMPS) — nur Encoder-Fragen, s. datei-harness.py",
            "fps": n.fps, "sekunden_je_lauf": n.secs, "runden": runden,
            "verschraenkt": True,
            "begonnen": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }
        print(f"[sweep] === {codec}: {namen} x {runden} Runden -> {pfad.name}", flush=True)
        fahre(codec, namen, runden, n.secs, n.fps, qualitaet, pfad, kopf)
    return 0


if __name__ == "__main__":
    sys.exit(main())
