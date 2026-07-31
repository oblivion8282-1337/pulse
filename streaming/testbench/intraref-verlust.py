#!/usr/bin/env python3
"""Warum steht bei Intra-Refresh gelegentlich sekundenlang das Bild?

Der Befund vom 2026-07-31 (`profiles/hq-2026-07-31-intra-refresh-echter-sender.json`):
Intra-Refresh raeumt das Pumpen der periodischen Keyframes weg — Haenger ueber
100 ms fallen von 48,7 auf 1,4 Prozent der Sekunden. Was bleibt, sind SELTENE,
dafuer LANGE Standbilder: acht Stueck in 1248 Sekunden, das laengste 2466 ms,
jedes begleitet von einer Vollbild-Anforderung des Players.

**Die offene Frage ist nicht OB Verlust auftritt, sondern warum er nicht
repariert wird.** Die Kette hat dafuer zwei Mittel: FlexFEC (Paritaet, 10+2)
und NACK (Nachforderung). Greift keines, bleibt nur das ganze Vollbild — und
das dauert sichtbar. Drei Moeglichkeiten, die dieser Lauf trennt:

1. **Die Nachlieferung kommt zu spaet.** Der Nachforderer sammelt Luecken und
   schickt sie im 100-ms-Takt (`interceptor-0.17.2`); der Jitter-Puffer haelt
   100 ms auf (`pulse-player/src/proto.rs::JITTER_MS_VORGABE`). Das ist auf
   Kante genaeht — was danach eintrifft, ist messbar da und trotzdem nutzlos.
   Zu sehen an `verspaetung_ms_*` gegen `rechtzeitig_bei_100ms_puffer`.
2. **Es wird gar nicht nachgefordert.** Dann stehen NACKs bei null, obwohl
   Pakete fehlen — ein Fehler im Rueckkanal, nicht im Timing.
3. **Der Verlust ist zu gross fuer beide Mittel.** XOR-Paritaet schliesst je
   Gruppe genau EIN Loch; ein Buendel von drei Paketen ueberfordert 10+2
   strukturell, und wenn die Wiederholung auch verloren geht, bleibt nur PLI.

**Warum der ECHTE Sender und nicht ffmpeg** (wie in `fern-nack.py`): der
Intra-Refresh-Betrieb ist genau das, was hier zur Debatte steht, und den kann
nur unser Encoder. Der Preis ist das Portal — der Lauf braucht einen wachen
Bildschirm und beim ersten Mal einen Klick.

    ./intraref-verlust.py --secs 600
    ./intraref-verlust.py --secs 600 --keyframes   # Gegenprobe ohne Intra-Refresh

Beim Auswerten zaehlt die **Lebendkontrolle** (`nack_deckt_lauf_ab`): decken
die NACKs nicht den groessten Teil des Laufs ab, ist der Mitschnitt nach einem
Player-Abbruch weitergelaufen und die Zahlen sind wertlos.
"""

from __future__ import annotations

import argparse
import json
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

from gemeinsam import laden, sender_starten
from harness import HERE, Player

_fern = laden("fern-harness")
_nw = laden("nack-wirkung")
Sidecar = laden("real-harness").Sidecar


def iface_zu(ip: str) -> str:
    """Schnittstelle, ueber die dieser Server erreicht wird.

    Nicht fest verdrahten: auf dieser Maschine ist es WLAN, nicht das Kabel,
    und ein falscher Name schneidet still nichts mit.
    """
    r = subprocess.run(["ip", "route", "get", ip], capture_output=True, text=True, check=True)
    teile = r.stdout.split()
    return teile[teile.index("dev") + 1]


def ereignisse_lesen(pfad: Path, start: float, ziel: list[dict], stopp: threading.Event) -> None:
    """Vollbild-Meldungen des Players mitschreiben, mit eigener Zeitrechnung.

    Gelesen wird die LOGDATEI (stderr), nicht stdout: ueber stdout laeuft das
    JSON-RPC, und ein zweiter Leser dort wuerde der `stats`-Abfrage die
    Antworten wegschnappen. Die Zeitangabe des Players selbst ist ein Abstand
    zum vorigen Vollbild, kein Zeitpunkt — der Zeitpunkt entsteht erst hier.
    """
    with open(pfad) as f:
        while not stopp.is_set():
            zeile = f.readline()
            if not zeile:
                time.sleep(0.2)
                continue
            if "Vollbild" in zeile or "Einstiegspunkt" in zeile:
                ziel.append({"sekunde": round(time.monotonic() - start, 1),
                             "meldung": zeile.strip(), "_neu": True})


def paritaet_auswerten(proben: list[dict]) -> dict:
    """Was die FlexFEC-Paritaet ausgerichtet hat, aus der letzten `stats`-Probe.

    **Warum aus der Probe und nicht aus dem Log.** Der Player meldet auf stderr
    nur jede zehnte Reparatur; die genauen Staende stehen seit dem 2026-07-31
    in der Statistik (`fec_repariert`/`fec_unreparierbar`/`fec_zu_spaet`). Der
    erste Lauf dieses Werkzeugs sammelte die Proben zwar ein, schrieb aber nur
    ihre ANZAHL in die Akte — die Zahlen, um derentwillen der Player umgebaut
    worden war, landeten nirgends.

    Die Zaehler sind kumulativ, der letzte Stand ist also der Endstand.
    Fehlende Felder bedeuten einen aelteren Player, nicht null Reparaturen —
    deshalb `None` statt 0, sonst liest sich „alter Player" wie „Paritaet ohne
    Wirkung".
    """
    for probe in reversed(proben):
        if "fec_repariert" in probe:
            unrep = probe.get("fec_unreparierbar", 0)
            rep = probe["fec_repariert"]
            return {
                "repariert": rep,
                "unreparierbar": unrep,
                "zu_spaet": probe.get("fec_zu_spaet", 0),
                # Der Anteil, den XOR nicht schliessen konnte. Genau die Zahl
                # entscheidet, ob Reed-Solomon (mehrere Loecher je Gruppe)
                # ueberhaupt ein Problem loesen wuerde, das wir haben.
                "unreparierbar_anteil": (round(unrep / (rep + unrep), 4)
                                         if rep + unrep else None),
            }
    return {"hinweis": "keine fec_*-Felder in den Proben — aelterer Player?"}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--secs", type=float, default=600.0)
    ap.add_argument("--label", default="intraref-verlust")
    ap.add_argument("--fps", type=int, default=60)
    ap.add_argument("--kbps", type=int, default=4000)
    ap.add_argument("--codec", default="av1")
    ap.add_argument("--bits", type=int, default=10)
    ap.add_argument("--audio", default="Aus")
    ap.add_argument("--keyframes", action="store_true",
                    help="Gegenprobe: periodische Keyframes statt Intra-Refresh")
    args = ap.parse_args()

    server_ip = socket.gethostbyname(_fern.HOST)
    iface = iface_zu(server_ip)
    betrieb = "Keyframes 2 s" if args.keyframes else "Intra-Refresh"
    print(f"[{args.label}] {betrieb} — {_fern.HOST} = {server_ip} ueber {iface}")

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

    sender_log = HERE / f"sender-{args.label}.log"
    player_log = HERE / f"player-{args.label}.log"
    # Der Encoder-Schalter geht als Umgebung an den Sidecar — `vendor_opts`
    # reicht ihn an den Encoder-Open durch, `warn_unknown` meldet Unbekanntes.
    env = {} if args.keyframes else {"PULSE_ENCODER_OPTS": "intra-refresh=1,forced-idr=1"}
    sender = Sidecar(open(sender_log, "w"), env)
    player = None
    proben: list[dict] = []
    vollbilder: list[dict] = []
    stopp = threading.Event()
    try:
        path, pub, rd = _fern.mint_remote()
        push = _fern.push_url(path, pub, "whip", 120)
        print(f"[{args.label}] Pfad {path}")
        if not sender_starten(sender, args, pub, push):
            return 1

        time.sleep(5.0)
        pf = open(player_log, "w")
        player = Player(pf)
        whep = f"https://{_fern.HOST}/whep/{path}/whep?token={rd}"
        res = player.call("open", url=whep, title=f"Verlust {args.label}",
                          options={"volume": 0.0}, timeout=30)
        if not res.get("ok"):
            print(f"open fehlgeschlagen: {res}", file=sys.stderr)
            return 1
        sid = res["session"]
        start = time.monotonic()
        threading.Thread(target=ereignisse_lesen,
                         args=(player_log, start, vollbilder, stopp), daemon=True).start()
        # Ein Vollbild auf Zuruf: im Intra-Refresh-Betrieb hat der Strom nach
        # dem Start keinen Einstiegspunkt mehr, der Player bliebe sonst schwarz.
        time.sleep(1.0)
        sender.call("keyframe", timeout=10)

        ende = start + args.secs
        while time.monotonic() < ende:
            time.sleep(1.0)
            s = player.call("stats", session=sid)
            if s.get("ok"):
                proben.append(s)
            # Laufend melden, was der Leser-Faden gefunden hat — ein Lauf ueber
            # zehn Minuten soll nicht schweigen, bis er fertig ist.
            for e in vollbilder:
                if not e.pop("_neu", False):
                    continue
                print(f"  [{e['sekunde']:>7.1f} s] {e['meldung']}", flush=True)
    except KeyboardInterrupt:
        print("\nabgebrochen — werte aus, was da ist")
    finally:
        stopp.set()
        if player:
            player.stop()
        sender.stop()
        subprocess.run(["sudo", "pkill", "-INT", "-f", f"tcpdump.*{pcap.name}"], check=False)
        try:
            dump.wait(timeout=10)
        except subprocess.TimeoutExpired:
            dump.kill()

    netz = _nw.auswerten(pcap, server_ip=server_ip)
    ergebnis = {
        "label": args.label,
        "betrieb": betrieb,
        "sekunden": round(args.secs, 1),
        "netz": netz,
        "paritaet": paritaet_auswerten(proben),
        "vollbild_ereignisse": [{k: v for k, v in e.items() if not k.startswith("_")}
                                for e in vollbilder],
        "player_proben": len(proben),
    }
    ziel = HERE / f"{args.label}.json"
    ziel.write_text(json.dumps(ergebnis, indent=1, ensure_ascii=False) + "\n")
    print(json.dumps(ergebnis["netz"], indent=1, ensure_ascii=False))
    print(f"\nVollbild-Ereignisse: {len(vollbilder)}")
    for e in vollbilder:
        print(f"  {e['sekunde']:>7.1f} s  {e['meldung']}")
    if not netz["nack_deckt_lauf_ab"]:
        print("\nWARNUNG: die NACKs decken den Lauf nicht ab — der Mitschnitt lief "
              "vermutlich nach einem Player-Abbruch weiter. Zahlen NICHT verwenden.",
              file=sys.stderr)
    print(f"\ngeschrieben: {ziel}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
