#!/usr/bin/env python3
"""Landen die Nachlieferungen ueberhaupt im SRTP-Wiedergabefenster?

**Der Wiedergabeschutz kann Reparaturen wegwerfen, ohne es zu melden.**
`webrtc-srtp` verwirft jedes Paket, dessen Sequenznummer weiter als
`window_size` hinter der hoechsten bisher angenommenen liegt — die Pruefung
steht in `webrtc-util/src/replay_detector/mod.rs`:

    if self.latest_seq >= self.window_size as u64 + seq { return false }

Der Vorgabewert ist **64** (`webrtc-srtp/src/session/mod.rs:7`), und wer keine
`SettingEngine` setzt, erbt ihn. Bei 440 Paketen je Sekunde sind 64 Pakete
rund 145 Millisekunden — weniger als eine Umlaufzeit plus Wartezeit auf der
Gegenseite. Eine Nachlieferung, die laenger braucht, wird still verworfen.

**Die Folge ist eine Rueckkopplung, keine bloss verlorene Reparatur.** Der
NACK-Erzeuger sieht die Luecke weiter offen und fordert alle 10 ms erneut an;
die Gegenseite beantwortet jede Anforderung; jede Antwort faellt aus dem
Fenster. Am 2026-07-31 gemessen: 78 Kopien je verlorenem Paket
(`kopien.py`), rund 900 kbit/s, die der Empfaenger selbst wegwirft.

**Die Zahl, auf die es ankommt,** steht unten unter „Erstzustellungen": das
sind die Pakete, die wirklich fehlten und nachgeliefert wurden. Ihr Abstand
entscheidet, ob der Wiedergabeschutz sie durchlaesst — und damit, ob die
Nachforderung ueberhaupt etwas nuetzt.

    ./fenster.py fec-fest-ab3.pcap
    ./fenster.py mein.pcap 77.42.71.166 --groesse 2048
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from pathlib import Path

from aufschlag import VORGABE_SERVER, erweitern, pakete_lesen

# Vorgabe von webrtc-srtp. Steht hier als Konstante, damit die Gegenprobe mit
# einem groesseren Fenster nur ein Argument ist.
SRTP_VORGABE = 64
STUFEN = [16, 32, 64, 128, 512, 2048]


def messen(pfad: Path, server_ip: str) -> tuple[dict, dict]:
    """Abstaende zur hoechsten Sequenznummer, getrennt nach Erst und Kopie."""
    zustand: dict = {}
    gesehen: dict[int, set] = defaultdict(set)
    hoechste: dict[int, int] = {}
    pakete: dict[int, int] = defaultdict(int)
    erst_spaet: dict[int, list] = defaultdict(list)   # echte Nachlieferungen
    kopie: dict[int, list] = defaultdict(list)        # ueberfluessige Kopien

    for _zeit, vom_server, rtcp, ssrc, seq, _laenge in pakete_lesen(pfad, server_ip):
        if not vom_server or rtcp:
            continue
        e = erweitern(zustand, ssrc, seq)
        pakete[ssrc] += 1
        h = hoechste.get(ssrc)
        if h is None or e > h:
            hoechste[ssrc] = h = e
        abstand = h - e
        if e in gesehen[ssrc]:
            kopie[ssrc].append(abstand)
        else:
            gesehen[ssrc].add(e)
            if abstand > 0:               # kam nach seinem Nachfolger an
                erst_spaet[ssrc].append(abstand)

    haupt = max(pakete, key=lambda s: pakete[s]) if pakete else None
    return ({"ssrc": haupt, "pakete": pakete.get(haupt, 0)},
            {"erst": erst_spaet[haupt], "kopien": kopie[haupt]} if haupt else
            {"erst": [], "kopien": []})


def verteilung(werte: list[int], grenze: int) -> None:
    if not werte:
        print("    (keine)")
        return
    hist: Counter = Counter()
    for a in werte:
        for s in STUFEN:
            if a <= s:
                hist[s] += 1
                break
        else:
            hist[0] += 1                  # groesser als die groesste Stufe
    for s in STUFEN:
        if hist[s]:
            marke = "" if s <= grenze else "   ZU ALT"
            print(f"      bis {s:>5} Pakete: {hist[s]:>8}"
                  f"  ({100 * hist[s] / len(werte):.1f} %){marke}")
    if hist[0]:
        print(f"      darueber        : {hist[0]:>8}"
              f"  ({100 * hist[0] / len(werte):.1f} %)   ZU ALT")
    drin = sum(1 for a in werte if a < grenze)
    print(f"    im Fenster (< {grenze}): {drin} von {len(werte)}"
          f"  ({100 * drin / len(werte):.1f} %)")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pcap")
    ap.add_argument("server_ip", nargs="?", default=VORGABE_SERVER)
    ap.add_argument("--groesse", type=int, default=SRTP_VORGABE,
                    help=f"SRTP-Wiedergabefenster in Paketen (Vorgabe {SRTP_VORGABE})")
    args = ap.parse_args()

    kopf, werte = messen(Path(args.pcap), args.server_ip)
    if not kopf["ssrc"]:
        print("kein RTP vom Server im Mitschnitt")
        return 1
    print(f"{Path(args.pcap).name}  ssrc={kopf['ssrc']}  "
          f"{kopf['pakete']} Zustellungen  Fenster {args.groesse}")

    print("\n  ERSTZUSTELLUNGEN, die nach ihrem Nachfolger ankamen")
    print("  (= echte Nachlieferungen; nur diese reparieren etwas)")
    verteilung(werte["erst"], args.groesse)

    print("\n  UEBERFLUESSIGE KOPIEN (Antworten auf mehrfach gestellte Anforderungen)")
    verteilung(werte["kopien"], args.groesse)

    erst, kop = werte["erst"], werte["kopien"]
    if erst:
        verloren = sum(1 for a in erst if a >= args.groesse)
        print(f"\n  BEFUND: {verloren} von {len(erst)} Nachlieferungen liegen ausserhalb")
        print(f"          des {args.groesse}er-Fensters und werden verworfen —")
        print("          die Luecke bleibt offen, der Erzeuger fordert weiter.")
    if kop and erst:
        print(f"          Auf {len(erst)} gebrauchte Nachlieferungen kommen {len(kop)}")
        print(f"          ueberfluessige Kopien ({len(kop) / len(erst):.0f} je Stueck).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
