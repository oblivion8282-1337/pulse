#!/usr/bin/env python3
"""Normalweg (Browser, ``<video>``) gegen nativen Player — an EINEM Durchlauf.

**Wozu.** Alle Latenzzahlen des Players sind mit dem Player selbst erhoben. Ohne
den Normalweg daneben fehlt der Bezugspunkt: Man weiss dann nicht, ob der native
Weg überhaupt schneller ist oder nur anders.

**Aufbau — drei Bildschirme, jeder mit einer Rolle:**

* Quelle (``--quelle-x``, Vorgabe 2560): dort läuft das Zeitmuster, und genau
  diesen Schirm nimmt der Sender über das Portal-Token auf.
* Wiedergabe (``--wiedergabe-x``, Vorgabe 0): dort läuft der Browser im
  Vollbild, also 1:1 — nur deshalb sind die Klötze im Foto wieder 32 Punkte
  breit und lesbar.
* Der dritte bleibt frei; dort landet das Fenster des nativen Players, ohne die
  Quelle zu verdecken (was sonst eine Rückkopplung ergäbe).

**Warum ein Durchlauf für beide.** Über die echte Leitung schwankte die Latenz
zwischen Läufen um bis zu 27 ms (116 / 130 / 143 ms mit RTMPS). Zwei getrennte
Läufe zu vergleichen hiesse, diese Streuung als Ergebnis auszugeben — derselbe
Fehler, an dem am 2026-07-27 mehrere Aussagen gestorben sind. Deshalb: ein
Sender, erst der Browser, dann der native Player, danach Schluss.

**Zwei Verfahren, notwendigerweise.** Der Player liest den Balken selbst aus dem
dekodierten Bild (``probe.rs``), misst also bis kurz vor die Anzeige. Im Browser
gibt es diesen Zugriff nicht; dort wird physisch gemessen, und das Foto enthält
zusätzlich Compositor und Anzeigeverzug des Monitors. **Der Grundunterschied
zwischen beiden Zahlen ist deshalb teilweise Messverfahren** — eine Veränderung
INNERHALB eines Laufs (etwa ein Weglaufen) ist davon unberührt und aussagekräftig.

    ./vergleich-browser-nativ.py --proben 14 --label bn1
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import statistics as st
import subprocess
import sys
import time
from pathlib import Path

from harness import HERE, Player

_spec = importlib.util.spec_from_file_location("fh", HERE / "fern-harness.py")
_fh = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_fh)


def foto(pfad: Path) -> bool:
    subprocess.run(["spectacle", "-b", "-n", "-f", "-o", str(pfad)],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
    return pfad.exists()


def lies(pfad: Path, quelle_x: int, wiedergabe_x: int) -> int | None:
    r = subprocess.run(
        [sys.executable, str(HERE / "decode-shot.py"), str(pfad),
         "--quelle-x", str(quelle_x), "--wiedergabe-x", str(wiedergabe_x)],
        capture_output=True, text=True, timeout=60,
    )
    for line in r.stdout.splitlines():
        if "-> Latenz" in line:
            return int(line.split()[-2])
    return None


def starte_browser(whep: str, wiedergabe_x: int, ohne_drosselung: bool = False) -> subprocess.Popen:
    """Chromium im Vollbild auf dem Wiedergabe-Schirm.

    ``--ozone-platform=x11`` ist nicht kosmetisch: Ein Wayland-Client darf seine
    Fensterposition nicht setzen, unter XWayland geht ``--window-position`` und
    damit die gezielte Ablage auf einem bestimmten Schirm.
    """
    seite = (HERE / "whep-page.html").as_uri() + "?whep=" + whep.replace("&", "%26")
    return subprocess.Popen([
        "chromium", "--ozone-platform=x11",
        "--autoplay-policy=no-user-gesture-required",
        f"--window-position={wiedergabe_x},0", "--window-size=2560,1440",
        "--start-fullscreen", "--new-window",
        f"--user-data-dir={HERE}/chrome-profil", f"--app={seite}",
        # Chromium drosselt Fenster, die es fuer verdeckt oder unbeachtet haelt.
        # Im Messaufbau laeuft der Browser neben einem Terminal und ist nie das
        # aktive Fenster — eine gedrosselte Wiedergabe faellt fortlaufend
        # zurueck und saehe wie ein Fehler des Browser-WEGS aus, waere aber
        # einer der Messbedingungen. Deshalb abschaltbar und beides messbar.
        *(["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"]
          if ohne_drosselung else []),
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fps", type=int, default=60)
    ap.add_argument("--kbps", type=int, default=4000)
    ap.add_argument("--codec", default="h264")
    ap.add_argument("--bits", type=int, default=8)
    ap.add_argument("--proben", type=int, default=10)
    ap.add_argument("--quelle-x", type=int, default=2560)
    ap.add_argument("--wiedergabe-x", type=int, default=0)
    ap.add_argument("--ohne-drosselung", action="store_true",
                    help="Chromiums Hintergrund-Drosselung abschalten")
    ap.add_argument("--label", default="bn")
    return ap.parse_args()


def main() -> int:
    args = parse_args()
    tag = args.label
    send_log = open(HERE / f"send-{tag}.log", "w")
    player_log = open(HERE / f"player-{tag}.log", "w")

    epoch = str(int(time.time() * 1000))
    pattern_log = open(HERE / f"pattern-{tag}.log", "w")
    pattern = subprocess.Popen(
        [sys.executable, str(HERE / "pattern-one.py")],
        env={**os.environ, "PULSE_LATENCY_EPOCH_MS": epoch,
             "PULSE_PATTERN_X": str(args.quelle_x)},
        stdout=pattern_log, stderr=pattern_log,
    )
    time.sleep(2.5)
    if pattern.poll() is not None:
        print("Muster startete nicht — siehe pattern-Log", file=sys.stderr)
        return 1

    path, pub, rd = _fh.mint_remote()
    whep = f"https://{_fh.HOST}/whep/{path}/whep?token={rd}"
    push = _fh.push_url(path, pub, "rtmps", 120)
    print(f"[{tag}] Pfad {path}")

    sender = _fh.Sidecar(send_log, {})
    browser = None
    player = None
    browser_werte: list[int] = []
    nativ_werte: list[float] = []
    try:
        res = sender.call(
            "start", channel={"id": _fh.CID, "token": pub, "push_url": push},
            capture="portal", audio={"mode": "Desktop"},
            overrides={"codec": args.codec, "fps": args.fps,
                       "bitrate_kbps": args.kbps, "bit_depth": args.bits})
        if not res.get("ok"):
            print(f"start fehlgeschlagen: {res}", file=sys.stderr)
            return 1
        time.sleep(6.0)

        browser = starte_browser(whep, args.wiedergabe_x, args.ohne_drosselung)
        print("[browser] gestartet, warte auf Bild ...")
        time.sleep(12.0)
        for i in range(args.proben):
            p = HERE / f"shot-{tag}-{i}.png"
            p.unlink(missing_ok=True)
            if foto(p):
                v = lies(p, args.quelle_x, args.wiedergabe_x)
                # Obergrenze gegen einen zurückgelaufenen Zähler: er läuft nach
                # 65,5 s um, jenseits weniger Sekunden ist der Wert Unsinn.
                if v is not None and 0 < v < 5000:
                    browser_werte.append(v)
                    print(f"  Browser-Probe {i}: {v} ms")
                else:
                    print(f"  Browser-Probe {i}: nicht lesbar ({v})")
            time.sleep(1.5)
        browser.terminate()
        browser.wait(timeout=10)
        browser = None
        time.sleep(2.0)

        player = Player(player_log, {"PULSE_PLAYER_LATENCY_PROBE": "1",
                                     "PULSE_PLAYER_LATENCY_EPOCH_MS": epoch})
        res = player.call("open", url=whep, title="Vergleich nativ", timeout=30)
        if not res.get("ok"):
            print(f"open fehlgeschlagen: {res}", file=sys.stderr)
        else:
            sid = res["session"]
            for _ in range(int(args.proben * 1.5) + 4):
                time.sleep(1.0)
                s = player.call("stats", session=sid)
                if s.get("ok") and s.get("e2e_avg_us"):
                    nativ_werte.append(s["e2e_avg_us"] / 1000)
            # Die ersten beiden Proben fallen weg: der Sender ist da noch nicht
            # eingeschwungen (sichtbar als einzelner Ausreisser nach oben).
            nativ_werte = [v for v in nativ_werte if v > 0][2:]
    finally:
        if browser is not None:
            browser.terminate()
        if player is not None:
            player.stop()
        sender.stop()
        pattern.terminate()
        send_log.close()
        player_log.close()

    print("=" * 62)
    for name, werte in (("BROWSER (<video>)", browser_werte),
                        ("NATIV (pulse-player)", nativ_werte)):
        if werte:
            print(f"{name:22s} n={len(werte):2d}  median {st.median(werte):6.1f} ms"
                  f"   min {min(werte):6.1f}  max {max(werte):6.1f}")
        else:
            print(f"{name:22s} keine verwertbare Probe")
    print("=" * 62)

    (HERE / f"vergleich-{tag}.json").write_text(json.dumps(
        {"browser_ms": browser_werte, "nativ_ms": nativ_werte, "codec": args.codec,
         "bits": args.bits, "fps": args.fps, "kbps": args.kbps}, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
