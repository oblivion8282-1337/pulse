#!/usr/bin/env python3
"""Zeigt, wie gross die Verzoegerung ueber den Hetzner-Server ist. Sonst nichts.

Der Bildschirm traegt ein Zeitmuster (`latency-pattern.py`) — zwoelf Balken, die
die laufende Uhrzeit kodieren. Der Strom geht nach Hetzner und kommt ueber WHEP
zurueck ins Player-Fenster. Damit steht das Muster ZWEIMAL auf dem Schirm: einmal
jetzt, einmal so alt, wie die Runde gedauert hat. Der Player liest den Balken
aus dem dekodierten Bild zurueck und rechnet die Differenz aus.

Angezeigt wird jede Sekunde die gemessene Verzoegerung, dazu die reine Laufzeit
der Strecke (Ping) als Vergleichsmass — der Rest ist alles, was nicht
Lichtgeschwindigkeit ist.

Laeuft bis Strg-C.

    ./verzoegerung.py                    # neuer Sendeweg, AV1 10 bit
    ./verzoegerung.py --proto rtmps      # zum Vergleich der heutige Weg

Beim ersten Start kommt der Wayland-Dialog — einen BILDSCHIRM waehlen, kein
Fenster. Braucht SSH-Zugang zum Testserver (Token-Ablage), kein root.
"""

from __future__ import annotations

import argparse
import os
import re
import statistics as st
import subprocess
import sys
import time

from gemeinsam import laden, sender_starten
from harness import HERE, Player

_fern = laden("fern-harness")
Sidecar = laden("real-harness").Sidecar


def laufzeit_messen() -> float | None:
    """Reine Laufzeit der Strecke, einmal am Anfang. Ohne sie ist die gemessene
    Verzoegerung nicht einzuordnen: ein Teil davon ist Physik und durch keine
    Software zu gewinnen."""
    ziel = _fern.SSH.split("@")[-1]
    r = subprocess.run(["ping", "-c", "10", "-i", "0.2", "-q", ziel],
                       capture_output=True, text=True)
    m = re.search(r"= [\d.]+/([\d.]+)/", r.stdout)
    return float(m.group(1)) if m else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--proto", default="whip", choices=["rtmps", "srt", "whip"])
    ap.add_argument("--codec", default="av1")
    ap.add_argument("--bits", type=int, default=10)
    ap.add_argument("--fps", type=int, default=60)
    ap.add_argument("--kbps", type=int, default=4000)
    ap.add_argument("--audio", default="Desktop")
    args = ap.parse_args()

    print(f"Messe die Laufzeit nach {_fern.SSH.split('@')[-1]} ...")
    rtt = laufzeit_messen()
    print(f"  Umlaufzeit der Strecke: {rtt:.1f} ms\n" if rtt else "  (Ping ohne Antwort)\n")

    path, pub, rd = _fern.mint_remote()
    whep = f"https://{_fern.HOST}/whep/{path}/whep?token={rd}"
    push = _fern.push_url(path, pub, args.proto, 120)

    # Gemeinsamer Nullpunkt fuer Muster und Sonde — ohne ihn waere die Differenz
    # zwischen "jetzt" und "abgelesen" sinnlos.
    epoche = str(int(time.time() * 1000))
    muster_log = open(HERE / "verzoegerung-muster.log", "w")
    muster = subprocess.Popen(
        [sys.executable, str(HERE / "latency-pattern.py")],
        env={**os.environ, "PULSE_LATENCY_EPOCH_MS": epoche},
        stdout=muster_log, stderr=muster_log,
    )
    time.sleep(2.0)

    sender = Sidecar(open(HERE / "verzoegerung-sender.log", "w"))
    player = None
    werte: list[float] = []
    try:
        if not sender_starten(sender, args, pub, push):
            return 1
        print("Sender laeuft, warte auf den Server ...")
        time.sleep(5.0)

        player = Player(open(HERE / "verzoegerung-player.log", "w"),
                        {"PULSE_PLAYER_LATENCY_PROBE": "1",
                         "PULSE_PLAYER_LATENCY_EPOCH_MS": epoche})
        # Auf ein ECHTES Bild warten, nicht auf eine Zahl von Sekunden. Ein
        # fester Vorlauf ging sporadisch schief: der Pfad auf dem Server war
        # noch nicht bereit, der Player blieb still, und die Messung lieferte
        # stumm Nullen statt eines Fehlers. Bleibt es nach 20 s dunkel, wird die
        # Sitzung einmal neu aufgebaut — das faengt den Fall, dass die
        # vorherige Sitzung auf dem Server noch nicht abgeraeumt war.
        sid = None
        for versuch in (1, 2):
            res = player.call("open", url=whep, title="Pulse — Verzoegerung")
            if not res.get("ok"):
                print(f"Player-Start fehlgeschlagen: {res}", file=sys.stderr)
                return 1
            sid = res["session"]
            for _ in range(80):
                st_ = player.call("stats", session=sid, timeout=5)
                if (st_.get("frames_decoded") or 0) > 0:
                    break
                time.sleep(0.25)
            else:
                print(f"  kein Bild nach 20 s (Versuch {versuch})", file=sys.stderr)
                player.call("close", session=sid, timeout=5)
                continue
            break
        else:
            print("Zweimal kein Bild — Abbruch", file=sys.stderr)
            return 1
        print(f"\nFenster ist offen — {args.proto}, {args.codec} {args.bits} bit, "
              f"{args.fps} fps. Strg-C beendet.\n")

        while True:
            time.sleep(1.0)
            s = player.call("stats", session=sid, timeout=5)
            us = s.get("e2e_avg_us") or 0
            if not us:
                # Kein abgelesenes Muster: der Sender nimmt gerade kein Bild auf,
                # in dem es steht (falscher Bildschirm gewaehlt, Schirm dunkel).
                print(f"  kein Zeitmuster im Bild — {s.get('state', '?')}")
                continue
            ms = us / 1000
            werte.append(ms)
            eigen = f", davon nicht Leitung {ms - rtt:5.1f} ms" if rtt else ""
            print(f"  Verzoegerung {ms:6.1f} ms{eigen}   "
                  f"(Spitze {(s.get('e2e_max_us') or 0) / 1000:6.1f})")
    except KeyboardInterrupt:
        pass
    finally:
        if player:
            player.stop()
        sender.stop()
        muster.terminate()
        muster_log.close()

    if werte:
        print(f"\n{len(werte)} Sekunden gemessen: "
              f"kleinster {min(werte):.1f} · Mittelwert {st.median(werte):.1f} · "
              f"groesster {max(werte):.1f} ms")
        if rtt:
            print(f"Davon reine Laufzeit der Strecke: {rtt:.1f} ms — "
                  f"alles Weitere ({st.median(werte) - rtt:.1f} ms) ist Aufnahme, "
                  f"Encoder, Server, Dekodieren und Anzeige zusammen.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
