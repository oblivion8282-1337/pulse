#!/usr/bin/env python3
"""Echter Sidecar als Sender, BROWSER als Zuschauer — die Produktionspaarung.

**Warum es dieses Skript gibt.** Am 2026-08-06 stand fest, dass Paritaet ueber
RTMPS in der Produktion ausfaellt, ueber WHIP aber laeuft. Alle bisherigen
Reproduktionsversuche paarten aber jeweils nur EINE der beiden Haelften richtig:

  * fuenf ffmpeg-Laeufe ueber RTMPS mit der echten Electron-App -> Paritaet lief
  * ein Lauf mit dem echten Sidecar ueber RTMPS und dem NATIVEN Player
    (Paritaetstyp 110) -> Paritaet lief

Die Produktion faehrt aber **echter Sidecar + Chromium/Electron**
(Paritaetstyp 49). Genau diese Paarung fehlte, und nur sie kann die Ursache
tragen. `real-harness.py` kann den Sidecar, aber nur mit dem nativen Player;
`fec-browser.py` kann den Browser, aber nur mit ffmpeg als Sender. Dieses
Skript setzt die fehlende Haelfte zusammen.

Es aendert bewusst NICHTS an den beiden vorhandenen Skripten — es benutzt
deren Bausteine (Token-Vergabe aus `harness.py`, Sidecar-Steuerung aus
`real-harness.py`, Browser-Zuschauer aus `browser-whep.mjs`).

    ./fec-sidecar-browser.py --proto rtmps --zuschauer chromium --secs 30
    ./fec-sidecar-browser.py --proto whip  --zuschauer chromium --secs 30

Ausgewertet wird die Bilanzzeile von MediaMTX
(`docker logs streaming-mediamtx`); sie nennt seit dem 2026-08-06 auch den
ausgehandelten Paritaetstyp und die Zahl der Medienpakete — ohne die beiden
Felder sind "nicht ausgehandelt" und "ausgehandelt, aber nichts erzeugt" nicht
unterscheidbar.
"""

from __future__ import annotations

import argparse
import importlib.util
import subprocess
import sys
import time
from types import ModuleType

from harness import CID, HERE, mint_tokens


# `real-harness.py` und `netz-harness.py` tragen einen Bindestrich und sind
# damit nicht normal importierbar. Kopieren waere die schlechtere Wahl: in
# `Sidecar` steckt der Lesefaden mit Frist, ohne den ein haengender
# Portal-Aufbau als stiller Fehlschlag durchginge (Lehre vom 2026-07-28), und
# in `netz-harness.py` steckt die Filter-Feinheit (IPv4 UND IPv6, `flower`
# statt `u32`), an der eine selbstgebaute Fassung still vorbeimessen wuerde.
def _modul(name: str, datei: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, HERE / datei)
    modul = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(modul)
    return modul


def _mediamtx_log(zeilen: int) -> str:
    """Die letzten Zeilen des MediaMTX-Containers, stdout UND stderr.

    Beide Kanaele zusammen, weil MediaMTX je nach Version und Logstufe mal auf
    den einen, mal auf den anderen schreibt — wer nur stdout liest, sieht die
    Bilanzzeile mitunter gar nicht.
    """
    roh = subprocess.run(["docker", "logs", "--tail", str(zeilen), "streaming-mediamtx"],
                         capture_output=True, text=True)
    return roh.stdout + roh.stderr


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--secs", type=float, default=30.0)
    ap.add_argument("--fps", type=int, default=60)
    ap.add_argument("--codec", default="av1")
    ap.add_argument("--bits", type=int, default=10)
    ap.add_argument("--kbps", type=int, default=4000)
    ap.add_argument("--audio", default="Desktop")
    ap.add_argument("--proto", default="rtmps", choices=["rtmps", "whip"])
    ap.add_argument("--zuschauer", default="chromium", choices=["chromium", "electron"])
    ap.add_argument("--label", default="sidecar-browser")
    # Der Zuschauer steigt in der Produktion irgendwann ein, im Labor sofort.
    # Das ist einer der wenigen verbliebenen Unterschiede zwischen beiden — und
    # ein spaeter Einstieg ist bei RTMPS der Normalfall (Stroeme laufen
    # stundenlang), bei den WHIP-Laeufen des Labors nie.
    ap.add_argument("--warten", type=float, default=0.0,
                    help="Sekunden nach Sendebeginn, bevor der Zuschauer einsteigt")
    # Verlust und Laufzeit sind KEIN Beiwerk: auf der ungestoerten Schleife gibt
    # es keine Nachlieferungen, und genau die sind der einzige bekannte Weg, auf
    # dem die Sequenznummern des Paritaets-Puffers unstetig werden koennen
    # (pion `EncodeFec` verwirft dann die ganze Gruppe). Ein Lauf ohne Stoerung
    # kann diese Fehlerklasse also gar nicht zeigen.
    ap.add_argument("--verlust", type=float, default=0.0, help="Prozent, netem auf lo")
    ap.add_argument("--laufzeit-ms", type=float, default=0.0,
                    help="einseitige Verzoegerung in ms (Umlaufzeit = das Doppelte)")
    args = ap.parse_args()

    rh = _modul("real_harness", "real-harness.py")
    netz = _modul("netz_harness", "netz-harness.py")
    netem: list[str] = []
    if args.laufzeit_ms > 0:
        netem += ["delay", f"{args.laufzeit_ms}ms"]
    if args.verlust > 0:
        netem += ["loss", f"{args.verlust}%"]
    if netem:
        netz.netem_setzen(netem, nur_empfang=True)
    tag = f"{args.label}-{args.proto}-{args.zuschauer}"
    path, pub, rd = mint_tokens()
    if args.proto == "whip":
        push = f"http://localhost:8889/{path}/whip?token={pub}"
    else:
        push = f"rtmps://localhost:1936/{path}?token={pub}"
    whep = f"http://localhost:8889/{path}/whep?token={rd}"
    print(f"[{tag}] Pfad {path}")

    send_log = open(HERE / f"send-{tag}.log", "w")
    sender = rh.Sidecar(send_log)
    try:
        res = sender.call(
            "start",
            channel={"id": CID, "token": pub, "push_url": push},
            capture="portal",
            audio={"mode": args.audio},
            overrides={"codec": args.codec, "fps": args.fps,
                       "bitrate_kbps": args.kbps, "bit_depth": args.bits},
        )
        if not res.get("ok"):
            print(f"start fehlgeschlagen: {res}", file=sys.stderr)
            return 1
        # Warten, bis MediaMTX den Pfad wirklich fuehrt. Ein festes `sleep`
        # verliert das Rennen regelmaessig — der erste Lauf am 2026-08-06 kam
        # eine Sekunde zu frueh und meldete `no stream is available`.
        for _ in range(60):
            time.sleep(0.5)
            if f"path {path}] stream is available" in _mediamtx_log(50):
                break
        else:
            print("Strom kam nicht zustande", file=sys.stderr)
            return 1

        if args.warten > 0:
            time.sleep(args.warten)

        cmd = ["node", str(HERE / "browser-whep.mjs"), "--url", whep,
               "--secs", str(int(args.secs)), "--label", tag]
        if args.zuschauer == "electron":
            cmd += ["--electron", "--flags", "--user-data-dir=/tmp/pulse-electron-fecmess"]
        fertig = subprocess.run(cmd, capture_output=True, text=True,
                                timeout=args.secs + 150, cwd=HERE)
        if fertig.returncode != 0:
            print((fertig.stderr or fertig.stdout)[-600:], file=sys.stderr)
    finally:
        sender.call("stop")
        time.sleep(2.0)
        sender.p.terminate()
        send_log.close()
        if netem:
            # Wieviele Pakete die Stoerung WIRKLICH getroffen hat — ohne diese
            # Bezugsgroesse ist eine FEC-Zaehlung nicht deutbar (Lehre aus
            # `fec-browser.py`). VOR dem Abraeumen ablesen: mit der
            # Warteschlange verschwinden auch ihre Zaehler.
            gesendet, verworfen = netz.netem_wirkung()
            anteil = 100.0 * verworfen / gesendet if gesendet else 0.0
            print(f"Stoerung wirkte auf {gesendet} Pakete, "
                  f"{verworfen} verworfen ({anteil:.2f} %)")
            netz.netem_weg()

    sdp = HERE / f"sdp-{tag}.txt"
    if sdp.exists():
        antwort = sdp.read_text().split("--- ANSWER ---", 1)[-1]
        print("Antwort traegt flexfec-03:", "flexfec-03" in antwort,
              "| ssrc-group:FEC-FR:", "ssrc-group:FEC-FR" in antwort)
    for zeile in _mediamtx_log(40).splitlines():
        if "FEC-Tor" in zeile:
            print(zeile)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
