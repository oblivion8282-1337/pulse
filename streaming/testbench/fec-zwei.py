#!/usr/bin/env python3
"""Zwei gleichzeitige Zuschauer an EINEM Strom — regelt das Tor je Sitzung?

**Die Frage, die es entscheidet.** Die erste Fassung der Paritaets-Regelung
hielt ihr Tor in einer prozessweiten Variablen (`pulseFecTorAktiv`), mit dem
Vermerk „bei mehreren gleichzeitigen Zuschauern regelt der zuletzt verbundene
fuer alle, und das ist ungetestet". Die heutige Fassung haengt es an die
PeerConnection. Dass das richtig ist, war bis hierher nur am Quelltext
geprueft.

**Der Kniff: es braucht keinen Verlust.** Jede Sitzung faehrt ein
Anlauffenster — die ersten Sekunden geht die Paritaet immer hinaus, damit das
Einstiegs-Vollbild geschuetzt ist. Genau daran trennen sich die beiden
Bauweisen:

* **je Sitzung** (Soll): A bekommt Paritaet in SEINEN ersten Sekunden und
  danach nie wieder. Wenn B spaeter dazukommt, aendert sich bei A nichts.
* **prozessweit** (die alte Falle): B's Verbindungsaufbau legt ein neues Tor
  an, an dem danach BEIDE haengen — bei A muesste die Paritaet also ein
  zweites Mal anspringen, zum Zeitpunkt von B's Beitritt.

Ein Blick auf A's Paritaetszaehler je Sekunde beantwortet das also allein, auf
einer voellig ungestoerten Leitung. Zusaetzlich belegt der Server es von seiner
Seite: er schreibt beim Sitzungsende je Sitzung EINE Tor-Zeile mit eigenen
Zaehlern.

    export PULSE_FERN_SSH=pulse-test PULSE_FERN_PASS=… PULSE_FERN_TOKEN=…
    ./fec-zwei.py --secs 90 --zweiter-ab 40
    ./fec-zwei.py --secs 90 --zweiter-ab 40 --profil verlust
"""

from __future__ import annotations

import argparse
import json
import signal
import subprocess
import sys
import threading
import time

import gemeinsam
from serverstoerung import netem_setzen, netem_weg, netem_wirkung

# `fec-adaptiv.py` traegt einen Bindestrich; `gemeinsam.laden` ist der Weg
# dafuer. Von dort kommen Serverumbau und Push — beides ein zweites Mal
# hinzuschreiben hiesse, es bei jeder Aenderung an zwei Stellen nachzuziehen.
_fa = gemeinsam.laden("fec-adaptiv")
HERE = _fa.HERE


def zuschauer(whep: str, label: str, secs: int, verzoegerung: float) -> None:
    """Ein Browser-Zuschauer, der erst nach `verzoegerung` Sekunden aufmacht."""
    if verzoegerung > 0:
        time.sleep(verzoegerung)
    subprocess.run(
        ["node", str(HERE / "browser-whep.mjs"), "--url", whep,
         "--secs", str(secs), "--label", label],
        capture_output=True, text=True, check=False)


def paritaet_je_sekunde(label: str) -> list[tuple[int, int]]:
    """(Wanduhr in ms, Paritaetspakete in dieser Sekunde).

    Die Uhrzeit ist der Punkt: zwei gleichzeitig laufende Zuschauer lassen sich
    nur ueber sie gegeneinander legen. Ueber die Probennummern zu schaetzen hat
    beim ersten Durchgang genau die Frage offengelassen, um die es geht.
    """
    datei = HERE / f"browser-proben-{label}.json"
    if not datei.exists():
        return []
    proben = json.loads(datei.read_text())

    return [(int(b.get("t") or 0),
             int(b.get("fecPacketsReceived") or 0) - int(a.get("fecPacketsReceived") or 0))
            for a, b in zip(proben, proben[1:], strict=False)]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quelle", default=str(HERE / "fec-intraref-20s.mkv"))
    ap.add_argument("--profil", default="klar", choices=tuple(_fa.serverstoerung.PROFILE))
    ap.add_argument("--secs", type=int, default=90)
    ap.add_argument("--zweiter-ab", type=float, default=40.0)
    ap.add_argument("--label", default="zwei")
    ap.add_argument("--image", default="pulse-mediamtx:v2")
    ap.add_argument("--modus", action="append", default=["PULSE_FLEXFEC_ADAPTIV=1"])
    args = ap.parse_args()

    print(_fa.server_modus(args.modus, args.image).splitlines()[0])
    path, pub, rd = _fa._fh.mint_remote()
    whep = f"https://{_fa._fh.HOST}/whep/{path}/whep?token={rd}"
    print(f"[{args.label}] Pfad {path}, Profil {args.profil}, "
          f"B kommt nach {args.zweiter_ab} s dazu")

    push_log = open(HERE / f"push-{args.label}.log", "w")
    push = _fa.start_push(args.quelle, path, pub, push_log)
    time.sleep(8)
    if push.poll() is not None:
        raise SystemExit("Sender ist gestorben")

    netem_setzen(args.profil)
    a_label, b_label = f"{args.label}-A", f"{args.label}-B"
    # B laeuft kuerzer, damit beide gemeinsam enden — sonst waere sein
    # Anlauffenster das Letzte, was man sieht, und der Vergleich schiefe.
    b_secs = max(10, args.secs - int(args.zweiter_ab))
    faeden = [
        threading.Thread(target=zuschauer, args=(whep, a_label, args.secs, 0.0)),
        threading.Thread(target=zuschauer, args=(whep, b_label, b_secs, args.zweiter_ab)),
    ]
    try:
        for f in faeden:
            f.start()
        for f in faeden:
            f.join()
        netem = netem_wirkung()
    finally:
        netem_weg()
        push.send_signal(signal.SIGINT)
        try:
            push.wait(timeout=5)
        except subprocess.TimeoutExpired:
            push.kill()
        push_log.close()

    a, b = paritaet_je_sekunde(a_label), paritaet_je_sekunde(b_label)
    if not a or not b:
        raise SystemExit("mindestens ein Zuschauer hat keine Proben geliefert")

    # Gemeinsame Zeitachse ab A's erster Probe, in ganzen Sekunden.
    null = a[0][0]
    reihe = {round((t - null) / 1000): v for t, v in a}
    reihe_b = {round((t - null) / 1000): v for t, v in b}
    ende = max(max(reihe), max(reihe_b))
    b_beginn = min(reihe_b)

    print(f"\nGemeinsame Zeitachse, Paritaetspakete je Sekunde. "
          f"B ist ab Sekunde {b_beginn} verbunden.")
    print("  s   A    B")
    for s in range(ende + 1):
        va, vb = reihe.get(s), reihe_b.get(s)
        marke = "  <- B kommt dazu" if s == b_beginn else ""
        print(f"{s:3d} {va if va is not None else '-':>4} "
              f"{vb if vb is not None else '-':>4}{marke}")

    # Der Beweis in einer Zeile: gibt es einen Zeitpunkt, zu dem die beiden
    # Tore VERSCHIEDEN stehen? Bei einem prozessweiten Tor ist das unmoeglich.
    gemeinsam_offen = [s for s in reihe if s in reihe_b and reihe[s] > 0 and reihe_b[s] > 0]
    getrennt = [s for s in reihe if s in reihe_b and (reihe[s] > 0) != (reihe_b[s] > 0)]
    print(f"\nSekunden, in denen BEIDE Paritaet bekamen:      {len(gemeinsam_offen)}")
    print(f"Sekunden, in denen NUR EINER Paritaet bekam:    {len(getrennt)}  {getrennt[:12]}")
    print("Ein prozessweites Tor kann die zweite Zahl nicht erzeugen —"
          " es gaebe nur EINEN Zustand fuer beide.")
    print(f"\nnetem: {netem[1]} von {netem[0]} Paketen verworfen")

    return 0


if __name__ == "__main__":
    sys.exit(main())
