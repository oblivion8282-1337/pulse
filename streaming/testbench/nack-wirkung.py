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


def auswerten(pcap: Path, server_ip: str | None = None) -> dict:
    """Zaehlt Nachforderungen und Nachlieferungen in einem Mitschnitt.

    Ohne `server_ip` wird die Richtung am Medienport erkannt (lokaler Aufbau,
    MediaMTX auf `lo`). Mit `server_ip` an der Gegenstelle — noetig, sobald es
    ueber die echte Leitung geht: der Testserver veroeffentlicht seinen
    WebRTC-Port nicht unter der lokalen Nummer, und ein Portfilter ginge dort
    ins Leere.
    """
    ziel = bytes(int(x) for x in server_ip.split(".")) if server_ip else None
    roh = pcap.read_bytes()
    magic = struct.unpack("<I", roh[:4])[0]
    if magic not in (0xA1B2C3D4, 0xA1B23C4D):
        raise SystemExit(f"unbekanntes pcap-Magic {magic:08x}")
    # Mikro- oder Nanosekunden-Aufloesung, am Magic erkennbar. Wird fuer den
    # ANKUNFTSABSTAND gebraucht (s. unten) — ohne den ist "liefert nach" nur
    # die halbe Antwort.
    teiler = 1e6 if magic == 0xA1B2C3D4 else 1e9

    pos, n = 24, len(roh)
    rtp_hin = 0            # RTP-Pakete Server -> Player
    nacks = 0              # RTCP-NACKs Player -> Server
    plis = 0               # RTCP-PLIs Player -> Server
    rtcp_sonst = 0
    wiederholt: list[tuple[int, int]] = []   # (ssrc, seq)
    letzte: dict[int, deque] = {}
    gesehen: dict[int, set] = {}
    # Wann die Luecke sichtbar wurde (= Ankunft des NACHFOLGERS der fehlenden
    # Nummer) und wann die Wiederholung eintraf. Die Differenz ist die Zahl,
    # an der sich alles entscheidet: der Jitter-Puffer haelt nur `jitter_ms`
    # (Vorgabe 20) auf, danach ist die Einheit weg. Eine Nachlieferung, die
    # spaeter kommt, ist zwar messbar, aber wirkungslos — und sieht in jeder
    # Zaehlstatistik aus wie eine gelungene.
    luecke_gesehen: dict[tuple[int, int], float] = {}
    verspaetung: list[float] = []
    # LEBENDKONTROLLE. Am 2026-07-29 wurde aus Mitschnitten gemessen, deren
    # Player nach zwei Sekunden abgestuerzt war — die NACKs deckten 2,3 von
    # 20 Sekunden ab, der Rest des Mitschnitts war MediaMTX, das ins Leere
    # sendet. Die Verspaetungswerte daraus waren wertlos, sahen aber aus wie
    # eine Messung. Deckt der NACK-Zeitraum nicht den groessten Teil des
    # Laufs ab, ist die Auswertung ungueltig.
    nack_zeiten: list[float] = []
    erste_zeit: float | None = None
    letzte_zeit: float | None = None

    while pos + 16 <= n:
        sec, sub, incl, _orig = struct.unpack("<IIII", roh[pos:pos + 16])
        zeit = sec + sub / teiler
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

        # Richtung: ueber die Gegenstellen-IP, sonst ueber den Medienport.
        if ziel is not None:
            zum_server = pkt[14 + 16:14 + 20] == ziel
            vom_server = pkt[14 + 12:14 + 16] == ziel
        else:
            zum_server = dport == MEDIA_PORT
            vom_server = sport == MEDIA_PORT
        if not (zum_server or vom_server):
            continue

        if erste_zeit is None:
            erste_zeit = zeit
        letzte_zeit = zeit

        if zum_server:                     # Player -> Server (Rueckkanal)
            if (t := rtcp_typ(nutz)) is not None:
                pt, fmt = t
                if pt == 205 and fmt == 1:
                    nacks += 1
                    nack_zeiten.append(zeit)
                elif pt == 206 and fmt == 1:
                    plis += 1
                else:
                    rtcp_sonst += 1
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
            if (start := luecke_gesehen.pop((ssrc, seq), None)) is not None:
                verspaetung.append((zeit - start) * 1000.0)
        else:
            # Sprung nach vorn = eine oder mehrere Nummern fehlen. Der
            # Zeitpunkt wird gemerkt, damit eine spaetere Wiederholung
            # dagegen gehalten werden kann.
            if fenster:
                zuletzt = fenster[-1]
                fehlend = (seq - zuletzt - 1) & 0xFFFF
                if fehlend < 100:
                    for versatz in range(1, fehlend + 1):
                        luecke_gesehen.setdefault((ssrc, (zuletzt + versatz) & 0xFFFF), zeit)
            menge.add(seq)
            fenster.append(seq)
            if len(fenster) > FENSTER:
                menge.discard(fenster.popleft())

    verspaetung.sort()
    dauer = (letzte_zeit - erste_zeit) if (erste_zeit and letzte_zeit) else 0.0
    nack_spanne = (nack_zeiten[-1] - nack_zeiten[0]) if len(nack_zeiten) > 1 else 0.0
    # Ein NACK-Zeitraum unter 60 % der Laufdauer heisst: der Player hat
    # irgendwann aufgehoert nachzufordern. Bei gleichmaessiger Stoerung ueber
    # den ganzen Lauf gibt es dafuer keinen guten Grund.
    lebend = dauer > 0 and nack_spanne / dauer >= 0.6
    return {
        "mitschnitt_dauer_s": round(dauer, 1),
        "nack_zeitraum_s": round(nack_spanne, 1),
        "nack_deckt_lauf_ab": lebend,
        "rtp_pakete_server_zu_player": rtp_hin,
        "nacks_player_zu_server": nacks,
        "plis_player_zu_server": plis,
        "rtcp_sonstiges_player_zu_server": rtcp_sonst,
        "wiederholte_sequenznummern": len(wiederholt),
        "beispiele": [{"ssrc": s, "seq": q} for s, q in wiederholt[:5]],
        "anzahl_ssrcs": len(letzte),
        "ssrcs": sorted(letzte)[:8],
        # Die eigentliche Frage: nuetzt die Nachlieferung etwas?
        "verspaetung_zugeordnet": len(verspaetung),
        "verspaetung_ms_min": round(verspaetung[0], 2) if verspaetung else None,
        "verspaetung_ms_median": round(verspaetung[len(verspaetung) // 2], 2) if verspaetung else None,
        "verspaetung_ms_max": round(verspaetung[-1], 2) if verspaetung else None,
        "rechtzeitig_bei_20ms_puffer": sum(1 for v in verspaetung if v <= 20.0),
        # Der Wert, auf den es HEUTE ankommt: der Player haelt seit dem
        # 2026-07-29 100 ms auf (`pulse-player/src/proto.rs::JITTER_MS_VORGABE`),
        # nicht mehr 20. Die 20er-Zahl bleibt daneben stehen, damit aeltere
        # Messakten vergleichbar bleiben — sie beantwortet aber nicht mehr,
        # ob eine Nachlieferung im laufenden Betrieb noch etwas nuetzt.
        "rechtzeitig_bei_100ms_puffer": sum(1 for v in verspaetung if v <= 100.0),
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
    elif nacks == 0 and args.profil != "klar":
        # Unter eingestelltem Verlust MUSS nachgefordert werden. Null NACKs
        # heisst, der Player kam nie in Fahrt — am 2026-07-29 einmal
        # passiert, und die Auswertung meldete trotzdem Verspaetungswerte,
        # die zu allem anderen im Widerspruch standen.
        print(f"KEIN URTEIL: null Nachforderungen trotz Profil '{args.profil}'. Der")
        print("             Player kam nicht in Fahrt — was hier als Wiederholung")
        print("             gezaehlt wird, gehoert zu keiner Nachforderung.")
    elif nacks > 1 and not ergebnis["nack_deckt_lauf_ab"]:
        print(f"KEIN URTEIL: die NACKs decken nur {ergebnis['nack_zeitraum_s']} s von")
        print(f"             {ergebnis['mitschnitt_dauer_s']} s ab — der Player hat")
        print("             mittendrin aufgehoert nachzufordern (Absturz?). Danach")
        print("             sendet der Server ins Leere; die Wiederholungen dort sind")
        print("             keine Antworten auf Nachforderungen.")
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
