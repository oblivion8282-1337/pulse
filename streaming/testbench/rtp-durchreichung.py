#!/usr/bin/env python3
"""Reicht MediaMTX RTP durch, oder paketisiert er neu?

Die Frage entscheidet, wo eine Paritaets-Schicht (FEC) ueberhaupt sitzen kann:

* **Durchgereicht** — dieselben Pakete kommen beim Zuschauer an, die der Sender
  losgeschickt hat. Dann kann der Sender Parität erzeugen und unser Player sie
  zurueckrechnen; MediaMTX ist nur Rohr, und wir brauchen dort nichts.
* **Neu paketisiert** — MediaMTX baut aus dem RTP Zugriffseinheiten und schneidet
  daraus neue Pakete. Dann beziehen sich Paritaetspakete des Senders auf
  Paketgrenzen, die hinter MediaMTX nicht mehr existieren. FEC muesste je
  Strecke getrennt sitzen, und fuer die Strecke zum Zuschauer waere MediaMTX
  selbst der Erzeuger — also ein weiterer Fork-Patch.

**Warum das aus einem einzigen Mitschnitt beantwortbar ist:** Sender und Player
laufen beide auf DIESEM Rechner. Der ausgehende Strom (wir → MediaMTX) und der
eingehende (MediaMTX → wir) laufen also ueber dieselbe Schnittstelle und stehen
in derselben Aufnahme. SRTP verschluesselt nur die Nutzlast — SSRC, Sequenz-
nummer und Zeitstempel stehen im Klartext im RTP-Kopf und sind damit lesbar.

Gepruefte Kennzeichen, in dieser Reihenfolge aussagekraeftig:

1. **SSRC**: bei Durchreichung dieselbe Quellkennung auf beiden Seiten.
2. **Paketzahl**: bei Durchreichung ungefaehr gleich viele Medienpakete je
   Richtung (bis auf Nachlieferungen und den Anlauf).
3. **Paketgroessen**: das schaerfste Merkmal. Wer neu schneidet, trifft die
   Groessenverteilung des Senders nicht — insbesondere die Groesse des LETZTEN
   Pakets je Bild ist dann eine andere.

    ./rtp-durchreichung.py mitschnitt.pcap --fern-ip 77.42.71.166
"""

from __future__ import annotations

import argparse
import struct
import sys
from collections import Counter, defaultdict
from pathlib import Path

from pcap_rtcp import pakete

# RTP-Version 2 im ersten Byte. DTLS und STUN teilen den Port, muessen also
# ausgeschieden werden: STUN beginnt mit 0x00/0x01, DTLS liegt bei 20-63.
# RTP/RTCP bleibt damit als 128-191 uebrig; RTCP sind die Typen 200-207.
def ist_rtp(nutzlast: bytes) -> bool:
    """RTCP ausscheiden — und zwar am UNMASKIERTEN zweiten Byte.

    Die Falle, die mir hier zuerst gestellt wurde: bei RTP ist das oberste Bit
    des zweiten Bytes das Marker-Bit, bei RTCP gehoert es zum Pakettyp. Wer
    erst mit `& 0x7F` maskiert und dann auf 200-207 prueft, vergleicht
    Aepfel mit Birnen — aus RTCP 200/201/206 werden 72/73/78, die Pruefung
    greift nie, und jeder Empfangsbericht zaehlt als Medienpaket.
    """
    if len(nutzlast) < 12 or not 128 <= nutzlast[0] <= 191:
        return False
    return not 200 <= nutzlast[1] <= 207


def rtp_kopf(nutzlast: bytes) -> tuple[int, int, int]:
    """(ssrc, sequenznummer, payload_type) — unverschluesselt bei SRTP."""
    seq = struct.unpack("!H", nutzlast[2:4])[0]
    ssrc = struct.unpack("!I", nutzlast[8:12])[0]
    return ssrc, seq, nutzlast[1] & 0x7F


def lesen(pcap: Path, fern_ip: str) -> dict[str, list]:
    """Nutzt den pcap-Leser des Repos (`pcap_rtcp`), nicht tshark.

    Ein zweiter Parser waere ein zweiter Ort, an dem die Link-Schicht falsch
    abgezogen wird — und genau daran ist am 2026-07-28 schon einmal eine
    Auswertung still gescheitert."""
    raus: dict[str, list] = {"hin": [], "her": []}
    for src, dst, _, _, nutzlast in pakete(pcap):
        if not ist_rtp(nutzlast):
            continue
        richtung = "hin" if dst == fern_ip else "her" if src == fern_ip else None
        if richtung:
            ssrc, seq, pt = rtp_kopf(nutzlast)
            raus[richtung].append((ssrc, seq, pt, len(nutzlast)))
    return raus


def bericht(name: str, roh: list) -> dict[int, list]:
    """Je SSRC zaehlen und die Groessenverteilung zeigen.

    Die Groessen stimmen nur, wenn der Mitschnitt NICHT gekappt wurde
    (`tcpdump -s`): der Leser liefert die aufgezeichnete Laenge, nicht die
    urspruengliche. Deshalb der Hinweis unten — sonst vergleicht man zwei Mal
    die Kappgrenze und haelt das fuer Uebereinstimmung.
    """
    je_ssrc: dict[int, list] = defaultdict(list)
    for ssrc, seq, pt, groesse in roh:
        je_ssrc[ssrc].append((seq, pt, groesse))

    print(f"\n{name}: {len(roh)} RTP-Pakete, {len(je_ssrc)} SSRC")
    for ssrc, liste in sorted(je_ssrc.items(), key=lambda kv: -len(kv[1])):
        pts = Counter(pt for _, pt, _ in liste)
        groessen = [g for _, _, g in liste]
        gross = sum(1 for g in groessen if g > 1000)
        print(f"  SSRC {ssrc:>10}  {len(liste):>6} Pakete  PT {dict(pts)}  "
              f"Groesse min/med/max {min(groessen)}/"
              f"{sorted(groessen)[len(groessen) // 2]}/{max(groessen)}  "
              f"ueber 1000 B: {gross} ({100 * gross / len(groessen):.0f}%)")
        if max(groessen) <= 200 and groessen.count(max(groessen)) > 0.9 * len(groessen):
            print("    (Mitschnitt gekappt — Groessen sagen hier nichts aus)")
    return je_ssrc


def groessen_vergleich(hin: dict, her: dict) -> float | None:
    """Das eigentlich entscheidende Merkmal: hat sich der PAKETSCHNITT geaendert?

    Eine andere SSRC beweist nichts — ein SFU schreibt die Kennung ueblicherweise
    um und leitet die Nutzlast trotzdem unveraendert weiter. Wer neu schneidet,
    trifft dagegen die Groessenverteilung des Senders nicht mehr.

    Verglichen werden **relative Haeufigkeiten**, nicht Anzahlen: die beiden
    Richtungen laufen unterschiedlich lang (der Sender ist vor dem Zuschauer da),
    ein Vergleich absoluter Zahlen misst also vor allem den Zeitversatz.
    Ausgewertet wird der Videostrom, das ist jeweils der groessere.
    """
    def verteilung(seite: dict) -> tuple[Counter, int]:
        ssrc = max(seite, key=lambda s: len(seite[s]))
        groessen = [g for _, _, g in seite[ssrc]]
        # In 100-Byte-Klassen: auf das einzelne Byte genau waere es Rauschen,
        # der Schnitt zeigt sich an der Verteilung ueber die Klassen.
        return Counter(g // 100 * 100 for g in groessen), len(groessen)

    if not hin or not her:
        return None
    v_hin, n_hin = verteilung(hin)
    v_her, n_her = verteilung(her)

    print("\n--- Paketgroessen des Videostroms (relative Haeufigkeit) ---")
    print(f"{'Klasse':>10s} {'hin':>8s} {'her':>8s}")
    for klasse in sorted(set(v_hin) | set(v_her)):
        a = 100 * v_hin.get(klasse, 0) / n_hin
        b = 100 * v_her.get(klasse, 0) / n_her
        marke = "  <== Unterschied" if abs(a - b) > 3.0 else ""
        print(f"{klasse:>6}-{klasse + 99:<4} {a:7.1f}% {b:7.1f}%{marke}")

    abstand = sum(abs(100 * v_hin.get(k, 0) / n_hin - 100 * v_her.get(k, 0) / n_her)
                  for k in set(v_hin) | set(v_her)) / 2
    print(f"\nGesamtabweichung der Verteilungen: {abstand:.1f} Prozentpunkte "
          f"({'gleicher Schnitt' if abstand < 5 else 'ANDERER Schnitt'})")
    return abstand


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pcap", type=Path)
    ap.add_argument("--fern-ip", default="77.42.71.166")
    args = ap.parse_args()

    daten = lesen(args.pcap, args.fern_ip)
    hin = bericht("HIN  (Sender → MediaMTX)", daten["hin"])
    her = bericht("HER  (MediaMTX → Player)", daten["her"])

    abstand = groessen_vergleich(hin, her)

    gemeinsam = set(hin) & set(her)
    print("\n--- Urteil ---")
    # Zwei Fragen, NICHT eine: die Kennung sagt, ob der Strom identisch bleibt,
    # die Groessenverteilung sagt, ob der SCHNITT bleibt. Ein SFU, der nur
    # umetikettiert, beantwortet die erste mit Nein und die zweite mit Ja — wer
    # nur die SSRC prueft, haelt ihn faelschlich fuer einen Umpaketierer.
    print("SSRC gleich: " + ("ja " + str(sorted(gemeinsam)) if gemeinsam else "nein"))
    print(f"Paketschnitt gleich: "
          f"{'ja' if abstand is not None and abstand < 5 else 'nein'}")

    if gemeinsam:
        print("=> Voll durchgereicht. Parität kann Ende zu Ende zwischen Sender")
        print("   und Player liegen, MediaMTX bleibt unberührt.")
    elif abstand is not None and abstand < 5:
        print("=> MediaMTX reicht die Nutzlast paketweise durch und schreibt nur")
        print("   die Kopfdaten um (SSRC, Sequenznummer). Folgen für FEC:")
        print("   - Parität des Senders erreicht den Zuschauer NICHT: sie bezieht")
        print("     sich auf Sequenznummern, die hinter MediaMTX neu vergeben sind,")
        print("     und ein eigener FEC-Strom wäre ein Track, den MediaMTX nicht kennt.")
        print("   - Ein FEC-Erzeuger IN MediaMTX sitzt dagegen richtig: er sieht")
        print("     dieselben Paketgrenzen, die der Sender gewählt hat.")
    else:
        print("=> MediaMTX terminiert die RTP-Ebene und paketisiert NEU.")
        print("   Parität muss je Strecke getrennt sitzen und kann sich auf keine")
        print("   Paketgrenze des Senders stützen.")
    # Die Paketzahl ist das zweite Kennzeichen und faellt auch dann auf, wenn
    # eine Seite ihre SSRC nur umschreibt, den Schnitt aber beibehaelt.
    v_hin = sum(len(v) for v in hin.values())
    v_her = sum(len(v) for v in her.values())
    if v_hin and v_her:
        print(f"\nPaketzahl hin/her: {v_hin}/{v_her} "
              f"(Verhaeltnis {v_her / v_hin:.2f})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
