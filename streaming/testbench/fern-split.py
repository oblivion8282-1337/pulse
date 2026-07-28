#!/usr/bin/env python3
"""Wo entsteht eine Ankunftsluecke — vor dem Server oder dahinter?

Mitschnitt auf dem ECHTEN Interface waehrend eines Fern-Laufs. Uplink ist
alles Richtung Server (RTMPS: TCP 1936, WHIP: UDP), Downlink alles vom Server
(WHEP: UDP). Fuer jede Downlink-Luecke ab der Schwelle wird gesucht, ob im
Uplink kurz davor eine vergleichbare Luecke lag:

* **mit Partner im Uplink** — die Luecke war schon im eigenen Sendeweg oder in
  der Aufnahme/dem Encoder; der Server hat sie nur durchgereicht.
* **ohne Partner** — sie ist erst auf dem Weg Server -> Zuschauer entstanden
  (Server-Egress, Leitung abwaerts, oder Uplink-Stau, den TCP versteckt).

Die Zuordnung ist mit +-150 ms bewusst grob: der Versatz Uplink->Downlink ist
etwa RTT/2 plus Serverzeit und schwankt. Sie beantwortet die GROBE Frage
(vorher/nachher), keine Millimeterfragen.

Nur Medienpakete zaehlen (>= 200 Byte) — ACKs, RTCP und STUN wuerden jede
Luecke zuschuetten.

    sudo -v && ./fern-split.py --proto rtmps --secs 30 --label split1
"""

from __future__ import annotations

import argparse
import json
import os
import struct
import subprocess
import sys
import time
import types
from pathlib import Path

import numpy as np

from gemeinsam import laden
from harness import HERE

_ruckel = laden("ruckel-fern")

SERVER = "77.42.71.166"
IFACE = os.environ.get("PULSE_FERN_IFACE", "enp39s0")
MIN_MEDIA_BYTES = 200


def read_pcap(path: Path) -> tuple[np.ndarray, np.ndarray]:
    """(uplink_ts, downlink_ts) in Sekunden — nur Medienpakete zum/vom Server."""
    raw = path.read_bytes()
    magic = struct.unpack("<I", raw[:4])[0]
    if magic == 0xA1B2C3D4:
        div = 1e6
    elif magic == 0xA1B23C4D:
        div = 1e9
    else:
        raise SystemExit(f"unbekanntes pcap-Magic {magic:08x}")
    server = bytes(int(x) for x in SERVER.split("."))
    pos = 24
    up, down = [], []
    n = len(raw)
    while pos + 16 <= n:
        sec, sub, incl, _orig = struct.unpack("<IIII", raw[pos:pos + 16])
        pos += 16
        pkt = raw[pos:pos + incl]
        pos += incl
        if len(pkt) < 34:
            continue
        ethertype = struct.unpack(">H", pkt[12:14])[0]
        if ethertype != 0x0800:  # nur IPv4 — die Fern-Wege laufen ueber v4
            continue
        ip = pkt[14:]
        ihl = (ip[0] & 0x0F) * 4
        total = struct.unpack(">H", ip[2:4])[0]
        if total < MIN_MEDIA_BYTES:
            continue
        ts = sec + sub / div
        if ip[16:20] == server:
            up.append(ts)
        elif ip[12:16] == server:
            down.append(ts)
    return np.array(up), np.array(down)


def gaps(ts: np.ndarray, schwelle_s: float) -> list[tuple[float, float]]:
    """(Zeitpunkt des Lueckenbeginns, Dauer ms) aller Abstaende ueber der Schwelle."""
    if len(ts) < 2:
        return []
    d = np.diff(ts)
    idx = np.flatnonzero(d >= schwelle_s)
    return [(float(ts[i]), float(d[i] * 1000)) for i in idx]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--proto", default="rtmps", choices=["rtmps", "whip"])
    ap.add_argument("--secs", type=float, default=30.0)
    ap.add_argument("--fps", type=int, default=60)
    ap.add_argument("--kbps", type=int, default=3000)
    ap.add_argument("--codec", default="av1")
    ap.add_argument("--bits", type=int, default=10)
    ap.add_argument("--audio", default="Desktop")
    ap.add_argument("--schwelle-ms", type=float, default=25.0)
    ap.add_argument("--label", default="split")
    args = ap.parse_args()

    # Der Lauf selbst kommt aus ruckel-fern (gleiche Mechanik, gleiches Log);
    # Muster/Ton/Aufnahme sind hier aus — es geht nur um Paket-Zeitpunkte.
    lauf_args = types.SimpleNamespace(
        secs=args.secs, fps=args.fps, kbps=args.kbps, codec=args.codec,
        bits=args.bits, audio=args.audio, record=False, label=args.label,
    )

    pcap = HERE / f"fern-{args.label}.pcap"
    dump = subprocess.Popen(
        ["sudo", "-n", "tcpdump", "-i", IFACE, "-n", "-s", "96", "-w", str(pcap),
         f"host {SERVER}"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(1.5)
    if dump.poll() is not None:
        print("tcpdump startete nicht (sudo -v vorher ausfuehren?)", file=sys.stderr)
        return 1

    try:
        ergebnis = _ruckel.lauf(lauf_args, 0, args.proto, None, None)
    finally:
        subprocess.run(["sudo", "-n", "pkill", "-INT", "-x", "tcpdump"], check=False)
        try:
            dump.wait(timeout=10)
        except subprocess.TimeoutExpired:
            dump.kill()

    up_ts, down_ts = read_pcap(pcap)
    if len(up_ts) < 100 or len(down_ts) < 100:
        print(f"zu wenige Pakete (up {len(up_ts)}, down {len(down_ts)}) — "
              f"Interface {IFACE} richtig?", file=sys.stderr)
        return 1

    schwelle = args.schwelle_ms / 1000
    up_gaps = gaps(up_ts, schwelle * 0.8)   # Partner darf etwas kleiner sein
    down_gaps = gaps(down_ts, schwelle)

    zugeordnet = 0
    einzeln = []
    up_zeiten = np.array([t for t, _ in up_gaps]) if up_gaps else np.array([])
    for t, ms in down_gaps:
        # Partner: Uplink-Luecke, die kurz VOR der Downlink-Luecke begann.
        if len(up_zeiten) and np.any((up_zeiten > t - 0.5) & (up_zeiten < t + 0.05)):
            zugeordnet += 1
        else:
            einzeln.append({"bei_s": round(t - down_ts[0], 2), "ms": round(ms, 1)})

    dauer = down_ts[-1] - down_ts[0]
    out = {
        "id": f"fern-split-{args.label}",
        "proto": args.proto,
        "pakete": {"uplink": len(up_ts), "downlink": len(down_ts)},
        "dauer_s": round(float(dauer), 1),
        "uplink_luecken": len(up_gaps),
        "downlink_luecken": len(down_gaps),
        "downlink_mit_uplink_partner": zugeordnet,
        "downlink_ohne_partner": len(einzeln),
        "ohne_partner_beispiele": einzeln[:10],
        "lauf": {k: v for k, v in ergebnis.items() if k != "gap_ereignisse"},
        "zuordnung": "Partner = Uplink-Luecke >= 20 ms, Beginn 0,5 s vor bis 50 ms "
                     "nach der Downlink-Luecke. Grob, beantwortet nur vorher/dahinter.",
    }
    (HERE / f"fern-split-{args.label}.json").write_text(
        json.dumps(out, indent=1, ensure_ascii=False))
    print(json.dumps({k: v for k, v in out.items() if k not in ("lauf",)},
                     indent=1, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
