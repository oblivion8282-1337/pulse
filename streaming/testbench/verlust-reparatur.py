#!/usr/bin/env python3
"""Warum steht nach einem Paketverlust gelegentlich sekundenlang das Bild?

**Hiess bis zum 2026-08-21 `intraref-verlust.py`** und fragte dasselbe fuer die
Betriebsart rollender Intra-Refresh. Die ist entfernt; die Frage nach der
Verlust-Reparatur bleibt und ist bei einem Vollbild-Abstand von 60 s sogar
dringender — so lange darf kein Bild stehen.

Ein Standbild ist NICHT die Wartezeit auf ein angefordertes Vollbild. Der
Unterschied ist mehrfach verlorengegangen. Der Sender braucht dafuer ein bis
zwei Bildabstaende: 130 Anforderungen auf NVIDIA, Median 11,6 ms, groesster
Wert 22,7 ms (`profiles/nvidia-2026-08-11-anforderung-bis-vollbild.json`). Was
die Standbilder lang macht, ist alles ANDERE in der Kette — und genau danach
fragt dieses Skript.

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

**Warum der ECHTE Sender und nicht ffmpeg** (wie in `fern-nack.py`): gemessen
werden soll die Kette, die wirklich ausgeliefert wird — eigener WHIP-Sender,
eigener Paketierer, eigener Rueckkanal. Der Preis ist das Portal: der Lauf
braucht einen wachen Bildschirm und beim ersten Mal einen Klick.

    ./verlust-reparatur.py --secs 600

Beim Auswerten zaehlt die **Lebendkontrolle** (`nack_deckt_lauf_ab`): decken
die NACKs nicht den groessten Teil des Laufs ab, ist der Mitschnitt nach einem
Player-Abbruch weitergelaufen und die Zahlen sind wertlos.
"""

from __future__ import annotations

import argparse
import json
import os
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


# Grosse Datei zum Saettigen des Empfangswegs. Bewusst NICHT vom Labor-Server:
# der ist die Gegenstelle der Messung, ihn zusaetzlich zu belasten wuerde
# Leitung und Server vermischen.
STOER_QUELLE = "https://geo.mirror.pkgbuild.com/iso/latest/archlinux-x86_64.iso"


def stoerung(quelle: str, stroeme: int, dauer: float, log) -> None:
    """Den Empfangsweg fuer `dauer` Sekunden saettigen.

    Mehrere parallele Downloads statt eines einzigen: eine TCP-Verbindung
    erreicht die Leitungsgrenze oft nicht, mehrere schon — und genau die
    Saettigung ist der Zustand, der den Videostrom umbringt (gemessen
    2026-07-31: waehrend eines Speedtests lief der Decoder weiter und die
    Ausgabe brach ein, weil die Pakete zu spaet kamen, nicht weil sie fehlten).
    """
    procs = [subprocess.Popen(["curl", "-s", "-o", "/dev/null", quelle],
                              stdout=log, stderr=log) for _ in range(stroeme)]
    time.sleep(dauer)
    for pr in procs:
        pr.terminate()
    for pr in procs:
        try:
            pr.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pr.kill()


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
            if "Ende-zu-Ende" in zeile:
                # „N ohne Muster" ist der Einfrier-Anzeiger: steht das Bild,
                # liest die Sonde immer denselben Balken, die Latenz wird
                # unglaubwuerdig und der Treffer wird verworfen.
                ziel.append({"sekunde": round(time.monotonic() - start, 1),
                             "meldung": zeile.split("Sitzung")[-1].strip()[-70:],
                             "sonde": True, "_neu": False})
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
            rep = probe["fec_repariert"]
            grenze = probe.get("fec_mehrfach_loch")
            return {
                "repariert": rep,
                # Rechen- und Parse-Fehler. Steht praktisch immer auf 0 und
                # sagt NICHTS ueber die Wirksamkeit der Paritaet.
                "unreparierbar": probe.get("fec_unreparierbar", 0),
                # Paritaet, die nichts bewirkt hat, weil die Nachforderung
                # schneller war. Ein hoher Wert heisst „ueberfluessig", nicht
                # „verloren".
                "verworfen": probe.get("fec_verworfen"),
                # Gruppen mit mehr als einem Loch — die Grenze von XOR und
                # DIE Zahl, die darueber entscheidet, ob Reed-Solomon ein
                # Problem loesen wuerde, das wir haben.
                #
                # Bis zum 2026-07-31 stand hier `unreparierbar_anteil`, der
                # sich auf einen Zaehler stuetzte, der diesen Fall gar nicht
                # sehen konnte. Er war in acht Laeufen 0 — auch dort, wo die
                # Paritaet nachweislich versagte.
                "mehrfach_loch": grenze,
                "grenzfall_anteil": (round(grenze / (rep + grenze), 4)
                                     if grenze is not None and rep + grenze else None),
                "zu_spaet": probe.get("fec_zu_spaet", 0),
            }
    return {"hinweis": "keine fec_*-Felder in den Proben — aelterer Player?"}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--secs", type=float, default=600.0)
    ap.add_argument("--label", default="verlust-reparatur")
    ap.add_argument("--fps", type=int, default=60)
    ap.add_argument("--kbps", type=int, default=4000)
    ap.add_argument("--codec", default="av1")
    ap.add_argument("--bits", type=int, default=10)
    ap.add_argument("--audio", default="Aus")
    # Auf einer APU teilen sich Sender und Player EINE Video-Engine
    # (`vcn_unified_0`): am 2026-08-01 hat 1440p60 in 10 bit mit
    # Hardware-Dekodierung den Ring zum Zeitueberlauf gebracht, der Treiber hat
    # ihn zurueckgesetzt und den Player mitgerissen. Auf getrennten Engines
    # (NVENC/NVDEC) faellt das nicht auf. Deshalb hier ein Schalter statt einer
    # festen nativen Groesse.
    # Wie `harness.py` und `fern-referenz.py`. Auf einer APU ist das kein
    # Komfort-Schalter: Hardware-Dekodierung UND Encode teilen sich dort eine
    # Engine, und der Ring lief am 2026-08-01 reproduzierbar ueber (zweimal
    # binnen 82 s, Kernel nennt jedes Mal `Process pulse-player`).
    ap.add_argument("--hwdec", choices=("auto", "hw", "sw"), default="auto")
    ap.add_argument("--aufloesung", default=None,
                    help="Native/4K/1440p/1080p/720p/480p oder WxH. Ohne Angabe "
                         "die native Groesse des Schirms. Achtung: der Sidecar "
                         "liest Unbekanntes still als Native")
    # Fuer die Einfrier-Diagnose (2026-07-31): schreibt den ANKOMMENDEN
    # Bitstrom mit, vor dem Decoder. Zeigt die Aufnahme Bewegung, waehrend der
    # Schirm stand, liegt der Fehler im Decoder oder in der Darstellung; steht
    # sie auch, liegt er davor. Ohne Neukodierung, kostet also fast nichts.
    ap.add_argument("--aufnehmen", metavar="PFAD",
                    help="ankommenden Bitstrom mitschreiben (Einfrier-Diagnose)")
    # Zeitmuster + Sonde. Das Bild traegt dann die Uhrzeit selbst, und der
    # Player liest sie zurueck — damit ist ein EINGEFRORENES Bild maschinell
    # erkennbar: die abgelesene Zeit bleibt stehen, die errechnete Latenz
    # ueberschreitet `MAX_PLAUSIBLE_MS`, und der Player zaehlt „ohne Muster"
    # hoch. Ohne das braucht es einen Menschen, der hinsieht.
    ap.add_argument("--muster", action="store_true",
                    help="Zeitmuster anzeigen und im Player zuruecklesen")
    # Stoerung selbst erzeugen, statt auf einen Menschen mit Mobiltelefon zu
    # warten: parallele Downloads saettigen den Empfangsweg. `--stoeren 120:20`
    # heisst „ab Sekunde 120 fuer 20 Sekunden".
    ap.add_argument("--stoeren", metavar="AB:DAUER",
                    help="Leitung selbst saettigen, z.B. 120:20")
    ap.add_argument("--stoer-quelle", default=STOER_QUELLE)
    ap.add_argument("--stoer-strom", type=int, default=4,
                    help="parallele Downloads (mehr = haertere Stoerung)")
    # Der Einfrierfehler ist SPORADISCH: dieselbe Stoerung kippt den Player
    # einmal und einmal nicht (2026-07-31 beide Faelle gemessen). Er haengt
    # also an einem Rennen beim Aufloesen des Staus. Ein einzelner Zyklus
    # trifft ihn nicht verlaesslich — deshalb wiederholen, bis es passiert.
    ap.add_argument("--stoer-alle", type=float, metavar="SEKUNDEN",
                    help="Stoerung wiederholen (Abstand zwischen den Zyklen)")
    args = ap.parse_args()

    server_ip = socket.gethostbyname(_fern.HOST)
    iface = iface_zu(server_ip)
    print(f"[{args.label}] {_fern.HOST} = {server_ip} ueber {iface}")

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
    # Der Sidecar faehrt seine Vorgabe. Wer den Vollbild-Abstand fuer einen
    # Lauf verstellen will, setzt `PULSE_KEYFRAME_SECONDS` von aussen.
    env: dict[str, str] = {}
    # Zeitmuster VOR dem Sender: der Sidecar nimmt den Bildschirm auf, das
    # Muster muss also schon stehen, wenn die Aufnahme beginnt.
    muster = None
    player_env: dict[str, str] = {}
    if args.muster:
        epoche = str(int(time.time() * 1000))
        muster = subprocess.Popen(
            [sys.executable, str(HERE / "latency-pattern.py")],
            env={**os.environ, "PULSE_LATENCY_EPOCH_MS": epoche},
            stdout=open(HERE / f"muster-{args.label}.log", "w"),
            stderr=subprocess.STDOUT)
        time.sleep(2.0)
        if muster.poll() is not None:
            print("Zeitmuster startete nicht — siehe muster-Log", file=sys.stderr)
            return 1
        player_env = {"PULSE_PLAYER_LATENCY_PROBE": "1",
                      "PULSE_PLAYER_LATENCY_EPOCH_MS": epoche}
        print("Zeitmuster laeuft — der Bildschirm zeigt jetzt die Messbalken.")

    sender = Sidecar(open(sender_log, "w"), env)
    player = None
    # Vor dem `try`, weil das `finally` sie braucht: scheitert der Lauf vor der
    # Sitzungseroeffnung, verdeckte ein NameError dort den echten Fehler.
    sid = None
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
        player = Player(pf, player_env)
        whep = f"https://{_fern.HOST}/whep/{path}/whep?token={rd}"
        optionen = {"volume": 0.0}
        optionen |= {"auto": {}, "hw": {"hwdec": True}, "sw": {"hwdec": False}}[args.hwdec]
        res = player.call("open", url=whep, title=f"Verlust {args.label}",
                          options=optionen, timeout=30)
        if not res.get("ok"):
            print(f"open fehlgeschlagen: {res}", file=sys.stderr)
            return 1
        sid = res["session"]
        start = time.monotonic()
        threading.Thread(target=ereignisse_lesen,
                         args=(player_log, start, vollbilder, stopp), daemon=True).start()

        # Ein Vollbild auf Zuruf: bei 60 s Abstand kaeme der naechste
        # Einstiegspunkt erst nach einer Minute, der Player bliebe so lange
        # schwarz.
        #
        # WIEDERHOLT anfordern, bis der Player den Einstieg meldet. Eine
        # einzelne Anforderung ist ein Wettlauf: geht sie hinaus, waehrend der
        # Player noch im ICE-Aufbau steckt, kommt nie wieder eine — der Lauf
        # laeuft dann 150 Sekunden mit „dekodiert 0/s" durch und ist wertlos
        # (am 2026-07-31 genau so passiert). Kostet im Normalfall einen
        # einzigen Durchgang.
        for _versuch in range(6):
            time.sleep(1.0)
            sender.call("keyframe", timeout=10)
            time.sleep(1.5)
            if any(e.get("meldung", "").find("Einstiegspunkt") >= 0 for e in vollbilder):
                break
        else:
            print("WARNUNG: Player meldet keinen Einstiegspunkt — Lauf ist wertlos",
                  file=sys.stderr)

        # Die Aufnahme braucht ZWEI Anforderungen, und die Reihenfolge ist eine
        # Zwickmuehle, in die der erste Versuch am 2026-07-31 gelaufen ist:
        #
        #   * VOR dem ersten Bild lehnt der Player `record` ab
        #     ("noch kein Bild empfangen — erst nach dem ersten Frame moeglich").
        #   * DANACH schreibt der Recorder erst ab dem naechsten Video-Keyframe
        #     (`recorder.rs::awaiting_keyframe`) — und den gibt es im
        #     regulaeren Takt erst nach bis zu einer Minute gibt.
        #
        # Also: erst der Einstieg oben, dann `record`, dann ein zweites Vollbild
        # als Startpunkt der Datei. Ohne das zweite bleibt sie leer, und das
        # faellt erst beim Ansehen auf.
        if args.aufnehmen:
            time.sleep(1.5)
            r = player.call("record", session=sid, path=str(args.aufnehmen), timeout=15)
            if r.get("ok"):
                print(f"Aufnahme laeuft: {r.get('path')}", flush=True)
                time.sleep(0.3)
                sender.call("keyframe", timeout=10)
            else:
                print(f"Aufnahme fehlgeschlagen: {r}", file=sys.stderr, flush=True)

        stoer_ab = stoer_dauer = None
        if args.stoeren:
            stoer_ab, stoer_dauer = (float(x) for x in args.stoeren.split(":"))
            stoer_log = open(HERE / f"stoerung-{args.label}.log", "w")

        ende = start + args.secs
        while time.monotonic() < ende:
            time.sleep(1.0)
            if stoer_ab is not None and time.monotonic() - start >= stoer_ab:
                print(f"[{time.monotonic() - start:.0f} s] STOERUNG an "
                      f"({args.stoer_strom} Stroeme, {stoer_dauer:.0f} s)", flush=True)
                stoerung(args.stoer_quelle, args.stoer_strom, stoer_dauer, stoer_log)
                print(f"[{time.monotonic() - start:.0f} s] Stoerung aus", flush=True)
                if args.stoer_alle:
                    stoer_ab = time.monotonic() - start + args.stoer_alle
                else:
                    stoer_ab = None
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
            if args.aufnehmen and sid is not None:
                # Vor `stop()`: danach ist die Sitzung weg und der Muxer
                # schliesst die Datei nicht mehr sauber ab.
                try:
                    player.call("stop_record", session=sid, timeout=15)
                except Exception as e:                       # noqa: BLE001
                    print(f"stop_record fehlgeschlagen: {e}", file=sys.stderr)
            player.stop()
        sender.stop()
        if muster:
            muster.terminate()
            try:
                muster.wait(timeout=5)
            except subprocess.TimeoutExpired:
                muster.kill()
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
        # Die Proben SELBST, nicht nur ihre Anzahl. Fuer die Einfrier-Suche
        # zaehlen `packets_reordered` und `packets_lost` ueber die Zeit: sie
        # sagen, ob der Jitter-Puffer beim Stau-Ende Pakete verwirft — und das
        # steht in keiner Logzeile, nur in der `stats`-Antwort.
        "verlauf": [{k: v for k, v in pr.items()
                     if k in ("packets_received", "packets_lost", "packets_reordered",
                              "packets_duplicate", "frames_decoded", "frames_dropped",
                              "frames_skipped", "buffered_packets", "fec_repariert",
                              "fec_unreparierbar", "fec_verworfen", "fec_mehrfach_loch",
                              "fec_zu_spaet",
                              # Die gemessene Umlaufzeit steuert seit dem
                              # 2026-07-31 die NACK-Sperrfrist. Ohne sie in der
                              # Akte ist nicht nachvollziehbar, mit welcher
                              # Sperre ein Lauf gefahren ist — und ein zu
                              # grosser Wert kostet Bild.
                              "rtt_ms")}
                    for pr in proben],
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
