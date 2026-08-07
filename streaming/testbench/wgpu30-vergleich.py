#!/usr/bin/env python3
"""Haelt der Zero-Copy-Weg den Sprung von wgpu 29 auf 30 aus?

**Die Frage ist NICHT, ob Zero-Copy etwas bringt** — das ist gemessen
(`profiles/player-2026-08-07-zerocopy-linux-im-player.json`). Hier geht es
darum, ob die Migration ihn beschaedigt oder verlangsamt hat. Verglichen
werden deshalb ZWEI BINAERE desselben Standes bei EINGESCHALTETEM Zero-Copy,
nicht die beiden Arme des Weges.

Aufbau: `harness.py` als Unterbau (Datei -> MediaMTX -> Player), also der
Empfangsweg allein und ohne Portal. Das ist Absicht: der Sender interessiert
hier nicht, und ein Portal-Lauf haenge an einem wachen Bildschirm, den
gleichzeitig jemand anders benutzt.

**Die Arme wechseln sich innerhalb jeder Runde ab** (erst neu, dann alt),
damit ein Drift der Maschine beide gleich trifft. Jeder Lauf ist ein eigener
Player-Prozess.

    ./wgpu30-vergleich.py --runden 6 --secs 20
"""

from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

# Die beiden Binaere werden von aussen benannt — sie liegen nicht im Baum,
# sondern sind zwei Uebersetzungen desselben Quelltextstandes.
NEU = os.environ["PULSE_VERGLEICH_NEU"]
ALT = os.environ["PULSE_VERGLEICH_ALT"]

# Die Kennzahlen, auf die es ankommt. `decode_avg_us` ist die schaerfste: sie
# faellt beim Zero-Copy-Weg von rund 4600 auf rund 1300 us, ein Rueckfall auf
# den Hauptspeicher-Weg waere daran sofort zu sehen.
FELDER = ("decode_avg_us", "glass_avg_us", "fps", "frames_never_drawn", "kbps")


def lauf(binaer: str, tag: str, secs: float, quelle: str) -> dict | None:
    """Einen Lauf fahren und seine Mittelwerte zurueckgeben."""
    umgebung = {**os.environ, "PULSE_PLAYER_BIN": binaer, "PULSE_HARNESS_SOURCE": quelle}
    erg = subprocess.run(
        [sys.executable, str(HERE / "harness.py"), "--secs", str(secs), "--label", tag],
        cwd=HERE, env=umgebung, capture_output=True, text=True,
    )
    if erg.returncode != 0:
        print(f"  {tag}: FEHLGESCHLAGEN\n{erg.stdout}\n{erg.stderr}", file=sys.stderr)
        return None

    proben = json.loads((HERE / f"samples-{tag}.json").read_text())
    if not proben:
        return None

    # **Die Kontrolle, ohne die der Lauf nichts wert waere.** Faellt der
    # Zero-Copy-Weg still auf den Hauptspeicher zurueck (so geschehen bei der
    # urspruenglichen Messreihe, `cuImportExternalMemory` mit rc=201), liefe
    # die Wiedergabe unauffaellig weiter — nur langsamer. Dann verglichen wir
    # zwei verschiedene Wege statt zweier wgpu-Fassungen.
    log = (HERE / f"player-{tag}.log").read_text()
    zerocopy = len(re.findall(r"Zero-Copy an", log))
    decoder = {p.get("decoder") for p in proben}
    hardware = {bool(p.get("hardware_decode")) for p in proben}

    werte = {f: statistics.fmean(float(p.get(f) or 0) for p in proben) for f in FELDER}
    werte |= {
        "proben": len(proben),
        "zerocopy_zeilen": zerocopy,
        "decoder": sorted(decoder),
        "hardware": sorted(hardware),
        "oberflaeche": sorted({p.get("surface_format") for p in proben}),
        "paketverlust": sum(int(p.get("packets_lost") or 0) for p in proben),
    }
    return werte


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runden", type=int, default=6)
    ap.add_argument("--secs", type=float, default=20.0)
    ap.add_argument("--quelle", default=str(HERE / "fern-4000.mkv"))
    args = ap.parse_args()

    ergebnisse: dict[str, list[dict]] = {"neu": [], "alt": []}
    for runde in range(args.runden):
        for arm, binaer in (("neu", NEU), ("alt", ALT)):
            tag = f"wgpu30-{arm}-{runde}"
            print(f"[{runde}] {arm} …", flush=True)
            w = lauf(binaer, tag, args.secs, args.quelle)
            if w:
                ergebnisse[arm].append(w)
                print(
                    f"    decode {w['decode_avg_us']:7.1f} us  glas {w['glass_avg_us']:8.1f} us  "
                    f"fps {w['fps']:5.1f}  zerocopy {w['zerocopy_zeilen']}",
                    flush=True,
                )

    print("\n== Ergebnis ==")
    for feld in FELDER:
        for arm in ("neu", "alt"):
            reihe = [e[feld] for e in ergebnisse[arm]]
            if not reihe:
                continue
            print(
                f"{feld:20s} {arm:4s} mittel {statistics.fmean(reihe):9.1f}  "
                f"min {min(reihe):9.1f}  max {max(reihe):9.1f}  n={len(reihe)}"
            )
    (HERE / "wgpu30-vergleich.json").write_text(json.dumps(ergebnisse, indent=1))
    print("\nRohwerte: wgpu30-vergleich.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
