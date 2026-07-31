#!/usr/bin/env python3
"""Gesetzter Paketverlust auf dem EMPFANGSWEG der echten Leitung.

**Das Werkzeug, das dem Labor bis zum 2026-07-31 gefehlt hat.** Bis dahin wurde
gestoert, indem parallel Dateien heruntergeladen wurden — die Leitung war dann
gesaettigt, aber wie stark, entschied die Gegenstelle und die Tageszeit. Drei
Befunde dieses Tages sind daran gescheitert: Vergleiche zwischen Laeufen mit
0,14 und 0,33 Prozent Verlust tragen keine Aussage darueber, welche Einstellung
besser ist.

Hier wird der Verlust GESETZT und nachgewiesen: `netem` verwirft eine
eingestellte Rate, und `tc -s` sagt hinterher, wieviele Pakete es wirklich
waren. Damit sind Laeufe untereinander vergleichbar.

**Warum eine Umleitung noetig ist.** `tc` kann nur ausgehenden Verkehr formen.
Gestoert werden soll aber der Empfangsweg — das, was vom Labor-Server kommt.
Der uebliche Weg dafuer ist eine ifb-Schnittstelle: der eingehende Verkehr wird
dorthin gespiegelt, und was auf ifb ausgeht, laesst sich formen.

**Getroffen wird nur UDP von der Gegenstelle.** Nicht der ganze Rechner, nicht
einmal die ganze Gegenstelle: die ssh-Verbindung zum Server (TCP) bleibt
unberuehrt, sonst wuerde jeder Eingriff waehrend eines Laufs mitgestoert.

**Die Root-qdisc des Interfaces wird NICHT angefasst** (hier `fq_codel`). Die
Umleitung haengt an `parent ffff:` — das ist eine eigene Anbindung neben der
Root-qdisc, kein Ersatz fuer sie.

## Der gesetzte Verlust ist im Mitschnitt NICHT als Luecke sichtbar

**Wer das nicht weiss, haelt eine wirksame Stoerung fuer eine wirkungslose.**
`tcpdump` haengt im Kernel an den AF_PACKET-Taps, und die kommen in
`__netif_receive_skb_core` VOR dem tc-ingress-Hook. Der Mitschnitt sieht das
Paket also noch, das netem einen Schritt spaeter wegwirft.

Beim ersten Prueflauf (2026-07-31, 2 Prozent gesetzt) sah das so aus:

    netem:      66396 Pakete gesehen, 1363 verworfen  = 2,053 Prozent
    Mitschnitt: 0 Luecken erkannt                     = 0,000 Prozent
    Mitschnitt: 1109 von 54069 Paketen nachgefordert  = 2,051 Prozent

Der Verlust ist also da und exakt getroffen — er zeigt sich nur an der
REAKTION statt am Loch. Fuer die Auswertung heisst das:

* `luecken_erkannt` (nack-wirkung) misst weiterhin den Verlust der ECHTEN
  Leitung, VOR dieser Teststrecke. Bei einem sauberen Lauf steht dort 0.
* `pakete_mit_kopien` (kopien.py) misst den GESETZTEN Verlust — jedes von
  netem verworfene Paket fordert der Player nach, und die Antwort erscheint im
  Mitschnitt als Kopie.
* `fenster.py` taugt unter gesetztem Verlust nicht: es unterscheidet
  Erstzustellung und Kopie am Mitschnitt, und die Erstzustellung ist dort
  vorhanden, obwohl sie den Player nie erreicht hat.
* Was der Player wirklich bekam, sagen nur seine eigenen Zahlen (Bildausfaelle,
  FEC-Reparaturen) und die netem-Bilanz beim Abraeumen.

    sudo -v
    ./verluststrecke.py --an 1.0                 # 1 Prozent, unabhaengig
    ./verluststrecke.py --an 1.0 --buendel       # in Buendeln (Gilbert-Elliott)
    ./verluststrecke.py --status
    ./verluststrecke.py --aus                    # raeumt ab und meldet die Bilanz

**Notaus, falls etwas haengen bleibt** (die Verbindung zum Server ist dann
gestoert, sonst nichts):

    sudo tc qdisc del dev enp39s0 ingress
    sudo tc qdisc del dev ifb0 root
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys

VORGABE_ZIEL = "77.42.71.166"
IFB = "ifb0"


def tc(*args: str, pruefen: bool = True) -> str:
    """Ein tc-Aufruf als root. Gibt die Ausgabe zurueck."""
    r = subprocess.run(["sudo", "tc", *args], capture_output=True, text=True)
    if pruefen and r.returncode != 0:
        raise SystemExit(f"tc {' '.join(args)} scheiterte:\n{r.stderr.strip()}")
    return r.stdout


def geraet_fuer(ziel: str) -> str:
    """Ueber welches Interface die Gegenstelle erreicht wird."""
    ausgabe = subprocess.run(["ip", "route", "get", ziel],
                             capture_output=True, text=True).stdout
    if (m := re.search(r" dev (\S+)", ausgabe)) is None:
        raise SystemExit(f"kein Weg zu {ziel} gefunden")
    return m.group(1)


def verworfen_gesamt() -> tuple[int, int]:
    """(gesehene Pakete, verworfene Pakete) der netem-Warteschlange auf ifb."""
    ausgabe = tc("-s", "qdisc", "show", "dev", IFB, pruefen=False)
    if "netem" not in ausgabe:
        return (0, 0)
    pak = re.search(r"Sent \d+ bytes (\d+) pkt", ausgabe)
    drop = re.search(r"dropped (\d+)", ausgabe)
    return (int(pak.group(1)) if pak else 0, int(drop.group(1)) if drop else 0)


def an(prozent: float, ziel: str, buendel: bool) -> None:
    """Verlust aufschalten. Raeumt einen alten Stand vorher ab."""
    dev = geraet_fuer(ziel)
    aus(ziel, still=True)

    subprocess.run(["sudo", "modprobe", "ifb"], check=False)
    subprocess.run(["sudo", "ip", "link", "add", IFB, "type", "ifb"],
                   capture_output=True)          # existiert evtl. schon
    subprocess.run(["sudo", "ip", "link", "set", IFB, "up"], check=True)

    tc("qdisc", "add", "dev", dev, "ingress")
    # Nur UDP von der Gegenstelle umleiten. `match ip protocol 17 0xff` haelt
    # die ssh-Sitzung (TCP) heraus — ohne das stoert man sich beim Messen
    # selbst die Fernsteuerung des Servers.
    tc("filter", "add", "dev", dev, "parent", "ffff:", "protocol", "ip",
       "prio", "1", "u32",
       "match", "ip", "src", f"{ziel}/32",
       "match", "ip", "protocol", "17", "0xff",
       "action", "mirred", "egress", "redirect", "dev", IFB)

    if buendel:
        # Gilbert-Elliott: der Verlust kommt in Buendeln statt gleichverteilt.
        # p = Uebergang gut->schlecht, r = zurueck. Mit r=50 sind die Buendel
        # im Mittel zwei Pakete lang — der Fall, an dem XOR-Paritaet scheitert
        # (sie schliesst je Gruppe nur EIN Loch) und fuer den Reed-Solomon
        # gebaut waere. Genau dieser Fall war bisher nie herstellbar.
        tc("qdisc", "add", "dev", IFB, "root", "netem",
           "loss", "gemodel", f"{prozent}%", "50%")
    else:
        tc("qdisc", "add", "dev", IFB, "root", "netem", "loss", f"{prozent}%")

    art = "in Buendeln" if buendel else "unabhaengig"
    print(f"Verlust {prozent} % {art} auf UDP von {ziel} (ueber {dev} -> {IFB})")


def aus(ziel: str, still: bool = False) -> tuple[int, int]:
    """Abraeumen. Gibt (gesehen, verworfen) zurueck — der Nachweis der Wirkung."""
    bilanz = verworfen_gesamt()
    dev = geraet_fuer(ziel)
    tc("qdisc", "del", "dev", dev, "ingress", pruefen=False)
    tc("qdisc", "del", "dev", IFB, "root", pruefen=False)
    if not still:
        gesehen, weg = bilanz
        if gesehen:
            print(f"abgeraeumt. netem sah {gesehen} Pakete und verwarf {weg}"
                  f" = {100 * weg / gesehen:.3f} %")
        else:
            print("abgeraeumt (netem hatte nichts gesehen)")
    return bilanz


def status(ziel: str) -> None:
    dev = geraet_fuer(ziel)
    ein = tc("qdisc", "show", "dev", dev, "ingress", pruefen=False).strip()
    nach = tc("-s", "qdisc", "show", "dev", IFB, pruefen=False).strip()
    print(f"Interface {dev}")
    print(f"  ingress: {ein or '(keine)'}")
    print(f"  {IFB}: {nach or '(nicht vorhanden)'}")
    gesehen, weg = verworfen_gesamt()
    if gesehen:
        print(f"  bisher: {weg} von {gesehen} verworfen"
              f" = {100 * weg / gesehen:.3f} %")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--an", type=float, metavar="PROZENT")
    ap.add_argument("--aus", action="store_true")
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--buendel", action="store_true",
                    help="Verlust in Buendeln statt gleichverteilt")
    ap.add_argument("--ziel", default=VORGABE_ZIEL)
    args = ap.parse_args()

    if args.an is not None:
        an(args.an, args.ziel, args.buendel)
    elif args.aus:
        aus(args.ziel)
    elif args.status:
        status(args.ziel)
    else:
        ap.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
