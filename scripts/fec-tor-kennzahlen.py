#!/usr/bin/env python3
"""Kennzahlen der verlustgeregelten Paritaets-Steuerung ("FEC-Tor") aus dem
MediaMTX-Log der Produktion einsammeln.

Wozu
====
Der MediaMTX-Fork schreibt beim Schliessen JEDER WHEP-Sitzung eine Bilanz des
Paritaets-Tors (Patch ``0004-flexfec-adaptiv.patch``, ``PeerConnection.Close``)::

    2026/08/06 18:29:14 INF [WebRTC] [session 9a28cbc6] Pulse FEC-Tor: \
33 Verluste gemeldet, 310 Paritaetspakete gesendet, 728 unterdrueckt

Diese eine Zeile allein ist noch keine Messung. "310 gesendet" sagt nichts,
solange nicht dabeisteht, ueber welche Dauer, in welchem Codec und gegen
wieviel Verlust. Das Skript fuehrt deshalb je Sitzung die vier Zeilen zusammen,
die MediaMTX ueber dieselbe ``[session <id>]`` verteilt:

===================== ==================================================
``created by``        Beginn und Gegenstelle
``is reading from``   Pfad (Kanal + sendender Nutzer) und Spuren/Codecs
``Pulse FEC-Tor``     die drei Zaehler
``closed:``           Ende und Grund
===================== ==================================================

Die ``session``-Kennung ist zugleich der Schluessel, mit dem sich Server- und
Zuschauersicht spaeter verbinden lassen.

Was die drei Zahlen bedeuten (Quelle: Patch 0004)
=================================================
``gemeldet``
    Verluste, die per NACK hereinkamen — **bereits entdoppelt**, also
    *verschiedene* Sequenznummern. Der rohe Zaehler ist um den Faktor 9
    aufgeblaeht, weil Chromium dieselbe Luecke 6-8x anfordert; wer roh zaehlt,
    misst die Hartnaeckigkeit des Empfaengers statt den Verlust der Leitung.
``gesendet``
    Paritaetspakete, die das Tor durchgelassen hat (= bezahlte Bandbreite).
``unterdrueckt``
    Paritaetspakete, die das Tor verworfen hat (= gesparte Bandbreite).

Daraus der **Toranteil** ``unterdrueckt / (gesendet + unterdrueckt)``: der
Anteil der Paritaet, den die Regelung eingespart hat. 100 Prozent heisst
"Leitung war sauber, nichts bezahlt", 0 Prozent heisst "durchgehend Verlust,
voller Aufschlag" — beides sind gute Werte, wenn sie zur Lage passen.

Benutzung
=========
::

    scripts/fec-tor-kennzahlen.py                    # letzte 48 h von Prod
    scripts/fec-tor-kennzahlen.py --seit 7d
    scripts/fec-tor-kennzahlen.py --nur-aktiv        # ohne die stillen Sitzungen
    scripts/fec-tor-kennzahlen.py --json > kennzahlen.json
    scripts/fec-tor-kennzahlen.py --datei mitschnitt.log   # ohne SSH, aus Datei

Der Zugriff ist **nur lesend** (``docker logs``). Auf der Produktion wird
nichts angefasst.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime

HOST_VORGABE = os.environ.get("PULSE_PROD_HOST", "michael@159.195.150.54")
CONTAINER_VORGABE = os.environ.get("PULSE_MEDIAMTX_CONTAINER", "pulse_mediamtx")

# MediaMTX-Zeitstempel: "2026/08/04 19:01:23". Die Sitzungskennung ist die
# Klammer dahinter; alles Weitere unterscheidet die vier Zeilenarten.
ZEILE = re.compile(
    r"^(?P<zeit>\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}) "
    r"\w+ \[WebRTC\] \[session (?P<sid>[0-9a-f]+)\] (?P<rest>.*)$"
)
FEC_TOR = re.compile(
    r"Pulse FEC-Tor: (?P<gemeldet>\d+) Verluste gemeldet, "
    r"(?P<gesendet>\d+) Paritaetspakete gesendet, (?P<unterdrueckt>\d+) unterdrueckt"
)
LIEST_VON = re.compile(r"is reading from path '(?P<pfad>[^']+)'(?:, \d+ tracks \((?P<codecs>[^)]*)\))?")
GESCHLOSSEN = re.compile(r"^closed: (?P<grund>.*)$")

ZEITFORMAT = "%Y/%m/%d %H:%M:%S"


@dataclass
class Sitzung:
    """Alles, was das Log ueber eine WHEP-Sitzung hergibt."""

    sid: str
    beginn: datetime | None = None
    ende: datetime | None = None
    fec_zeit: datetime | None = None
    pfad: str | None = None
    codecs: str | None = None
    grund: str | None = None
    gemeldet: int | None = None
    gesendet: int | None = None
    unterdrueckt: int | None = None
    # Mehrfach gesehene FEC-Zeilen derselben Sitzung waeren ein Hinweis auf ein
    # Missverstaendnis unsererseits (Close laeuft genau einmal) — wir zaehlen
    # sie mit, statt sie stillschweigend zu ueberschreiben.
    fec_zeilen: int = 0

    @property
    def paritaet_gesamt(self) -> int | None:
        if self.gesendet is None or self.unterdrueckt is None:
            return None
        return self.gesendet + self.unterdrueckt

    @property
    def hat_paritaet(self) -> bool:
        """Ob ueberhaupt ein Paritaetspaket entstand. Trennt die Sitzungen, in
        denen das Tor etwas zu regeln hatte, von denen, in denen gar kein
        Schutz lief — der Unterschied entscheidet weiter unten darueber, ob
        eine Sitzung als Beleg fuer die Regelung zaehlen darf."""
        return bool(self.paritaet_gesamt)

    @property
    def hat_verlust(self) -> bool:
        """Ob NACKs hereinkamen. Bewusst getrennt von ``hat_paritaet``: eine
        Sitzung kann sehr wohl Verlust melden und trotzdem ohne ein einziges
        Paritaetspaket geblieben sein."""
        return bool(self.gemeldet)

    @property
    def toranteil(self) -> float | None:
        """Anteil unterdrueckter Paritaet. ``None``, wenn es nichts zu regeln
        gab — eine Sitzung ohne ein einziges Paritaetspaket hat keinen
        Toranteil von 0 Prozent, sie hat gar keinen. Eine 0 an dieser Stelle
        haette sich in jeder Mittelung als "Regelung wirkungslos" gelesen."""
        # Beide Zaehler direkt pruefen statt ueber paritaet_gesamt zu gehen:
        # so sieht auch die Typpruefung, dass unterdrueckt hier eine Zahl ist,
        # und es braucht kein type-ignore, das echte Fehler mitverdecken wuerde.
        if self.gesendet is None or self.unterdrueckt is None:
            return None
        gesamt = self.gesendet + self.unterdrueckt
        if not gesamt:
            return None
        return self.unterdrueckt / gesamt

    @property
    def dauer_s(self) -> float | None:
        if self.beginn is None or self.ende is None:
            return None
        return (self.ende - self.beginn).total_seconds()


@dataclass
class Ernte:
    """Ergebnis des Parsens — samt der Zahlen, die die Selbstkontrolle braucht."""

    sitzungen: dict[str, Sitzung] = field(default_factory=dict)
    zeilen_gesamt: int = 0
    zeilen_webrtc: int = 0
    zeilen_fec: int = 0


def parse(text: str) -> Ernte:
    ernte = Ernte()
    for roh in text.splitlines():
        ernte.zeilen_gesamt += 1
        treffer = ZEILE.match(roh.strip())
        if not treffer:
            continue
        ernte.zeilen_webrtc += 1

        sid = treffer["sid"]
        zeit = datetime.strptime(treffer["zeit"], ZEITFORMAT)
        rest = treffer["rest"]
        s = ernte.sitzungen.setdefault(sid, Sitzung(sid=sid))

        if rest.startswith("created by"):
            s.beginn = zeit
            continue

        if (m := LIEST_VON.search(rest)) is not None:
            s.pfad = m["pfad"]
            s.codecs = m["codecs"]
            continue

        if (m := GESCHLOSSEN.match(rest)) is not None:
            s.ende = zeit
            s.grund = m["grund"]
            continue

        if (m := FEC_TOR.search(rest)) is not None:
            ernte.zeilen_fec += 1
            s.fec_zeilen += 1
            s.fec_zeit = zeit
            s.gemeldet = int(m["gemeldet"])
            s.gesendet = int(m["gesendet"])
            s.unterdrueckt = int(m["unterdrueckt"])

    return ernte


def selbstkontrolle(ernte: Ernte) -> list[str]:
    """Prueft das Werkzeug am eigenen Material, bevor es Zahlen behauptet.

    Der Anlass ist eine reale Fehldiagnose: ein Prueflauf meldete null Treffer,
    weil ``strings`` auf dem Server gar nicht installiert war — die Pipeline
    lieferte nichts, und "null Treffer" las sich wie ein Befund. Erst eine
    Gegenprobe mit einem garantiert vorhandenen Muster deckte es auf.

    Deshalb wird hier stufenweise geprueft: kam ueberhaupt Text an, standen
    darin WebRTC-Sitzungszeilen, und erst dann darf "keine FEC-Zeile" als
    Aussage ueber die Anlage gelten statt als Fehler des Werkzeugs.
    """
    warnungen: list[str] = []

    if ernte.zeilen_gesamt == 0:
        warnungen.append(
            "KEINE EINZIGE LOGZEILE angekommen. Das ist kein Messergebnis, sondern "
            "eine kaputte Pipeline (falscher Container, SSH stumm, Zeitfenster leer). "
            "Gegenprobe von Hand: docker logs --since 1h <container> | wc -l"
        )
        return warnungen

    if ernte.zeilen_webrtc == 0:
        warnungen.append(
            f"{ernte.zeilen_gesamt} Logzeilen gelesen, aber KEINE davon passt auf das "
            "WebRTC-Sitzungsmuster. Entweder ist es nicht das MediaMTX-Log, oder das "
            "Zeilenformat hat sich geaendert — dann ist die Regel ZEILE anzupassen, "
            "nicht das Ergebnis zu glauben."
        )
        return warnungen

    if ernte.zeilen_fec == 0:
        warnungen.append(
            f"{ernte.zeilen_webrtc} Sitzungszeilen gefunden, aber keine einzige "
            "FEC-Tor-Bilanz. Das Werkzeug arbeitet (sonst waere schon die vorige "
            "Stufe angeschlagen) — es laeuft also ein MediaMTX OHNE Patch 0004 oder "
            "mit abgeschalteter adaptiver Paritaet (PULSE_FLEXFEC/PULSE_FEC_ADAPTIV)."
        )

    mehrfach = [s.sid for s in ernte.sitzungen.values() if s.fec_zeilen > 1]
    if mehrfach:
        warnungen.append(
            f"{len(mehrfach)} Sitzung(en) mit MEHR ALS EINER FEC-Tor-Zeile "
            f"({', '.join(mehrfach[:5])}). Close laeuft je Sitzung genau einmal — "
            "entweder wird eine Sitzungskennung wiederverwendet oder das Zeitfenster "
            "ueberlappt einen Neustart. Nur die letzte Zeile ist hier gezaehlt."
        )

    ohne_beginn = sum(1 for s in ernte.sitzungen.values() if s.beginn is None)
    if ohne_beginn:
        warnungen.append(
            f"{ohne_beginn} Sitzung(en) ohne 'created by' — sie begannen vor dem "
            "Zeitfenster. Ihre Dauer bleibt leer; die Zaehler stimmen trotzdem."
        )

    return warnungen


def hole_log(host: str, container: str, seit: str) -> str:
    """``docker logs`` ueber SSH. Rein lesend."""
    befehl = f"docker logs --since {seit} {container} 2>&1"
    fertig = subprocess.run(
        ["ssh", "-o", "BatchMode=yes", host, befehl],
        capture_output=True,
        text=True,
        check=False,
    )
    if fertig.returncode != 0:
        raise SystemExit(
            f"ssh/docker logs fehlgeschlagen (rc={fertig.returncode}):\n{fertig.stderr.strip()}"
        )
    return fertig.stdout


def als_zeile(s: Sitzung) -> str:
    anteil = s.toranteil
    dauer = s.dauer_s
    return (
        f"{s.beginn.strftime('%m-%d %H:%M') if s.beginn else '  ?  ?  '}  "
        f"{s.sid:<10} "
        f"{(f'{dauer:6.0f}s' if dauer is not None else '     ?'):>7}  "
        f"{s.gemeldet if s.gemeldet is not None else '?':>8}  "
        f"{s.gesendet if s.gesendet is not None else '?':>9}  "
        f"{s.unterdrueckt if s.unterdrueckt is not None else '?':>12}  "
        f"{(f'{anteil * 100:5.1f}%' if anteil is not None else '   n/a'):>7}  "
        f"{(s.codecs or '-'):<12} "
        f"{s.grund or '-'}"
    )


def bilanz(sitzungen: list[Sitzung]) -> list[str]:
    """Gesamtbild. Bewusst NICHT der Mittelwert der Toranteile, sondern der
    Toranteil der Summen: eine 12-Sekunden-Sitzung mit zwei Paritaetspaketen
    darf nicht so schwer wiegen wie eine halbe Stunde Vollbetrieb."""
    mit_fec = [s for s in sitzungen if s.gesendet is not None]
    if not mit_fec:
        return ["Keine Sitzung mit FEC-Tor-Bilanz im Zeitfenster."]

    gesendet = sum(s.gesendet or 0 for s in mit_fec)
    unterdrueckt = sum(s.unterdrueckt or 0 for s in mit_fec)
    gemeldet = sum(s.gemeldet or 0 for s in mit_fec)
    gesamt = gesendet + unterdrueckt
    dauern = [s.dauer_s for s in mit_fec if s.dauer_s is not None]
    sekunden = sum(dauern)
    aktive = [s for s in mit_fec if s.hat_paritaet]
    mit_verlust = [s for s in mit_fec if s.hat_verlust]

    zeilen = [
        f"Sitzungen mit Bilanz:      {len(mit_fec)}"
        f"   davon mit Paritaet: {len(aktive)}   davon mit Verlust: {len(mit_verlust)}",
        f"Gemessene Sitzungsdauer:   {sekunden / 60:.1f} min ueber {len(dauern)} Sitzungen"
        + (
            f"   ({len(mit_fec) - len(dauern)} ohne Dauer, s. Hinweise)"
            if len(dauern) != len(mit_fec)
            else ""
        ),
        f"Verluste gemeldet:         {gemeldet}"
        + (f"   = {gemeldet / (sekunden / 60):.1f} je Minute" if sekunden else ""),
        f"Paritaet gesendet:         {gesendet}",
        f"Paritaet unterdrueckt:     {unterdrueckt}",
    ]
    if gesamt:
        zeilen.append(
            f"Toranteil (Summen):        {unterdrueckt / gesamt * 100:.1f}% eingespart"
            f"   ({unterdrueckt} von {gesamt} Paritaetspaketen)"
        )
    else:
        zeilen.append(
            "Toranteil:                 n/a — es wurde in keiner Sitzung auch nur ein "
            "Paritaetspaket erzeugt. Das ist eine Aussage ueber die Anlage, nicht ueber "
            "die Regelung."
        )

    # Die Klasse, die in jeder Gesamtsumme untergeht und trotzdem die
    # wichtigste ist: Sitzungen, die sehr wohl Verlust melden, in denen aber
    # NIE ein Paritaetspaket entstand. Fuer sie hat das Tor nichts geregelt —
    # sie sind kein Beleg fuer eine sparsame Regelung, sondern dafuer, dass
    # dort gar kein Schutz lief (FlexFEC nicht ausgehandelt, andere Spurart,
    # oder die Gegenstelle kann es nicht). Wer sie mitmittelt, schreibt der
    # Regelung eine Ersparnis gut, die sie nie erbracht hat.
    verlust_ohne_paritaet = [s for s in mit_verlust if not s.hat_paritaet]
    if verlust_ohne_paritaet:
        anteil_gemeldet = sum(s.gemeldet or 0 for s in verlust_ohne_paritaet)
        zeilen.append(
            f"\nDAVON UNGESCHUETZT:        {len(verlust_ohne_paritaet)} Sitzung(en) melden "
            f"Verlust ({anteil_gemeldet} Meldungen, "
            f"{anteil_gemeldet / gemeldet * 100:.0f}% aller Meldungen), erzeugten aber "
            "KEIN Paritaetspaket.\n"
            "                           Diese Sitzungen sagen nichts ueber die Regelung "
            "aus — dort lief kein Schutz.\n"
            "                           Nachgehen mit --pfad, dann in denselben "
            "Sitzungszeilen nach der ausgehandelten\n"
            "                           Spurliste sehen ('is reading from ... tracks')."
        )
        rest_gemeldet = gemeldet - anteil_gemeldet
        rest_dauer = sum(s.dauer_s or 0 for s in aktive)
        if rest_dauer:
            zeilen.append(
                f"Verlust NUR in Sitzungen mit Paritaet: {rest_gemeldet} Meldungen ueber "
                f"{rest_dauer / 60:.1f} min = {rest_gemeldet / (rest_dauer / 60):.1f} je Minute"
            )
    return zeilen


def main() -> int:
    p = argparse.ArgumentParser(
        description="FEC-Tor-Kennzahlen je WHEP-Sitzung aus dem MediaMTX-Log der Produktion.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--seit", default="48h", help="Zeitfenster fuer docker logs (Vorgabe: 48h)")
    p.add_argument("--host", default=HOST_VORGABE, help=f"SSH-Ziel (Vorgabe: {HOST_VORGABE})")
    p.add_argument("--container", default=CONTAINER_VORGABE, help=f"Vorgabe: {CONTAINER_VORGABE}")
    p.add_argument("--datei", help="Statt SSH: eine lokal liegende Logdatei auswerten ('-' = stdin)")
    p.add_argument(
        "--nur-aktiv",
        action="store_true",
        help="Nur Sitzungen zeigen, in denen ueberhaupt Paritaet oder Verlust auftrat",
    )
    p.add_argument("--pfad", help="Nur Sitzungen, deren MediaMTX-Pfad diesen Text enthaelt")
    p.add_argument("--json", action="store_true", help="Maschinenlesbar statt Tabelle")
    args = p.parse_args()

    if args.datei == "-":
        text = sys.stdin.read()
        quelle = "Datei -"
    elif args.datei:
        # errors="replace": ein Log darf an einer kaputten Stelle nicht die
        # ganze Auswertung abbrechen lassen; die betroffene Zeile faellt dann
        # hoechstens aus dem Muster und wird still uebergangen.
        with open(args.datei, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
        quelle = f"Datei {args.datei}"
    else:
        text = hole_log(args.host, args.container, args.seit)
        quelle = f"{args.host}:{args.container}, --since {args.seit}"

    ernte = parse(text)
    warnungen = selbstkontrolle(ernte)

    # Nur Sitzungen mit Bilanz sind auswertbar; die uebrigen (z.B. laufende)
    # wuerden die Tabelle mit Fragezeichen fuellen, ohne etwas beizutragen.
    sitzungen = [s for s in ernte.sitzungen.values() if s.gesendet is not None]
    if args.pfad:
        sitzungen = [s for s in sitzungen if s.pfad and args.pfad in s.pfad]
    if args.nur_aktiv:
        sitzungen = [s for s in sitzungen if s.hat_paritaet or s.hat_verlust]
    sitzungen.sort(key=lambda s: s.beginn or s.fec_zeit or datetime.min)

    if args.json:
        json.dump(
            {
                "quelle": quelle,
                "zeilen_gelesen": ernte.zeilen_gesamt,
                "zeilen_webrtc": ernte.zeilen_webrtc,
                "zeilen_fec": ernte.zeilen_fec,
                "warnungen": warnungen,
                "sitzungen": [
                    {
                        "sitzung": s.sid,
                        "beginn": s.beginn.isoformat() if s.beginn else None,
                        "ende": s.ende.isoformat() if s.ende else None,
                        "dauer_s": s.dauer_s,
                        "pfad": s.pfad,
                        "codecs": s.codecs,
                        "grund": s.grund,
                        "gemeldet": s.gemeldet,
                        "gesendet": s.gesendet,
                        "unterdrueckt": s.unterdrueckt,
                        "toranteil": s.toranteil,
                    }
                    for s in sitzungen
                ],
            },
            sys.stdout,
            indent=2,
            ensure_ascii=False,
        )
        sys.stdout.write("\n")
        return 0

    print(f"Quelle: {quelle}")
    print(
        f"Gelesen: {ernte.zeilen_gesamt} Zeilen, davon {ernte.zeilen_webrtc} WebRTC-Sitzungszeilen "
        f"und {ernte.zeilen_fec} FEC-Tor-Bilanzen."
    )
    for w in warnungen:
        print(f"\n  HINWEIS: {w}")
    print()
    print(
        "Beginn         Sitzung        Dauer  gemeldet   gesendet  unterdrueckt  "
        "Toranteil  Codecs       Ende"
    )
    print("-" * 118)
    for s in sitzungen:
        print(als_zeile(s))
    print("-" * 118)
    print(f"{len(sitzungen)} Sitzung(en) angezeigt.\n")
    for z in bilanz(sitzungen):
        print(z)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
