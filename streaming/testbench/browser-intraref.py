#!/usr/bin/env python3
"""Haelt ein CHROME den Intra-Refresh-Betrieb unter Stoerung durch?

Die Frage, an der die Produktionsumstellung haengt. Pulse ist web-first; was im
Browser nicht geht, gibt es fuer die Mehrheit der Zuschauer nicht.

**Was schon belegt ist** (`profiles/browser-2026-07-31-intra-refresh.json`):
Chromium gibt einen Intra-Refresh-Strom wieder, sobald er EINEN Einstiegspunkt
bekommt — 2228 Bilder in 40 Sekunden, danach 37 Sekunden reiner Intra-Refresh
mit glatten 60 Bildern je Sekunde. Ohne Einstieg dagegen null Bilder, und das
gilt fuer jeden Decoder, auch unseren eigenen.

**Was offen ist und dieser Lauf beantwortet:** das Verhalten nach VERLUST im
laufenden Betrieb. In jener Messung gab es keinen Verlust, und der Sender war
ffmpeg — er konnte auf eine Anforderung gar nicht antworten.

Die Frage hat am 2026-07-31 an Gewicht gewonnen: Der native Player fror unter
Saettigung ein und blieb eingefroren, weil `av1_cuvid` in einen Zustand kippt,
in dem er weiter 60 Bilder je Sekunde ausgibt — immer dasselbe. Fuer unseren
Player gibt es dagegen jetzt einen Detektor. **Bei Chrome koennten wir das
nicht**: dessen Decoder ist eine Blackbox, wir koennen weder erkennen noch
eingreifen. Zeigt Chrome dasselbe Verhalten, waere Intra-Refresh fuer
Browser-Zuschauer ein Risiko, das wir nicht abfangen koennen.

**Wie hier ein Einfrieren erkannt wird.** Nicht an `framesDecoded` — der lief
beim nativen Player munter weiter, waehrend das Bild stand. Sondern am
Pixel-Fingerabdruck des sichtbaren Videobildes (`bildAbdruck` in
`browser-whep.mjs`): aendert er sich ueber Sekunden nicht, waehrend Daten
ankommen, steht das Bild.

    ./browser-intraref.py --secs 300 --stoeren 60:25
    ./browser-intraref.py --secs 300 --stoeren 60:25 --keyframes   # Gegenprobe

Der Sender ist der ECHTE Sidecar (Portal noetig), damit die
Vollbild-Anforderung des Browsers auch beantwortet werden kann — genau das
fehlte der Messung vom Vormittag.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

from gemeinsam import laden, sender_starten
from harness import HERE

_fern = laden("fern-harness")
_iv = laden("intraref-verlust")
Sidecar = laden("real-harness").Sidecar


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--secs", type=float, default=300.0)
    ap.add_argument("--label", default="browser-intraref")
    ap.add_argument("--fps", type=int, default=60)
    ap.add_argument("--kbps", type=int, default=4000)
    ap.add_argument("--codec", default="av1")
    # 8 bit als Vorgabe, NICHT 10: ein headless Chromium dekodiert ueber die
    # Software-Anbindung, und libwebrtcs dav1d lehnt `bpc != 8` ab (Befund vom
    # 2026-07-31 frueh). Mit 10 bit misst man deshalb nur diese Ablehnung —
    # der erste Anlauf dieses Tests lief genau so ins Leere: 265 vergebliche
    # Vollbild-Anforderungen, `framesDecoded` blieb null, und
    # `decoderImplementation` tauchte in keiner Probe auf.
    ap.add_argument("--bits", type=int, default=8)
    ap.add_argument("--audio", default="Aus")
    ap.add_argument("--keyframes", action="store_true",
                    help="Gegenprobe: periodische Keyframes statt Intra-Refresh")
    ap.add_argument("--stoeren", metavar="AB:DAUER", help="z.B. 60:25")
    ap.add_argument("--stoer-alle", type=float, metavar="SEKUNDEN")
    ap.add_argument("--stoer-strom", type=int, default=4)
    ap.add_argument("--electron", action="store_true",
                    help="in der Electron-Fassung statt im nackten Chromium")
    # Ohne bewegtes Bild ist der Pixel-Fingerabdruck wertlos: ein stehender
    # Desktop liefert dieselben Pixel wie ein eingefrorener Decoder. Das
    # Zeitmuster sorgt fuer garantierte Bewegung in JEDEM Bild.
    ap.add_argument("--sichtbar", action="store_true",
                    help="Chromium-Fenster anzeigen (zum Zusehen statt Messen)")
    ap.add_argument("--muster", action="store_true",
                    help="Zeitmuster anzeigen (Pflicht fuer den Standbild-Nachweis)")
    args = ap.parse_args()

    muster = None
    if args.muster:
        import os
        muster = subprocess.Popen(
            [sys.executable, str(HERE / "latency-pattern.py")],
            env={**os.environ, "PULSE_LATENCY_EPOCH_MS": str(int(time.time() * 1000))},
            stdout=open(HERE / f"muster-{args.label}.log", "w"), stderr=subprocess.STDOUT)
        time.sleep(2.0)
        if muster.poll() is not None:
            print("Zeitmuster startete nicht", file=sys.stderr)
            return 1
        print("Zeitmuster laeuft — der Bildschirm zeigt jetzt die Messbalken.")

    # Vendor-neutral, siehe intraref-verlust.py: der NVENC-Optionsname allein
    # haette auf AMD still einen Keyframe-Lauf gemessen.
    env = {} if args.keyframes else {"PULSE_INTRA_REFRESH": "1"}
    sender = Sidecar(open(HERE / f"sender-{args.label}.log", "w"), env)
    browser = None
    try:
        path, pub, rd = _fern.mint_remote()
        push = _fern.push_url(path, pub, "whip", 120)
        print(f"[{args.label}] {'Keyframes' if args.keyframes else 'Intra-Refresh'} "
              f"-> {_fern.HOST}, Pfad {path}")
        if not sender_starten(sender, args, pub, push):
            return 1
        time.sleep(5.0)

        whep = f"https://{_fern.HOST}/whep/{path}/whep?token={rd}"
        befehl = ["node", str(HERE / "browser-whep.mjs"), "--url", whep,
                  "--secs", str(int(args.secs)), "--label", args.label]
        if args.electron:
            befehl.append("--electron")
        if args.sichtbar:
            befehl.append("--sichtbar")
        browser = subprocess.Popen(befehl, cwd=HERE)

        # Der Browser braucht seinen Einstiegspunkt — und zwar WIEDERHOLT
        # angefordert, aus demselben Grund wie beim nativen Player: eine
        # einzelne Anforderung waehrend des Verbindungsaufbaus geht ins Leere,
        # und im Intra-Refresh-Betrieb kommt nie wieder eine von selbst.
        for _ in range(8):
            time.sleep(1.0)
            sender.call("keyframe", timeout=10)

        start = time.monotonic()
        stoer_ab = stoer_dauer = None
        if args.stoeren:
            stoer_ab, stoer_dauer = (float(x) for x in args.stoeren.split(":"))
            stoer_log = open(HERE / f"stoerung-{args.label}.log", "w")

        while browser.poll() is None and time.monotonic() - start < args.secs + 30:
            time.sleep(1.0)
            if stoer_ab is not None and time.monotonic() - start >= stoer_ab:
                print(f"[{time.monotonic() - start:.0f} s] STOERUNG an "
                      f"({args.stoer_strom} Stroeme, {stoer_dauer:.0f} s)", flush=True)
                _iv.stoerung(_iv.STOER_QUELLE, args.stoer_strom, stoer_dauer, stoer_log)
                print(f"[{time.monotonic() - start:.0f} s] Stoerung aus", flush=True)
                stoer_ab = (time.monotonic() - start + args.stoer_alle
                            if args.stoer_alle else None)
        browser.wait(timeout=60)
    except KeyboardInterrupt:
        print("\nabgebrochen")
    finally:
        if browser and browser.poll() is None:
            browser.terminate()
        sender.stop()
        if muster:
            muster.terminate()

    return auswerten(HERE / f"browser-proben-{args.label}.json")


def auswerten(pfad: Path) -> int:
    """Meldet, ob das sichtbare Bild jemals stehengeblieben ist."""
    if not pfad.exists():
        print(f"Keine Proben unter {pfad}", file=sys.stderr)
        return 1
    proben = json.loads(pfad.read_text())[2:]          # Anlauf weg
    if not proben:
        print("Zu wenige Proben", file=sys.stderr)
        return 1

    letzte = proben[-1]
    print(f"\n{len(proben)} Proben, Decoder {letzte.get('decoderImplementation', '?')}")
    print(f"  Bilder dekodiert   {letzte.get('framesDecoded')}")
    print(f"  Pakete verloren    {letzte.get('packetsLost')}")
    print(f"  PLI / NACK         {letzte.get('pliCount')} / {letzte.get('nackCount')}")
    print(f"  freezeCount        {letzte.get('freezeCount')} "
          f"({letzte.get('totalFreezesDuration')} s gesamt)")

    # Die eigentliche Frage: stand das sichtbare Bild jemals?
    laeufe: list[int] = []
    lauf = 0
    for a, b in zip(proben, proben[1:], strict=False):
        if a.get("bildAbdruck") is not None and a.get("bildAbdruck") == b.get("bildAbdruck"):
            lauf += 1
        else:
            if lauf:
                laeufe.append(lauf)
            lauf = 0
    if lauf:
        laeufe.append(lauf)
    if not any(p.get("bildAbdruck") is not None for p in proben):
        print("\n  KEIN Bild-Fingerabdruck in den Proben — Auswertung nicht moeglich.")
        return 1
    if not laeufe:
        print("\n  Das Bild hat sich in JEDER Sekunde geaendert — kein Standbild.")
    else:
        print(f"\n  Standbild-Phasen: {len(laeufe)}, laengste {max(laeufe)} s "
              f"(Summe {sum(laeufe)} s von {len(proben)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
