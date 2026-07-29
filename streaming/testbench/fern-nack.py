#!/usr/bin/env python3
"""Nachforderung und Nachlieferung über die ECHTE Leitung messen.

Gegenstück zu ``nack-wirkung.py``, das dieselbe Frage auf der lokalen Schleife
beantwortet. Dort ist die Umlaufzeit nahe null — die Frage „reicht der
Jitter-Puffer, damit eine Nachlieferung noch rechtzeitig kommt?" lässt sich
dort also gar nicht stellen. Hier schon.

**Warum getrennt vom bestehenden ``fern-harness.py``.** Das fährt den echten
Sidecar, mit Portal-Dialog und wachem Bildschirm. Für den EMPFANGSWEG ist das
unnötig und macht die Messung von Dingen abhängig, die nichts zur Sache tun.
Hier pusht stattdessen ffmpeg eine vorkodierte Datei — bekannt gleichmäßig,
reproduzierbar, ohne Klick.

**Kein künstlicher Verlust.** Er müsste auf dieselbe Schnittstelle wie der
Push, und dann wäre offen, ob der Sender oder der Empfangsweg schwächelt —
dieselbe Falle, die ``netz-harness.py`` mit ``--nur-empfang`` umgeht. Gemessen
wird deshalb, was die Leitung von sich aus verliert. Bringt ein Lauf zu wenig
Verlust für eine Aussage, sagt das Werkzeug das, statt eine Zahl zu erfinden.

**Die Auswertung erkennt die Richtung an der Gegenstellen-IP**, nicht am Port:
der Testserver veröffentlicht seinen WebRTC-Port nicht unter der lokalen
Nummer, ein Portfilter ginge ins Leere.

    ./fern-nack.py --secs 30 --label fern-nack1
    PULSE_PLAYER_NACK_INTERVAL_MS=100 ./fern-nack.py --label fern-alt
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

from harness import HERE, Player

_fh_spec = importlib.util.spec_from_file_location("fh", HERE / "fern-harness.py")
_fh = importlib.util.module_from_spec(_fh_spec)
_fh_spec.loader.exec_module(_fh)

_nw_spec = importlib.util.spec_from_file_location("nw", HERE / "nack-wirkung.py")
_nw = importlib.util.module_from_spec(_nw_spec)
_nw_spec.loader.exec_module(_nw)


def iface_zu(ip: str) -> str:
    """Über welche Schnittstelle der Server erreicht wird — nicht raten.

    Auf dieser Maschine ist es WLAN, nicht das Kabel; ein fest verdrahteter
    Name (wie in `fern-split.py`) schneidet dann still nichts mit.
    """
    r = subprocess.run(["ip", "route", "get", ip], capture_output=True, text=True, check=True)
    teile = r.stdout.split()
    return teile[teile.index("dev") + 1]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--secs", type=float, default=30.0)
    ap.add_argument("--label", default="fern-nack")
    ap.add_argument("--quelle", default="/tmp/live40.mkv",
                    help="Vorlage; mit live-vorlage.py erzeugen, NICHT synth10.mkv")
    args = ap.parse_args()

    quelle = Path(args.quelle)
    if not quelle.exists():
        print(f"Vorlage fehlt: {quelle} — mit live-vorlage.py erzeugen", file=sys.stderr)
        return 1

    server_ip = socket.gethostbyname(_fh.HOST)
    iface = iface_zu(server_ip)
    print(f"[{args.label}] {_fh.HOST} = {server_ip} ueber {iface}")

    pcap = HERE / f"{args.label}.pcap"
    dump = subprocess.Popen(
        ["sudo", "tcpdump", "-i", iface, "-n", "-s", "120", "-w", str(pcap),
         f"host {server_ip} and udp"],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
    )
    time.sleep(2.0)
    if dump.poll() is not None:
        print(f"tcpdump startete nicht:\n{dump.stderr.read()}", file=sys.stderr)
        return 1

    push_log = open(HERE / f"push-{args.label}.log", "w")
    player_log = open(HERE / f"player-{args.label}.log", "w")
    proben: list[dict] = []
    try:
        path, pub, rd = _fh.mint_remote()
        ziel = _fh.push_url(path, pub, "rtmps", 120)
        print(f"[{args.label}] Pfad {path}")
        # `harness.start_push` haengt die lokale Adresse an; hier wird das Ziel
        # direkt gesetzt, deshalb der eigene Aufruf statt der Wiederverwendung.
        push = subprocess.Popen(
            ["ffmpeg", "-hide_banner", "-loglevel", "warning", "-re",
             "-stream_loop", "-1", "-i", str(quelle), "-c", "copy",
             "-f", "flv", "-tls_verify", "0", ziel],
            stdout=push_log, stderr=push_log,
        )
        if not warte_auf_strom_fern(path, push):
            return 1

        player = Player(player_log)
        whep = f"https://{_fh.HOST}/whep/{path}/whep?token={rd}"
        res = player.call("open", url=whep, title=f"Fern-NACK {args.label}", timeout=30)
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
        player.stop()
        push.send_signal(signal.SIGINT)
        try:
            push.wait(timeout=5)
        except subprocess.TimeoutExpired:
            push.kill()
    finally:
        subprocess.run(["sudo", "pkill", "-INT", "-f", f"tcpdump.*{pcap.name}"], check=False)
        try:
            dump.wait(timeout=10)
        except subprocess.TimeoutExpired:
            dump.kill()
        push_log.close()
        player_log.close()

    ergebnis = _nw.auswerten(pcap, server_ip=server_ip)
    nuetzlich = proben[2:]
    if nuetzlich:
        def mittel(feld: str) -> float:
            werte = [float(p.get(feld, 0) or 0) for p in nuetzlich]
            return sum(werte) / len(werte)
        ergebnis["player_fps"] = round(mittel("fps"), 1)
        ergebnis["player_packets_lost"] = round(mittel("packets_lost"), 1)
        ergebnis["player_proben"] = len(nuetzlich)

    print(f"\n=== {pcap.name} ({pcap.stat().st_size // 1024} KB) ===")
    for k, v in ergebnis.items():
        if k not in ("beispiele", "ssrcs"):
            print(f"  {k:34s} {v}")
    (HERE / f"{args.label}.json").write_text(json.dumps(ergebnis, indent=1))

    print()
    if ergebnis["nacks_player_zu_server"] == 0:
        print("KEIN URTEIL: die Leitung hat nichts verloren — ohne Verlust gibt es")
        print("             keine Nachforderung und nichts zu messen. Laenger fahren")
        print("             oder zu einer Zeit, in der die Strecke unruhiger ist.")
    elif not ergebnis["nack_deckt_lauf_ab"]:
        print(f"KEIN URTEIL: NACKs decken nur {ergebnis['nack_zeitraum_s']} s von")
        print(f"             {ergebnis['mitschnitt_dauer_s']} s ab.")
    elif ergebnis["verspaetung_zugeordnet"] == 0:
        print("Nachforderungen ja, aber keine Nachlieferung zuzuordnen — entweder")
        print("liefert der Server ueber diese Strecke nicht nach, oder die")
        print("Zuordnung greift nicht. Beides gehoert getrennt, bevor jemand")
        print("daraus etwas ableitet.")
    else:
        print(f"Verspaetung ueber die echte Leitung: min {ergebnis['verspaetung_ms_min']} / "
              f"median {ergebnis['verspaetung_ms_median']} / max {ergebnis['verspaetung_ms_max']} ms")
        print(f"Rechtzeitig bei 20-ms-Puffer: {ergebnis['rechtzeitig_bei_20ms_puffer']} "
              f"von {ergebnis['verspaetung_zugeordnet']}")
    return 0


def warte_auf_strom_fern(path: str, push: subprocess.Popen, timeout: float = 60.0) -> bool:
    """Wie `harness.warte_auf_strom`, nur ohne MediaMTX-API — die ist von aussen
    nicht erreichbar. Ersatzweise wird abgewartet und der Sender beobachtet."""
    ende = time.monotonic() + 8.0
    while time.monotonic() < ende:
        if push.poll() is not None:
            print("Sender ist gestorben — siehe push-Log", file=sys.stderr)
            return False
        time.sleep(0.5)
    return True


if __name__ == "__main__":
    sys.exit(main())
