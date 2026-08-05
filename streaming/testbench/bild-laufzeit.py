#!/usr/bin/env python3
"""Bildlaufzeit: nativer Player gegen Chromium — EIN Verfahren fuer beide.

Gegenstueck zu `ton-laufzeit.py`. Zusammen beantworten sie die Frage, die am
2026-08-02 aus dem Betrieb kam: im Player wirkt das Bild frueher und der Ton
spaeter als in der Electron-App — womit der Abstand zwischen Bild und Ton dort
GROESSER waere. Der Ton ist gemessen (rund 36 ms Rueckstand des Players), das
Bild fehlte.

**Warum nicht `vergleich-browser-nativ.py`.** Das misst den Player ueber seine
Sonde (aus dem dekodierten Bild) und den Browser ueber ein Bildschirmfoto —
zwei Verfahren, und der Grundunterschied der beiden Zahlen ist deshalb
teilweise Messverfahren. Das steht dort auch so. Hier lesen BEIDE denselben
Balken aus dem dekodierten Bild: der Player mit `probe.rs`, Chromium mit dem
Dekoder in `browser-whep.mjs`, der dafuer neu gebaut wurde. Die Zahlen sind
damit direkt vergleichbar.

**8 bit ist Pflicht.** Chromiums dav1d-Anbindung lehnt `bpc != 8` ab und
dekodiert dann gar nichts (am 2026-08-02 im Pruefstand: 0 Bilder, 13 PLI in
3 s). Ein 10-bit-Lauf misst hier nichts, er haengt nur.

Der Sender nimmt den Bildschirm mit dem Muster per Portal auf. Ein Bildschirm
ist fuer die Dauer der Messung also mit dem Testmuster belegt.

    ./bild-laufzeit.py --secs 60
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import signal
import statistics as st
import subprocess
import sys
import time
from pathlib import Path

from harness import CID, HERE, Player, mint_tokens

#: Der Bildschirm, den das Portal-Token aufnimmt (DP-2). Muss zu dem passen,
#: was `pattern-one.py` bemalt — sonst traegt das Bild keinen Balken und beide
#: Wege melden stumm "ohne Muster".
PATTERN_X = int(os.environ.get("PULSE_PATTERN_X", "2560"))
#: Bildschirm fuer die ZUSCHAUER-Fenster — muss ein anderer sein als der
#: aufgenommene, sonst verdecken sie das Muster und koppeln zurueck.
FENSTER_X = int(os.environ.get("PULSE_FENSTER_X", "0"))
FENSTER_OUTPUT = os.environ.get("PULSE_FENSTER_OUTPUT", "DP-1")
#: Wie in `ton-laufzeit.py`: die ersten Sekunden sind Aufbau und Einschwingen.
AUFBAU_S = int(os.environ.get("PULSE_BILD_AUFBAU_S", "20"))


def _laden(name: str):
    kurz = name.replace("-", "_")[:-3]
    spec = importlib.util.spec_from_file_location(kurz, HERE / name)
    modul = importlib.util.module_from_spec(spec)
    sys.modules[kurz] = modul
    spec.loader.exec_module(modul)
    return modul


_rh = _laden("real-harness.py")


def start_muster(epoch_ms: int, log) -> subprocess.Popen:
    umgebung = {**os.environ,
                "PULSE_LATENCY_EPOCH_MS": str(epoch_ms),
                "PULSE_PATTERN_X": str(PATTERN_X)}
    return subprocess.Popen([sys.executable, str(HERE / "pattern-one.py")],
                            stdout=log, stderr=log, env=umgebung)


def lauf_player(whep: str, sekunden: float, epoch_ms: int, log) -> list[float]:
    """Sonde des Players: `e2e_avg_us` je Sekunde, in Millisekunden."""
    p = Player(log, env_extra={"PULSE_PLAYER_LATENCY_PROBE": "1",
                               "PULSE_PLAYER_LATENCY_EPOCH_MS": str(epoch_ms)})
    werte: list[float] = []
    try:
        res = p.call("open", url=whep, title="Bildlaufzeit", options={})
        if not res.get("ok"):
            raise RuntimeError(f"player open: {res}")
        # Fenster vom aufgenommenen Bildschirm wegschieben — sonst verdeckt es
        # das Zeitmuster und der Sender nimmt seine eigene Ausgabe auf. Der
        # Player kennt keine Positionsoption, also ueber den Compositor: neue
        # Fenster sind fokussiert, `move-window-to-monitor` trifft also dieses.
        time.sleep(1.5)
        subprocess.run(["niri", "msg", "action", "move-window-to-monitor",
                        FENSTER_OUTPUT], check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        sid = res["session"]
        ende = time.monotonic() + sekunden
        seit = time.monotonic()
        while time.monotonic() < ende:
            time.sleep(1.0)
            s = p.call("stats", session=sid)
            if not s.get("ok") or "e2e_avg_us" not in s:
                continue
            if time.monotonic() - seit < AUFBAU_S:
                continue
            us = s["e2e_avg_us"]
            if us:
                werte.append(us / 1000.0)
        return werte
    finally:
        p.stop()


def lauf_browser(whep: str, sekunden: float, epoch_ms: int, logpfad: Path) -> list[float]:
    """Chromium: `musterLatenzMs` aus den Proben im Log."""
    with open(logpfad, "w") as log:
        proc = subprocess.Popen(
            ["node", str(HERE / "browser-whep.mjs"), "--url", whep,
             "--secs", str(int(sekunden)), "--sichtbar",
             "--epoch", str(epoch_ms), "--label", "bild",
             "--fenster-x", str(FENSTER_X)],
            stdout=log, stderr=log,
        )
        try:
            proc.wait(timeout=sekunden + 60)
        except subprocess.TimeoutExpired:
            proc.kill()

    # **Aus der Probendatei, nicht aus dem Log.** `browser-whep.mjs` probt zwar
    # jede Sekunde, gibt aber nur zwei Zeilen aus (die dritte und die letzte) —
    # wer das Log auswertet, bekommt aus einem 60-s-Lauf zwei Werte und haelt
    # das fuer eine Messung. Alle Proben stehen in der JSON-Datei, ihr Index
    # ist die Sekunde.
    datei = HERE / "browser-proben-bild.json"
    if not datei.exists():
        return []
    werte: list[float] = []
    for i, d in enumerate(json.loads(datei.read_text())):
        if i + 1 < AUFBAU_S:
            continue
        if d.get("musterLatenzMs"):
            werte.append(float(d["musterLatenzMs"]))
    return werte


def berichten(name: str, werte: list[float]) -> float | None:
    if not werte:
        print(f"  {name:<10} keine Messwerte (Balken nicht gelesen)")
        return None
    med = st.median(werte)
    print(f"  {name:<10} Proben {len(werte):>3}   Median {med:7.1f} ms   "
          f"Spanne {min(werte):.1f}-{max(werte):.1f}")
    return med


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--secs", type=float, default=60.0, help="Messdauer je Weg")
    ap.add_argument("--fps", type=int, default=60)
    ap.add_argument("--kbps", type=int, default=8000)
    ap.add_argument("--tauschen", action="store_true", help="erst Chromium, dann Player")
    args = ap.parse_args()

    epoch = int(time.time() * 1000)
    muster_log = open(HERE / "muster-bildlaufzeit.log", "w")
    sender_log = open(HERE / "sender-bildlaufzeit.log", "w")
    player_log = open(HERE / "player-bildlaufzeit.log", "w")
    browser_logpfad = HERE / "browser-bildlaufzeit.log"

    muster = start_muster(epoch, muster_log)
    time.sleep(2.0)
    if muster.poll() is not None:
        print("Musterfenster startete nicht — siehe muster-bildlaufzeit.log", file=sys.stderr)
        return 1

    path, pub, rd = mint_tokens()
    whep = f"http://localhost:8889/{path}/whep?token={rd}"
    # Das Token gehoert in die URL, nicht nur in `channel` — ohne es weist
    # MediaMTX den Push ab, und der Sidecar meldet das als „Broken pipe" beim
    # Muxer statt als Auth-Fehler. Genau wie in `real-harness.py`.
    push = f"rtmps://localhost:1936/{path}?token={pub}"
    sender = _rh.Sidecar(sender_log)
    try:
        res = sender.call(
            "start",
            channel={"id": CID, "token": pub, "push_url": push},
            capture="portal",
            audio={"mode": "Aus"},
            # 8 bit, sonst dekodiert Chromium nicht (s. Modul-Docstring).
            overrides={"codec": "av1", "fps": args.fps,
                       "bitrate_kbps": args.kbps, "bit_depth": 8},
        )
        if not res.get("ok"):
            print(f"Sender-Start fehlgeschlagen: {res}", file=sys.stderr)
            return 1
        time.sleep(5.0)

        if args.tauschen:
            print(f"Lauf 1: Chromium, {args.secs:.0f} s")
            b = lauf_browser(whep, args.secs, epoch, browser_logpfad)
            time.sleep(3.0)
            print(f"Lauf 2: nativer Player, {args.secs:.0f} s")
            p = lauf_player(whep, args.secs, epoch, player_log)
        else:
            print(f"Lauf 1: nativer Player, {args.secs:.0f} s")
            p = lauf_player(whep, args.secs, epoch, player_log)
            time.sleep(3.0)
            print(f"Lauf 2: Chromium, {args.secs:.0f} s")
            b = lauf_browser(whep, args.secs, epoch, browser_logpfad)
    finally:
        try:
            sender.call("stop", timeout=20)
        except Exception:
            pass
        sender.stop()
        muster.send_signal(signal.SIGINT)
        try:
            muster.wait(timeout=5)
        except subprocess.TimeoutExpired:
            muster.kill()
        for f in (muster_log, sender_log, player_log):
            f.close()

    print("\n=== Bildlaufzeit (Muster bis Anzeige, beide aus dem dekodierten Bild)")
    pm = berichten("Player", p)
    bm = berichten("Chromium", b)
    if pm is None or bm is None:
        print("\nEin Weg hat den Balken nicht gelesen — lag das Musterfenster auf dem")
        print(f"aufgenommenen Bildschirm (x={PATTERN_X}), und war es unverdeckt?")
        return 1
    print(f"\n  Chromium gegen Player: {bm - pm:+.1f} ms")
    print("  (positiv = Chromium spaeter, negativ = Player spaeter)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
