#!/usr/bin/env python3
"""Nulltest fuer die Foto-Messung — misst den Fehler des Messgeraets selbst.

**Wozu.** `vergleich-browser-nativ.py` bestimmt die Latenz des Browser-Wegs
physisch: ein Bildschirmfoto ueber Quell- und Wiedergabe-Schirm, beide Balken
zurueckgelesen, Differenz = Latenz. Das setzt voraus, dass das Foto **beide
Schirme im selben Augenblick** erfasst. Tut es das nicht, wandert der Versatz
zwischen den beiden Aufnahmen ungefragt ins Ergebnis.

Genau danach sieht ein Befund vom 2026-07-28 aus: Die gemessene Browser-Latenz
WUCHS im Lauf (177 -> 232 ms in rund 20 s, in drei von drei Laeufen). Im Betrieb
ist das nie aufgefallen, obwohl dort stundenlang gestreamt wird — bei dieser Rate
waere nach einer Stunde nichts mehr zu sehen. Der Widerspruch spricht gegen das
Messgeraet, nicht gegen die Beobachtung des Nutzers.

**Das Verfahren.** Dasselbe LIVE laufende Muster auf beide Schirme malen (das
normale `latency-pattern.py` tut das ohnehin) und dieselbe Bilderserie
aufnehmen wie im echten Vergleich. Die wahre Differenz ist dann null. Was
gemessen wird, ist der Fehler: der Zeitversatz zwischen den beiden Schirmen
innerhalb eines Fotos.

    ./nulltest-foto.py --proben 14
"""

from __future__ import annotations

import argparse
import os
import statistics as st
import subprocess
import sys
import time

from harness import HERE


def foto(pfad) -> bool:
    subprocess.run(["spectacle", "-b", "-n", "-f", "-o", str(pfad)],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
    return pfad.exists()


def lies(pfad, a: int, b: int) -> int | None:
    r = subprocess.run(
        [sys.executable, str(HERE / "decode-shot.py"), str(pfad),
         "--quelle-x", str(a), "--wiedergabe-x", str(b)],
        capture_output=True, text=True, timeout=60,
    )
    for line in r.stdout.splitlines():
        if "-> Latenz" in line:
            return int(line.split()[-2])
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--proben", type=int, default=14)
    ap.add_argument("--abstand", type=float, default=1.5,
                    help="Sekunden zwischen den Fotos — wie im echten Vergleich")
    ap.add_argument("--a-x", type=int, default=2560, help="X des einen Schirms")
    ap.add_argument("--b-x", type=int, default=0, help="X des anderen Schirms")
    args = ap.parse_args()

    epoch = str(int(time.time() * 1000))
    log = open(HERE / "pattern-nulltest.log", "w")
    muster = subprocess.Popen(
        [sys.executable, str(HERE / "latency-pattern.py")],
        env={**os.environ, "PULSE_LATENCY_EPOCH_MS": epoch},
        stdout=log, stderr=log,
    )
    time.sleep(2.5)
    if muster.poll() is not None:
        print("Muster startete nicht", file=sys.stderr)
        return 1

    werte: list[int] = []
    try:
        for i in range(args.proben):
            p = HERE / f"nulltest-{i}.png"
            p.unlink(missing_ok=True)
            if foto(p):
                v = lies(p, args.a_x, args.b_x)
                if v is None:
                    print(f"  Probe {i}: nicht lesbar")
                else:
                    # Der Zaehler laeuft nach 65,5 s um; ein Wert nahe der
                    # Obergrenze ist in Wahrheit eine kleine NEGATIVE Differenz.
                    if v > 32768:
                        v -= 65536
                    werte.append(v)
                    print(f"  Probe {i}: {v:+d} ms")
            time.sleep(args.abstand)
    finally:
        muster.terminate()
        log.close()

    print()
    if not werte:
        print("keine verwertbare Probe")
        return 1
    print(f"Sollwert 0 ms. Gemessen: Median {st.median(werte):+.1f}, "
          f"Spanne {min(werte):+d} bis {max(werte):+d}")
    if len(werte) >= 4:
        h1 = st.median(werte[: len(werte) // 2])
        h2 = st.median(werte[len(werte) // 2:])
        print(f"Erste Haelfte {h1:+.1f} ms, zweite Haelfte {h2:+.1f} ms "
              f"— Wanderung {h2 - h1:+.1f} ms")
        print()
        if abs(h2 - h1) > 10:
            print("BEFUND: Das Messgeraet wandert selbst. Der beobachtete Drift")
            print("        des Browser-Wegs ist damit ganz oder teilweise Artefakt.")
        else:
            print("BEFUND: Das Messgeraet wandert nicht. Der beobachtete Drift")
            print("        des Browser-Wegs ist echt und liegt am Browser.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
