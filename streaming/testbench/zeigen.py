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
    ./zeigen.py --fern                       # ueber die echte Leitung (Hetzner)

**Braucht `sudo` fuer `tc`** (nur wenn die Stoerung eingeschaltet wird) und
beim ersten Lauf den Portal-Dialog. Die Stoerung wird beim Beenden IMMER
abgeraeumt, auch bei Strg-C.

``--fern`` schickt denselben Aufbau ueber den Hetzner-Testserver statt ueber die
Schleife — dieselben Adressen, die ``fern-harness.py`` baut. Die Stoerung ist
dort NICHT verfuegbar: `netem` haengt an `lo` und trifft eine Verbindung ueber
das echte Netz gar nicht. Was fern dazukommt, ist die echte Laufzeit; was
wegfaellt, ist der Verlust auf Knopfdruck.
"""

from __future__ import annotations

import argparse
import os
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


def schleife(sender, player, sid: str, stoerbar: bool = True) -> None:
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
            elif not stoerbar:
                print("  -> Stoerung geht nur ueber die Schleife (tc haengt an lo)")
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


def einstieg_sichern(sender, player, sid: str, versuche: int = 6,
                     abstand: float = 2.0) -> bool:
    """Vollbild anfordern, bis der Player wirklich Bilder zeigt.

    EIN Ruf direkt nach `open` kommt zu FRUEH: `open` kehrt zurueck, sobald die
    Sitzung angelegt ist, ICE und DTLS brauchen danach noch rund eine Sekunde.
    Das Vollbild geht dann raus, bevor der Zuschauer zuhoert. Im
    Intra-Refresh-Betrieb kommt so schnell kein zweites (Uhr in MediaMTX aus,
    `PULSE_KEYFRAME_SECONDS=10`), und der Player gibt nach 600 Einheiten ohne
    Einstiegspunkt auf — `decode.rs::MAX_UNITS_WITHOUT_KEYFRAME`, also nach rund
    zehn Sekunden. Am 2026-07-29 genau so gesehen: Daten kamen mit 3,8 Mbit/s
    an, `state` blieb `connecting`, Bildrate 0.
    """
    for n in range(1, versuche + 1):
        r = sender.call("keyframe", timeout=5)
        if not r.get("ok"):
            print(f"  Vollbild-Anforderung abgelehnt: {r}", file=sys.stderr)
        time.sleep(abstand)
        st = player.call("stats", session=sid, timeout=5)
        if (st.get("fps") or 0) > 0:
            print(f"Einstieg steht nach {n} Vollbild-Anforderung"
                  f"{'en' if n > 1 else ''}.")
            return True
    print(f"Kein Bild trotz {versuche} Vollbild-Anforderungen — Sender-Log "
          f"pruefen (steht die Aufnahme? `duplicates` gegen echte Bewegung).",
          file=sys.stderr)
    return False


def argumente() -> argparse.Namespace:
    ap = argparse.ArgumentParser()
    ap.add_argument("--proto", default="whip", choices=["rtmps", "whip"])
    ap.add_argument("--codec", default="av1")
    # `type=int` ist NICHT kosmetisch: der Sidecar verwirft `bit_depth` still,
    # wenn es keine Zahl ist (`start.rs::requested_ten_bit`), und faellt auf
    # 8 bit zurueck — waehrend die Kopfzeile hier weiter "10 bit" meldet.
    # Am 2026-07-29 genau so passiert.
    ap.add_argument("--bits", type=int, default=10)
    ap.add_argument("--fps", type=int, default=60)
    ap.add_argument("--kbps", type=int, default=4000)
    ap.add_argument("--audio", default="Desktop")
    ap.add_argument("--ohne-antwort", action="store_true",
                    help="WHIP-Weg, aber ohne auf Vollbild-Anforderungen zu antworten "
                         "(der Trennschnitt aus der Messung, hier zum Ansehen)")
    ap.add_argument("--fern", action="store_true",
                    help="ueber den Hetzner-Testserver statt ueber die Schleife "
                         "(echte Laufzeit, dafuer keine Stoerung auf Knopfdruck)")
    ap.add_argument("--aufloesung", default=None,
                    help="Native/4K/1440p/1080p/720p/480p oder WxH. Ohne Angabe "
                         "die native Groesse des aufgenommenen Schirms. Achtung: "
                         "der Sidecar liest Unbekanntes still als Native")
    ap.add_argument("--portal-neu", action="store_true",
                    help="Portal-Dialog erzwingen, statt die letzte Auswahl "
                         "wiederzuverwenden — noetig, wenn ein ANDERER Schirm "
                         "aufgenommen werden soll")
    return ap.parse_args()


def adressen(args) -> tuple[str, str, str]:
    """(whep, push, publish-token) — fern wie ``fern-harness.py``, sonst lokal.

    Die Fern-Adressen werden dort geholt statt hier nachgebaut: sie tragen
    Eigenheiten, die man sonst still falsch abschreibt (der WHIP-Push laeuft
    ueber `handle_path /whep/*` in Caddy, und die Token muessen in die Redis DES
    CONTAINERS, nicht in die lokale).
    """
    if not args.fern:
        path, pub, rd = mint_tokens()
        push = (f"http://localhost:8889/{path}/whip?token={pub}" if args.proto == "whip"
                else f"rtmps://localhost:1936/{path}?token={pub}")
        return f"http://localhost:8889/{path}/whep?token={rd}", push, pub

    fern = laden("fern-harness")
    path, pub, rd = fern.mint_remote()
    return (f"https://{fern.HOST}/whep/{path}/whep?token={rd}",
            fern.push_url(path, pub, args.proto, 120), pub)


def main() -> int:
    args = argumente()

    whep, push, pub = adressen(args)
    sender_env = {"PULSE_WHIP_IGNORE_PLI": "1"} if args.ohne_antwort else {}
    if args.portal_neu:
        # `Sidecar` setzt die Wiederverwendung selbst auf 1; `env_extra` kommt
        # dahinter und gewinnt.
        sender_env["PULSE_PORTAL_REUSE"] = "0"

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
            # Stumm oeffnen: der Sender nimmt den Desktop-Ton auf, der Ton des
            # Players liefe also in den Strom zurueck. Die Kopfzeile behauptete
            # das schon, der Aufruf setzte es bis 2026-07-29 nicht.
            res = player.call("open", url=whep, title="Pulse — Ansicht",
                              options={"volume": 0.0})
            if not res.get("ok"):
                print(f"Player-Start fehlgeschlagen: {res}", file=sys.stderr)
                return 1

            # Vollbild NACH dem Beitritt, sonst bleibt das Fenster schwarz: der
            # Player fordert von sich aus erst bei einer Luecke an
            # (`session.rs`), und im Intra-Refresh-Betrieb ist die feste
            # Keyframe-Uhr von MediaMTX aus.
            if args.proto == "whip":
                einstieg_sichern(sender, player, res["session"])

            weg = f"{args.proto}{' OHNE Vollbild-Antwort' if args.ohne_antwort else ''}"
            ziel = "echte Leitung" if args.fern else "Schleife"
            print(f"\nFenster ist offen. Weg: {weg} ueber {ziel}, "
                  f"{args.codec} {args.bits} bit, {args.fps} fps, {args.kbps} kbps, "
                  f"{args.aufloesung or 'native Aufloesung'}")
            # Die Encoder-Schalter mit ausgeben: Intra-Refresh ist keine
            # Vorgabe, sondern haengt an der Umgebung. Wer sie beim Aufruf
            # vergisst, sieht sonst den ALTEN Weg und haelt ihn fuer den neuen.
            print(f"  Encoder: PULSE_ENCODER_OPTS="
                  f"{os.environ.get('PULSE_ENCODER_OPTS', '(nicht gesetzt)')}  "
                  f"PULSE_KEYFRAME_SECONDS="
                  f"{os.environ.get('PULSE_KEYFRAME_SECONDS', '(Vorgabe 2)')}")
            tasten_hilfe = ("p  Vollbild anfordern   q  Schluss" if args.fern else
                            "<Eingabetaste> Stoerung an/aus   + / -  Verlust aendern   "
                            "p  Vollbild anfordern   q  Schluss")
            print(f"  {tasten_hilfe}\n")

            schleife(sender, player, res["session"], stoerbar=not args.fern)

        except KeyboardInterrupt:
            print("\nSchluss.")
        finally:
            # Nur wenn ueberhaupt eine Regel gesetzt werden konnte — der Aufruf
            # geht sonst grundlos nach `sudo`.
            if not args.fern:
                netem_weg()
            if player:
                player.stop()
            sender.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
