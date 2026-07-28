#!/usr/bin/env python3
"""Zum Zusehen: echter Stream, echtes Player-Fenster, Stoerung per Tastendruck.

Kein Messwerkzeug, sondern ein Anschauwerkzeug. Die Messungen sagen, WIEVIELE
Sekunden ohne Bild vergehen; sie sagen nicht, wie das aussieht. Genau das ist
aber die Frage, an der entschieden wird, ob ein Verhalten zumutbar ist — und
sie laesst sich nur ansehen, nicht ausrechnen.

Startet Sender und Player wie der Pruefstand, laesst beide dann aber einfach
LAUFEN und uebergibt die Steuerung an die Tastatur:

    <Eingabetaste>  Stoerung an/aus
    +  /  -         Verlust hoch/runter (0,2 → 0,5 → 1 → 2 → 5 %)
    p               Vollbild von Hand anfordern (nur ueber den WHIP-Weg)
    q               Schluss

Alle zwei Sekunden kommt eine Zeile mit dem, was der Player gerade sieht —
damit sich das Bild vor Augen und die Zahl nebeneinander lesen lassen.

    ./zeigen.py                              # AV1 10 bit ueber den neuen Weg
    ./zeigen.py --proto rtmps                # zum Vergleich der heutige Weg
    ./zeigen.py --ohne-antwort               # neuer Weg, aber ohne Vollbilder

**Braucht `sudo` fuer `tc`** (nur wenn die Stoerung eingeschaltet wird) und
beim ersten Lauf den Portal-Dialog. Die Stoerung wird beim Beenden IMMER
abgeraeumt, auch bei Strg-C.
"""

from __future__ import annotations

import argparse
import select
import signal
import sys
import time

from gemeinsam import laden, sender_starten
from harness import HERE, Player, mint_tokens

_netz = laden("netz-harness")
netem_setzen, netem_weg = _netz.netem_setzen, _netz.netem_weg
Sidecar = laden("real-harness").Sidecar

# Die Stufen, durch die `+`/`-` wandern. 0,2 % ist der Bereich einer echten
# Leitung (die Teststrecke zum Hetzner-Server verliert rund 0,05 %), 5 % ist
# grob unbrauchbar — beides zu sehen ist der Sinn der Sache.
STUFEN = ["0.2%", "0.5%", "1%", "2%", "5%"]


def stufe_setzen(idx: int, an: bool) -> None:
    netem_setzen(["loss", STUFEN[idx]] if an else [], nur_empfang=True)


def abbrechen(*_) -> None:
    """Signal-Handler: aus SIGINT/SIGTERM wird ein KeyboardInterrupt.

    Damit laeuft in JEDEM Fall das `finally` in `main()` — und nur dort wird
    die `tc`-Regel wieder abgeraeumt.
    """
    raise KeyboardInterrupt


def tasten() -> list[str]:
    """Was seit dem letzten Aufruf getippt wurde, ohne zu blockieren."""
    raus = []
    while select.select([sys.stdin], [], [], 0)[0]:
        zeile = sys.stdin.readline()
        if not zeile:
            break
        raus.append(zeile.strip().lower())
    return raus


def statuszeile(st: dict, vorher: dict, zustand: str) -> None:
    """Eine Zeile mit dem, was der Player gerade sieht.

    `packets_lost` und `frames_dropped` sind Gesamtwerte seit Beginn. Beim
    Zusehen interessiert, was GERADE passiert — sonst waechst die Zahl auch
    dann weiter, wenn die Stoerung laengst aus ist, und man schreibt sie dem
    Falschen zu. Deshalb stehen hier bewusst die Differenzen zur letzten Zeile.
    """
    verl = st.get("packets_lost", 0) - vorher.get("packets_lost", 0)
    luecken = st.get("frames_dropped", 0) - vorher.get("frames_dropped", 0)
    print(f"  Stoerung {zustand:8s} | Bildrate {st.get('fps') or 0:5.1f} | "
          f"verloren {verl:4d} | Luecken {luecken:3d} | "
          f"Dekodieren {(st.get('decode_avg_us') or 0) / 1000:4.1f} ms | "
          f"Puffer {st.get('jitter_target_ms') or 0:4.1f} ms | "
          f"{st.get('state', '?')}")


def schleife(sender, player, sid: str) -> None:
    """Laeuft, bis der Nutzer `q` tippt oder Strg-C drueckt (KeyboardInterrupt)."""
    an = False
    idx = 0
    letzte = 0.0
    vorher: dict = {}

    while True:
        for t in tasten():
            if t == "q":
                raise KeyboardInterrupt
            if t == "p":
                r = sender.call("keyframe", timeout=5)
                print(f"  -> Vollbild angefordert: {'ok' if r.get('ok') else r}")
            elif t in ("+", "-"):
                schritt = 1 if t == "+" else -1
                idx = max(0, min(idx + schritt, len(STUFEN) - 1))
                stufe_setzen(idx, an)
                print(f"  -> Verlust {STUFEN[idx]} ({'an' if an else 'aus'})")
            else:
                an = not an
                stufe_setzen(idx, an)
                print(f"  -> Stoerung {'AN' if an else 'AUS'} ({STUFEN[idx]})")

        if time.monotonic() - letzte >= 2.0:
            letzte = time.monotonic()
            st = player.call("stats", session=sid, timeout=5)
            statuszeile(st, vorher, ("AN " + STUFEN[idx]) if an else "aus")
            vorher = st
        time.sleep(0.1)


def argumente() -> argparse.Namespace:
    ap = argparse.ArgumentParser()
    ap.add_argument("--proto", default="whip", choices=["rtmps", "whip"])
    ap.add_argument("--codec", default="av1")
    ap.add_argument("--bits", default="10")
    ap.add_argument("--fps", type=int, default=60)
    ap.add_argument("--kbps", type=int, default=4000)
    ap.add_argument("--audio", default="Desktop")
    ap.add_argument("--ohne-antwort", action="store_true",
                    help="WHIP-Weg, aber ohne auf Vollbild-Anforderungen zu antworten "
                         "(der Trennschnitt aus der Messung, hier zum Ansehen)")
    return ap.parse_args()


def main() -> int:
    args = argumente()

    path, pub, rd = mint_tokens()
    whep = f"http://localhost:8889/{path}/whep?token={rd}"
    push = (f"http://localhost:8889/{path}/whip?token={pub}" if args.proto == "whip"
            else f"rtmps://localhost:1936/{path}?token={pub}")
    sender_env = {"PULSE_WHIP_IGNORE_PLI": "1"} if args.ohne_antwort else {}

    # Aufraeumen MUSS auch bei Strg-C laufen: eine stehengebliebene
    # `tc`-Regel stoert danach jede weitere Messung auf dieser Maschine, ohne
    # dass es auffaellt.
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, abbrechen)

    with open(HERE / "zeigen-sender.log", "w") as send_log, \
            open(HERE / "zeigen-player.log", "w") as player_log:
        sender = Sidecar(send_log, sender_env)
        player = None
        try:
            if not sender_starten(sender, args, pub, push):
                return 1
            print("Sender laeuft, warte auf den Pfad ...")
            time.sleep(4.0)

            player = Player(player_log)
            res = player.call("open", url=whep, title="Pulse — Ansicht")
            if not res.get("ok"):
                print(f"Player-Start fehlgeschlagen: {res}", file=sys.stderr)
                return 1

            weg = f"{args.proto}{' OHNE Vollbild-Antwort' if args.ohne_antwort else ''}"
            print(f"\nFenster ist offen. Weg: {weg}, {args.codec} {args.bits} bit, "
                  f"{args.fps} fps, {args.kbps} kbps")
            print("  <Eingabetaste> Stoerung an/aus   + / -  Verlust aendern   "
                  "p  Vollbild anfordern   q  Schluss\n")

            schleife(sender, player, res["session"])

        except KeyboardInterrupt:
            print("\nSchluss.")
        finally:
            netem_weg()
            if player:
                player.stop()
            sender.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
