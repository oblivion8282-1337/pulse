#!/usr/bin/env python3
"""Ab welcher Verlustrate lohnt sich mehr Paritaet? Kennlinie ueber gesetzten Verlust.

**Die Frage, die dem Labor bis zum 2026-07-31 nicht zu beantworten war.** Alle
frueheren FEC-Vergleiche liefen bei dem Verlust, den die Leitung zufaellig
gerade hatte — rund 0,2 Prozent. Zwei Laeufe mit 0,14 und 0,33 Prozent tragen
aber keine Aussage darueber, welche Einstellung besser ist; entsprechend sind
an diesem Tag drei Befunde umgeworfen worden.

Mit `verluststrecke.py` laesst sich der Verlust jetzt SETZEN. Damit wird aus
dem Vergleich zweier Einzelpunkte eine Kennlinie: dieselbe Einstellung bei
mehreren Verlustraten, und die Antwort darauf, wo sich die Kurven schneiden.

**Warum das die Voraussetzung fuer eine Regelung ist.** Der Plan, 10+1 als
Dauerzustand zu fahren und bei schlechter Leitung auf 10+2 hochzuschalten,
braucht einen Schwellwert. Den kann man nicht raten — er ist genau der Punkt,
an dem 10+2 anfaengt, sein Geld wert zu sein.

**Kein `--stoeren` noetig.** Der gesetzte Verlust liegt von der ersten Sekunde
an konstant an; es muss nicht auf Stoerzyklen gewartet werden. Deshalb
genuegen kurze Laeufe.

**Der Bildschirm wird gebraucht** (Zeitmuster): ohne bewegtes Bild komprimiert
AV1 den statischen Desktop auf einen Bruchteil der Zielrate, und dann misst
der Lauf eine Datenrate, die es im Betrieb nicht gibt.

    sudo -v
    ./fec-kennlinie.py                          # Vorgabe: 0.5/2/5 % gegen 10+1 und 10+2
    ./fec-kennlinie.py --verluste 1 3 --secs 120
    ./fec-kennlinie.py --buendel                # Buendelverlust statt gleichverteilt
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys

import verluststrecke as vs
from harness import HERE

SSH = "michael@77.42.71.166"
NEUSTART = "./mediamtx-labor/neustart.sh"


def server_paritaet(fec: int) -> bool:
    """Labor-MediaMTX auf 10+`fec` umstellen und den Stand VERIFIZIEREN.

    Die Pruefung ist nicht Zierrat: am 2026-07-31 lief eine ganze Messreihe
    gegen einen Schalter, von dem erst hinterher belegt wurde, dass er im
    laufenden Binary ueberhaupt vorkommt.
    """
    subprocess.run(["ssh", "-o", "ConnectTimeout=15", SSH,
                    f"{NEUSTART} PULSE_FLEXFEC_FEC={fec}"],
                   capture_output=True, text=True, timeout=120)
    aus = subprocess.run(
        ["ssh", "-o", "ConnectTimeout=10", SSH,
         'docker inspect mediamtx-labor --format "{{range .Config.Env}}{{println .}}{{end}}"'],
        capture_output=True, text=True, timeout=60).stdout
    # Die LETZTE Nennung zaehlt: `neustart.sh` haengt den uebergebenen Wert
    # hinten an die Vorgabe an, und bei `docker run` gewinnt das spaetere `-e`.
    # Wer die erste Nennung prueft, bekommt immer die Vorgabe zu sehen.
    letzte = [z for z in aus.splitlines() if z.startswith("PULSE_FLEXFEC_FEC=")]
    steht = bool(letzte) and letzte[-1] == f"PULSE_FLEXFEC_FEC={fec}"
    print(f"    Server auf 10+{fec}: {'bestaetigt' if steht else 'NICHT bestaetigt'}")
    return steht


def ein_lauf(label: str, secs: float, kbps: int) -> dict | None:
    """Einen Prueflauf fahren und seine Messwerte einsammeln."""
    befehl = [sys.executable, str(HERE / "intraref-verlust.py"),
              "--secs", str(secs), "--label", label, "--muster", "--kbps", str(kbps)]
    env = {**os.environ, "PULSE_PLAYER_FLEXFEC": "1"}
    r = subprocess.run(befehl, capture_output=True, text=True, timeout=secs + 300, env=env)
    pfad = HERE / f"{label}.json"
    if not pfad.exists():
        print(f"    KEIN ERGEBNIS: {r.stdout[-300:]}")
        return None
    return json.loads(pfad.read_text())


def bildstabilitaet(verlauf: list[dict]) -> dict:
    """Wie gleichmaessig kam das Bild? Aus dem ZUWACHS von `frames_decoded`.

    **Das Feld ist kumulativ, nicht die Rate je Sekunde.** Eine erste Fassung
    dieses Werkzeugs suchte nach einem Feld `dekodiert`, das es gar nicht gibt
    — `x.get("dekodiert") == 0` ist damit immer falsch, und die Auswertung
    meldete stur 'null Sekunden ohne Bild'. Sie haette dasselbe gemeldet, wenn
    der Player die ganze Zeit ein Standbild gezeigt haette. Die Zahl stimmte
    zufaellig; belegt war sie nicht.

    Die erste Sekunde faellt heraus (Anlauf, unvollstaendiges Fenster).
    """
    fd = [x["frames_decoded"] for x in verlauf if "frames_decoded" in x]
    if len(fd) < 3:
        return {"sekunden_gemessen": 0, "sekunden_ohne_bild": None,
                "sekunden_unter_30": None, "bilder_min": None, "bilder_median": None}
    zuwachs = [b - a for a, b in zip(fd, fd[1:], strict=False)][1:]
    return {
        "sekunden_gemessen": len(zuwachs),
        "sekunden_ohne_bild": sum(1 for z in zuwachs if z == 0),
        # Halbe Bildrate ist die Schwelle, ab der Ruckeln sichtbar wird.
        "sekunden_unter_30": sum(1 for z in zuwachs if z < 30),
        "bilder_min": min(zuwachs),
        "bilder_median": sorted(zuwachs)[len(zuwachs) // 2],
    }


def aufschlag_lesen(label: str) -> dict:
    """Bandbreiten-Aufteilung aus dem Mitschnitt."""
    aus = subprocess.run([sys.executable, str(HERE / "aufschlag.py"),
                          str(HERE / f"{label}.pcap")],
                         capture_output=True, text=True).stdout

    def wert(muster: str, typ: type) -> float | None:
        m = re.search(muster, aus)
        return typ(m.group(1)) if m else None

    return {
        "nutzlast_kbit": wert(r"Nutzlast[^\n]*?(\d+) kbit/s", int),
        "paritaet_kbit": wert(r"Paritaet\s+(\d+) kbit/s", int),
        "wiederholungen_kbit": wert(r"Wiederholungen \(NACK\)\s+(\d+) kbit/s", int),
        "aufschlag_prozent": wert(r"GESAMT auf der Leitung\s+\d+ kbit/s\s+=\s+([\d.]+)", float),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--verluste", type=float, nargs="+", default=[0.5, 2.0, 5.0])
    ap.add_argument("--paritaeten", type=int, nargs="+", default=[1, 2])
    ap.add_argument("--secs", type=float, default=180.0)
    ap.add_argument("--kbps", type=int, default=4000)
    ap.add_argument("--buendel", action="store_true")
    ap.add_argument("--marke", default="kennlinie")
    args = ap.parse_args()

    ergebnisse: list[dict] = []
    art = "buendel" if args.buendel else "gleich"
    try:
        for verlust in args.verluste:
            for fec in args.paritaeten:
                label = f"{args.marke}-v{verlust}-f{fec}".replace(".", "_")
                print(f"\n=== Verlust {verlust} % ({art}), Paritaet 10+{fec} — {label}")
                if not server_paritaet(fec):
                    print("    uebersprungen: Serverstand nicht bestaetigt")
                    continue
                vs.an(verlust, vs.VORGABE_ZIEL, args.buendel)
                try:
                    d = ein_lauf(label, args.secs, args.kbps)
                finally:
                    gesehen, weg = vs.aus(vs.VORGABE_ZIEL)
                if d is None:
                    continue
                n, p = d["netz"], d["paritaet"]
                bild = bildstabilitaet(d["verlauf"])
                frier = subprocess.run(["grep", "-c", "eingefroren",
                                        str(HERE / f"player-{label}.log")],
                                       capture_output=True, text=True).stdout.strip()
                ergebnisse.append({
                    "verlust_gesetzt": verlust,
                    "verlust_gemessen": round(100 * weg / gesehen, 3) if gesehen else None,
                    "art": art,
                    "paritaet": f"10+{fec}",
                    **aufschlag_lesen(label),
                    "nachgefordert": n["pakete_mit_kopien"],
                    "kopien_je_paket": n["kopien_je_betroffenem_paket"],
                    "nacks": n["nacks_player_zu_server"],
                    "plis": n["plis_player_zu_server"],
                    "fec_repariert": p["repariert"],
                    "fec_unreparierbar": p["unreparierbar"],
                    "einfrier_eingriffe": int(frier or 0),
                    **bild,
                })
                print(f"    Aufschlag {ergebnisse[-1]['aufschlag_prozent']} %, "
                      f"PLIs {n['plis_player_zu_server']}, "
                      f"unreparierbar {p['unreparierbar']}, "
                      f"schwaechste Sekunde {bild['bilder_min']}/s")
    except KeyboardInterrupt:
        print("\nabgebrochen")
    finally:
        vs.aus(vs.VORGABE_ZIEL, still=True)
        subprocess.run(["ssh", "-o", "ConnectTimeout=15", SSH, NEUSTART],
                       capture_output=True, timeout=120)
        print("Teststrecke abgeraeumt, Server zurueck auf die Vorgabe (10+2).")

    ziel = HERE / f"{args.marke}-{art}.json"
    ziel.write_text(json.dumps(ergebnisse, indent=1))
    tabelle(ergebnisse)
    print(f"\ngeschrieben: {ziel}")
    return 0


def tabelle(zeilen: list[dict]) -> None:
    if not zeilen:
        print("\n(keine Ergebnisse)")
        return
    print(f"\n{'Verlust':>8} {'Par':>5} {'Auf%':>6} {'Par kbit':>9} {'Wdh kbit':>9} "
          f"{'PLI':>5} {'FECrep':>7} {'unrep':>6} {'frier':>6} {'0Bild':>6} {'min/s':>6}")
    # Fehlende Werte als "?" statt Absturz: ein einzelner misslungener Lauf
    # darf nicht die Tabelle der gelungenen mitreissen. Am 2026-07-31 genau so
    # passiert — `None` in einer Format-Angabe, und die ganze Reihe war weg.
    def z(wert, breite):
        return f"{wert:>{breite}}" if wert is not None else f"{'?':>{breite}}"

    for r in zeilen:
        print(z(r['verlust_gesetzt'], 7) + " % " + z(r['paritaet'], 5) + " "
              + z(r['aufschlag_prozent'], 6) + " " + z(r['paritaet_kbit'], 9) + " "
              + z(r['wiederholungen_kbit'], 9) + " " + z(r['plis'], 5) + " "
              + z(r['fec_repariert'], 7) + " " + z(r['fec_unreparierbar'], 6) + " "
              + z(r['einfrier_eingriffe'], 6) + " " + z(r['sekunden_ohne_bild'], 6) + " "
              + z(r['bilder_min'], 6))


if __name__ == "__main__":
    sys.exit(main())
