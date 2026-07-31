#!/usr/bin/env python3
"""Referenzsender ueber die ECHTE Leitung — `harness.py` mit Fern-Adressen.

**Die Luecke, die es schliesst.** Es gab bisher genau zwei Aufbauten und keinen
dazwischen: `harness.py` faehrt den gleichmaessigen Referenzsender (vorkodierte
Datei, `-c copy`) gegen die lokale Schleife, `fern-harness.py` faehrt den echten
Sidecar gegen den entfernten Server. Wer eine EMPFANGSSEITIGE Eigenschaft ueber
die echte Leitung vergleichen will — Paritaet, Nachfordern, Puffergeduld —
bekommt mit dem Sidecar drei Stoergroessen gratis dazu: Bildschirminhalt,
Portal-Verhandlung und einen Encoder, der auf Last reagiert. Fuer ein A/B ist
das Gift; der Referenzsender schickt in jedem Durchgang exakt dieselben Bytes.

Nebenbei entfaellt damit der Portal-Dialog und der wache Bildschirm.

**Die Bitrate der Vorlage muss zum eigenen Uplink passen.** Staut der Uplink,
misst man ihn statt den Empfangsweg — RTMPS ueber TCP burstet dann (Messakte
`ruckeln-2026-07-28-geloest.json`, 306 von 323 Luecken kamen daher). Also eine
Vorlage in der Groessenordnung erzeugen, die auch der Sidecar sendet:

    ./live-vorlage.py --aus fern-4000.mkv --fps 60 --kbps 4000 --secs 30
    ./fern-referenz.py --quelle fern-4000.mkv --secs 30 --label fec-20-4

Der Verlust wird NICHT hier gesetzt — er gehoert auf den Server (`tc` auf dem
Ausgang), damit er den Empfangsweg trifft und nicht den Push.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import signal
import subprocess
import sys
import time

from harness import HERE, Player

# `fern-harness.py` traegt einen Bindestrich und ist deshalb nicht importierbar
# — dieselbe Nachlade-Loesung wie dort fuer `real-harness.py`, statt Adressen
# und Token-Ablage ein zweites Mal hinzuschreiben.
_spec = importlib.util.spec_from_file_location("fh", HERE / "fern-harness.py")
_fh = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_fh)
HOST, RTMPS_PORT, mint_remote = _fh.HOST, _fh.RTMPS_PORT, _fh.mint_remote


def start_push(quelle: str, path: str, token: str, log) -> subprocess.Popen:
    """Push per RTMPS an den entfernten Server, ohne Neukodierung."""
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "warning",
        "-re", "-stream_loop", "-1", "-i", quelle,
        "-c", "copy",
        "-f", "flv", "-tls_verify", "0",
        _fh.push_url(path, token, "rtmps", 120),
    ]
    return subprocess.Popen(cmd, stdout=log, stderr=log)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quelle", default=str(HERE / "fern-4000.mkv"))
    ap.add_argument("--secs", type=float, default=30.0)
    ap.add_argument("--label", default="fern-ref")
    ap.add_argument("--jitter-ms", type=int, default=None)
    ap.add_argument("--hwdec", choices=("auto", "hw", "sw"), default="auto")
    args = ap.parse_args()

    if not os.path.exists(args.quelle):
        print(f"Vorlage fehlt: {args.quelle} — mit live-vorlage.py erzeugen",
              file=sys.stderr)
        return 1

    tag = args.label
    push_log = open(HERE / f"push-{tag}.log", "w")
    player_log = open(HERE / f"player-{tag}.log", "w")

    path, pub, rd = mint_remote()
    whep = f"https://{HOST}/whep/{path}/whep?token={rd}"
    print(f"[{tag}] Pfad {path}")

    push = start_push(args.quelle, path, pub, push_log)
    # Der Server braucht laenger als die Schleife, bis der Pfad bereit ist; die
    # MediaMTX-API ist von aussen nicht erreichbar, also wird schlicht gewartet.
    # Zu frueh geoeffnet antwortet MediaMTX `no stream is available`, und die
    # Messung sieht aus, als haette der Player versagt.
    time.sleep(8)
    if push.poll() is not None:
        print("Sender ist gestorben — siehe push-Log", file=sys.stderr)
        return 1

    player = Player(player_log)
    proben: list[dict] = []
    try:
        optionen = {"auto": {}, "hw": {"hwdec": True}, "sw": {"hwdec": False}}[args.hwdec]
        if args.jitter_ms is not None:
            optionen["jitter_ms"] = args.jitter_ms
        res = player.call("open", url=whep, title=f"Fern {tag}", options=optionen)
        if not res.get("ok"):
            print(f"open fehlgeschlagen: {res}", file=sys.stderr)
            return 1
        sid = res["session"]
        ende = time.monotonic() + args.secs
        while time.monotonic() < ende:
            time.sleep(1.0)
            s = player.call("stats", session=sid)
            if s.get("ok"):
                proben.append(s)
    finally:
        player.stop()
        push.send_signal(signal.SIGINT)
        try:
            push.wait(timeout=5)
        except subprocess.TimeoutExpired:
            push.kill()
        push_log.close()
        player_log.close()

    # Die ersten zwei Sekunden sind Aufbau (ICE, erstes Vollbild) — weglassen.
    brauchbar = proben[2:]
    if not brauchbar:
        print("keine Messwerte", file=sys.stderr)
        return 1

    print(f"[{tag}] {len(brauchbar)} Proben")
    for name in ("fps", "kbps", "packets_lost", "arrival_gaps_over_5ms",
                 "arrival_gap_max_us", "frames_dropped", "buffer_ms"):
        werte = [float(s.get(name, 0) or 0) for s in brauchbar]
        if any(werte):
            print(f"  {name:24s} min {min(werte):9.1f}  mittel "
                  f"{sum(werte) / len(werte):9.1f}  max {max(werte):9.1f}")
    (HERE / f"samples-{tag}.json").write_text(json.dumps(brauchbar, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
