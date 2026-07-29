#!/usr/bin/env python3
"""Liefert MediaMTX verlorene Pakete tatsaechlich nach — oder sagt es das nur zu?

Stufe 2 der NACK-Pruefung. Stufe 1 (die SDP-Zusage im Verbindungsaufbau) sagt
NICHTS ueber die Wirkung: der Server kann `nack` zusagen und die
Nachforderungen trotzdem wegwerfen, genau wie er es vor dem Fork-Patch mit den
PLIs getan hat.

**Die Kontrollzahl ist deshalb nicht die Zusage, sondern gezaehlte Pakete:**

* **NACKs vom Player zum Server** (RTCP, Typ 205/FMT 1) — fordert unsere Seite
  ueberhaupt an? Ohne die ist alles Weitere sinnlos.
* **wiederholte RTP-Sequenznummern vom Server zum Player** — liefert die
  Gegenseite nach? Das ist der Beweis, nach dem gesucht wird.

Beides ist trotz SRTP/SRTCP lesbar: verschluesselt wird die Nutzlast, die
Kopfzeilen bleiben klar (RTP: Sequenznummer und SSRC; RTCP: Typ und Format).

Wrap-Schutz: 16-Bit-Sequenznummern laufen bei ~2000 Paketen/s nach gut einer
halben Minute ueber. Eine Wiederholung zaehlt deshalb nur, wenn dieselbe Nummer
INNERHALB eines Fensters erneut auftaucht — sonst waere jeder Ueberlauf ein
falscher Treffer.

    sudo -v && ./nack-wirkung.py --profil verlust_stark --secs 20
"""

from __future__ import annotations

import argparse
import json
import struct
import subprocess
import sys
import time
from collections import deque
from pathlib import Path

HERE = Path(__file__).parent
MEDIA_PORT = 8189
# So viele zurueckliegende Sequenznummern gelten als "noch aktuell". Bei rund
# 2000 Paketen/s sind 4000 etwa zwei Sekunden — weit mehr als jede
# Nachlieferung braucht, und weit weniger als ein 16-Bit-Ueberlauf.
FENSTER = 4000


def ist_rtp_oder_rtcp(nutzlast: bytes) -> bool:
    """Trennt RTP/RTCP von STUN und DTLS, die denselben Port teilen (RFC 7983).

    **Diese Pruefung fehlte im ersten Anlauf und hat das Ergebnis wertlos
    gemacht.** Ohne sie wurden 2663 STUN-Pakete als RTP gelesen: ihr drittes
    und viertes Byte landeten als "Sequenznummer" in der Auswertung, ihr
    neuntes bis zwoelftes als "SSRC". Ergebnis waren ueber tausend SSRCs (ein
    WHEP-Strom hat zwei) und 505 vermeintliche Nachlieferungen, die keine
    waren. Das Unterscheidungsmerkmal sind die oberen zwei Bit: RTP und RTCP
    tragen dort die Version 2, STUN eine 0.
    """
    return len(nutzlast) >= 12 and (nutzlast[0] >> 6) == 2


def rtcp_typ(nutzlast: bytes) -> tuple[int, int] | None:
    """(Typ, Format) eines RTCP-Pakets, oder None wenn es RTP ist.

    Unterschieden wird am Payload-Type-Feld: liegt es im Bereich 64-95, ist es
    RTCP (bei rtcp-mux teilen sich beide denselben Port). Setzt voraus, dass
    `ist_rtp_oder_rtcp` schon zugestimmt hat.
    """
    pt = nutzlast[1]
    return (pt, nutzlast[0] & 0x1F) if 64 <= (pt & 0x7F) <= 95 else None


def auswerten(pcap: Path) -> dict:
    roh = pcap.read_bytes()
    magic = struct.unpack("<I", roh[:4])[0]
    if magic not in (0xA1B2C3D4, 0xA1B23C4D):
        raise SystemExit(f"unbekanntes pcap-Magic {magic:08x}")

    pos, n = 24, len(roh)
    rtp_hin = 0            # RTP-Pakete Server -> Player
    nacks = 0              # RTCP-NACKs Player -> Server
    plis = 0               # RTCP-PLIs Player -> Server
    rtcp_sonst = 0
    wiederholt: list[tuple[int, int]] = []   # (ssrc, seq)
    letzte: dict[int, deque] = {}
    gesehen: dict[int, set] = {}

    while pos + 16 <= n:
        _sec, _sub, incl, _orig = struct.unpack("<IIII", roh[pos:pos + 16])
        pos += 16
        pkt = roh[pos:pos + incl]
        pos += incl
        if len(pkt) < 42:
            continue
        if struct.unpack(">H", pkt[12:14])[0] != 0x0800:  # nur IPv4
            continue
        ihl = (pkt[14] & 0x0F) * 4
        if pkt[14 + 9] != 17:  # UDP
            continue
        udp = 14 + ihl
        sport, dport = struct.unpack(">HH", pkt[udp:udp + 4])
        nutz = pkt[udp + 8:]

        if not ist_rtp_oder_rtcp(nutz):    # STUN/DTLS aussortieren
            continue

        if dport == MEDIA_PORT:            # Player -> Server (Rueckkanal)
            if (t := rtcp_typ(nutz)) is not None:
                pt, fmt = t
                if pt == 205 and fmt == 1:
                    nacks += 1
                elif pt == 206 and fmt == 1:
                    plis += 1
                else:
                    rtcp_sonst += 1
            continue

        if sport != MEDIA_PORT:            # nicht unser Medienweg
            continue
        if rtcp_typ(nutz) is not None:     # RTCP vom Server — hier uninteressant
            continue

        rtp_hin += 1
        seq = struct.unpack(">H", nutz[2:4])[0]
        ssrc = struct.unpack(">I", nutz[8:12])[0]
        fenster = letzte.setdefault(ssrc, deque())
        menge = gesehen.setdefault(ssrc, set())
        if seq in menge:
            wiederholt.append((ssrc, seq))
        else:
            menge.add(seq)
            fenster.append(seq)
            if len(fenster) > FENSTER:
                menge.discard(fenster.popleft())

    return {
        "rtp_pakete_server_zu_player": rtp_hin,
        "nacks_player_zu_server": nacks,
        "plis_player_zu_server": plis,
        "rtcp_sonstiges_player_zu_server": rtcp_sonst,
        "wiederholte_sequenznummern": len(wiederholt),
        "beispiele": [{"ssrc": s, "seq": q} for s, q in wiederholt[:5]],
        "anzahl_ssrcs": len(letzte),
        "ssrcs": sorted(letzte)[:8],
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profil", default="verlust_stark")
    ap.add_argument("--secs", type=float, default=20.0)
    ap.add_argument("--label", default="nack-stufe2")
    args = ap.parse_args()

    pcap = HERE / f"{args.label}.pcap"
    dump = subprocess.Popen(
        ["sudo", "tcpdump", "-i", "lo", "-n", "-s", "120", "-w", str(pcap),
         f"udp port {MEDIA_PORT}"],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
    )
    time.sleep(2.0)  # tcpdump muss stehen, bevor der Lauf beginnt
    if dump.poll() is not None:
        print(f"tcpdump startete nicht:\n{dump.stderr.read()}", file=sys.stderr)
        return 1

    lauf_ok = False
    try:
        # `--nur-empfang` ist PFLICHT, nicht Geschmackssache: ohne den Schalter
        # legt netz-harness die Stoerung an die Wurzel von `lo` und trifft damit
        # auch den RTMPS-Push des Senders. Am 2026-07-29 genau so passiert —
        # der Sender kam nie in Fahrt, der Player lieferte eine einzige
        # Statistikzeile, und der Mitschnitt zeigte 2727 statt 56651 Pakete.
        # Gemessen werden soll der Empfangsweg, sonst ist offen, wer schwaechelt.
        lauf = subprocess.run(
            [sys.executable, str(HERE / "netz-harness.py"),
             "--profil", args.profil, "--secs", str(args.secs), "--nur-empfang"],
            capture_output=True, text=True, timeout=args.secs + 300,
        )
        print(lauf.stdout[-1500:])
        # Lebendkontrolle aus UNABHAENGIGER Quelle: netz-harness meldet einen
        # Lauf ohne Messwerte als "kein Ergebnis". Ohne diese Pruefung faellte
        # das Werkzeug am 2026-07-29 ein Urteil ueber einen Lauf, in dem der
        # Player nie ein Bild dekodiert hat.
        lauf_ok = lauf.returncode == 0 and "kein Ergebnis" not in lauf.stdout
        if not lauf_ok:
            print(f"Lauf lieferte keine Messwerte:\n{lauf.stderr[-800:]}", file=sys.stderr)
    finally:
        subprocess.run(["sudo", "pkill", "-INT", "-f", f"tcpdump.*{pcap.name}"], check=False)
        try:
            dump.wait(timeout=10)
        except subprocess.TimeoutExpired:
            dump.kill()

    if not pcap.exists() or pcap.stat().st_size < 100:
        print("kein Mitschnitt entstanden", file=sys.stderr)
        return 1

    ergebnis = auswerten(pcap)
    print(f"\n=== Mitschnitt {pcap.name} ({pcap.stat().st_size // 1024} KB) ===")
    for k, v in ergebnis.items():
        print(f"  {k:36s} {v}")

    nacks, wdh = ergebnis["nacks_player_zu_server"], ergebnis["wiederholte_sequenznummern"]
    print()
    if ergebnis["anzahl_ssrcs"] > 4:
        print(f"KEIN URTEIL: {ergebnis['anzahl_ssrcs']} SSRCs im Mitschnitt, ein WHEP-Strom")
        print("             hat zwei. Die Auswertung liest Fremdverkehr als RTP —")
        print("             erst den Parser reparieren, dann die Zahlen ansehen.")
    elif not lauf_ok:
        print("KEIN URTEIL: der Prueflauf lieferte keine Messwerte. Es floss zwar")
        print("             Verkehr, aber ohne laufende Wiedergabe sagen die Zahlen")
        print("             nichts ueber den Normalbetrieb. Lauf erst zum Laufen bringen.")
    elif nacks == 0:
        print("URTEIL: unser Player hat GAR NICHT nachgefordert — der Test sagt nichts")
        print("        ueber MediaMTX. Erst klaeren, warum keine NACKs entstehen.")
    elif wdh == 0:
        print(f"URTEIL: {nacks} Nachforderungen gestellt, NULL Wiederholungen zurueck —")
        print("        MediaMTX beantwortet NACKs nicht. Gleiche Lage wie vor dem")
        print("        PLI-Patch: der Rueckkanal wird zugesagt und weggeworfen.")
    else:
        print(f"URTEIL: {nacks} Nachforderungen, {wdh} wiederholte Pakete zurueck —")
        print("        MediaMTX liefert nach. Offen bleibt Stufe 3: kommen sie")
        print("        frueh genug, um vor der Anzeige eingesetzt zu werden?")
    (HERE / f"{args.label}.json").write_text(json.dumps(ergebnis, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
