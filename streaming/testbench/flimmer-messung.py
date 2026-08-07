#!/usr/bin/env python3
"""Fährt das statische HDR-Testbild in den Player und misst am BILDSCHIRM, ob
es dort steht oder flimmert.

Der Unterschied zu `harness.py`: das Fenster geht im **Vollbild** auf, damit
der Messausschnitt bekannt ist und nicht gesucht werden muss, und parallel
läuft `schirmprobe.py` über genau diesen Ausschnitt. Gemessen wird also, was
auf dem Schirm steht — nicht, was der Player über sich selbst sagt.

    ./flimmer-messung.py --label vorher --secs 45
    PULSE_PLAYER_BIN=/pfad/zu/altem/pulse-player ./flimmer-messung.py --label alte-bauart

Der Ausschnitt ist per Vorgabe die Geometrie des Ausgangs, auf dem HDR
eingeschaltet ist (aus `kscreen-doctor`); mit `--bereich` überschreibbar.

GRENZEN DER AUSSAGE stehen im Kopf von `schirmprobe.py` und gelten hier
unverändert: die Abtastrate liegt bei rund einer Aufnahme je Sekunde, die
gemessene Spanne ist deshalb eine Untergrenze.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import harness
from gemeinsam import bildschirm_wachhalten
from harness import HERE, Player, mint_tokens, start_push, warte_auf_strom


def hdr_ausgang() -> tuple[str, str]:
    """(Name, "x,y,breite,hoehe") des Ausgangs, auf dem HDR läuft."""
    roh = subprocess.run(["kscreen-doctor", "-j"], capture_output=True, text=True, check=True)
    for o in json.loads(roh.stdout)["outputs"]:
        if o.get("enabled") and o.get("hdr"):
            g = o["pos"], o["size"]
            return o["name"], f"{g[0]['x']},{g[0]['y']},{g[1]['width']},{g[1]['height']}"
    raise SystemExit("kein Ausgang mit eingeschaltetem HDR — die Messung waere sinnlos")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", default="flimmern")
    ap.add_argument("--secs", type=float, default=45.0)
    ap.add_argument("--proben", type=int, default=30)
    ap.add_argument("--bereich", default="")
    a = ap.parse_args()

    quelle = Path(os.environ.get("PULSE_HARNESS_SOURCE", HERE / "hdr-testbild.mkv"))
    if not quelle.exists():
        print(f"Vorlage fehlt: {quelle}", file=sys.stderr)
        return 1
    # **Das Modul nachtraeglich umstellen, nicht die Umgebung.** `harness.SOURCE`
    # wird beim Import gelesen; ein spaeteres `os.environ[...]` kommt zu spaet
    # und der Lauf faehrt still die Vorgabe `synth10.mkv` — am 2026-08-07 genau
    # so passiert, und die Messung sah plausibel aus (144 Bilder/s, 25 Mbit/s),
    # war aber ein anderer Strom ohne jedes PQ.
    harness.SOURCE = quelle

    # **Ohne das driftet die Helligkeit mitten im Lauf.** Der Idle-Manager
    # dieser Maschine dunkelt nach Untaetigkeit ab; ohne Maus- und
    # Tastatureingabe faellt das genau in eine Messreihe. Am 2026-08-07 sind so
    # vier Laeufe verdorben — die Flaechenhelligkeit sprang nach 9 bis 20
    # Aufnahmen um 12 bis 30 Prozent nach unten und blieb dort, in der alten wie
    # in der neuen Bauart. Der Schritt sah nach einem Befund aus und war die
    # Umgebung (`hq-labor/CLAUDE.md`, „Linux — zwei Dinge, die jede Messreihe
    # stoeren").
    bildschirm_wachhalten()

    name, bereich = hdr_ausgang()
    bereich = a.bereich or bereich
    print(f"[{a.label}] HDR-Ausgang {name}, Messausschnitt {bereich}")

    push_log = open(HERE / f"push-{a.label}.log", "w")
    player_log_pfad = HERE / f"player-{a.label}.log"
    player_log = open(player_log_pfad, "w")

    path, pub, rd = mint_tokens()
    whep = f"http://localhost:8889/{path}/whep?token={rd}"
    push = start_push(path, pub, audio=False, log=push_log)
    if not warte_auf_strom(path, push):
        return 1

    player = Player(player_log)
    try:
        res = player.call("open", url=whep, title=f"Flimmermessung {a.label}",
                          fullscreen=True, options={})
        if not res.get("ok"):
            print(f"open fehlgeschlagen: {res}", file=sys.stderr)
            return 1
        sid = res["session"]
        # Erst ankommen lassen: ICE, erstes Bild, und vor allem die
        # Formatumschaltung auf HDR. Wer vorher misst, misst den Aufbau.
        time.sleep(6.0)
        probe = subprocess.run(
            [sys.executable, str(HERE / "schirmprobe.py"),
             "--bereich", bereich, "--proben", str(a.proben), "--label", a.label],
            capture_output=True, text=True, timeout=a.secs + 120,
        )
        print(probe.stdout, end="")
        if probe.returncode:
            print(probe.stderr, file=sys.stderr)
        s = player.call("stats", session=sid)
        for k in ("fps", "frames_presented", "acquire_misses", "packets_lost",
                  "frames_dropped", "surface_format"):
            if k in s:
                print(f"[{a.label}] {k:20s} {s[k]}")
    finally:
        player.stop()
        push.send_signal(signal.SIGINT)
        try:
            push.wait(timeout=5)
        except subprocess.TimeoutExpired:
            push.kill()
        push_log.close()
        player_log.close()

    # Die Zeile, ohne die die Messung nichts über den HDR-Weg aussagt.
    for zeile in player_log_pfad.read_text(errors="replace").splitlines():
        if "Farbwelt des Stroms" in zeile or "Farbraum des Fensters" in zeile:
            print(f"[{a.label}] {zeile.strip()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
