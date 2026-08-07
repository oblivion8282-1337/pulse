#!/usr/bin/env python3
"""Misst, ob sich der BILDSCHIRMINHALT eines Ausschnitts von Aufnahme zu
Aufnahme ändert — ohne dass jemand hinsehen muss.

Warum es das gibt: am 2026-08-07 flimmerte ein **statisches** HDR-Testbild im
nativen Player sichtbar. Jede Erklärung dafür ist wertlos, solange „es
flimmert" nur ein Eindruck ist. Dieses Werkzeug macht daraus eine Zahl, und
zwar hinter dem Compositor — also an dem, was wirklich auf dem Schirm steht.
Ein Fehler des Players ist damit sichtbar, ein Fehler von KWin auch.

Aufgenommen wird mit `spectacle`. **KWins eigene Schnittstelle
`org.kde.KWin.ScreenShot2` scheidet aus**: sie prüft den Aufrufer und
antwortet fremden Programmen mit „The process is not authorized to take a
screenshot" (am 2026-08-07 nachgeprüft). Spectacle steht auf ihrer Liste.

    ./schirmprobe.py --bereich 2560,0,2560,1440 --proben 30 --label hdr-an

Zwei Zahlen, die zwei verschiedene Fehler zeigen:

* **Spanne der Flächenhelligkeit** — die Fläche wird als Ganzes heller und
  dunkler. Das ist Flimmern im engeren Sinn.
* **mittlerer Unterschied je Bildpunkt zwischen zwei aufeinanderfolgenden
  Aufnahmen** — ein wechselndes Muster bei gleicher Gesamthelligkeit
  (Rauschen, Bänderwandern) fällt nur hier auf.

GRENZEN DER AUSSAGE: Spectacle schafft nur wenige Aufnahmen je Sekunde. Ein
Flimmern im Bildtakt wird damit **nicht aufgelöst**, sondern nur als Streuung
nachgewiesen — die gemessene Spanne ist eine Untergrenze, nie die Amplitude.
Und die Aufnahme ist 8 bit je Kanal und auf SDR abgebildet: bei
HDR-Bildschirminhalt schiebt KWin vorher zusammen, Unterschiede unter einer
8-bit-Stufe sind grundsätzlich nicht messbar.
"""

from __future__ import annotations

import argparse
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
from PIL import Image


class Wachhalter:
    """Hält Bildschirmschoner UND Abdunkeln für die Dauer des Laufs an.

    **Ohne das misst man das Abdunkeln statt das Bild.** Während einer Messung
    rührt niemand Maus oder Tastatur; Plasma dunkelt den Schirm dann ab, die
    Flächenhelligkeit fällt mitten im Lauf um 12 bis 30 Prozent und bleibt
    unten. Am 2026-08-07 hat dieser Schritt vier Läufe verdorben und sah dabei
    wie ein Befund aus.

    Zwei Dinge daran sind nicht offensichtlich:

    * `dms ipc call inhibit` — so steht es in `hq-labor/CLAUDE.md` — greift auf
      dieser Maschine **nicht**: dort läuft Plasma, `dms` ist gar nicht
      gestartet („No running instances"). Die Notiz gilt für den niri-Aufbau.
    * Die Sperre hängt an der **D-Bus-Verbindung des Aufrufers**. Ein kurzer
      `qdbus6`-Aufruf hält sie deshalb nicht; sie fällt weg, sobald der
      Prozess endet. Die Verbindung muss den ganzen Lauf über offen bleiben —
      genau dafür gibt es dieses Objekt.
    """

    def __init__(self) -> None:
        self._marken: list[tuple[object, int]] = []
        try:
            import dbus
        except ImportError:
            print("dbus-python fehlt — das Abdunkeln ist nicht gehemmt", file=sys.stderr)
            return
        self._bus = dbus.SessionBus()
        for dienst, pfad, schnitt, args in (
            ("org.freedesktop.ScreenSaver", "/ScreenSaver",
             "org.freedesktop.ScreenSaver", ("pulse-schirmprobe", "Flimmermessung")),
            ("org.freedesktop.PowerManagement.Inhibit",
             "/org/freedesktop/PowerManagement/Inhibit",
             "org.freedesktop.PowerManagement.Inhibit",
             ("pulse-schirmprobe", "Flimmermessung")),
        ):
            try:
                objekt = dbus.Interface(self._bus.get_object(dienst, pfad), schnitt)
                self._marken.append((objekt, int(objekt.Inhibit(*args))))
            except Exception as e:  # noqa: BLE001 — Auskunft, kein Abbruch
                print(f"{dienst} liess sich nicht hemmen: {e}", file=sys.stderr)

    def freigeben(self) -> None:
        for objekt, marke in self._marken:
            try:
                objekt.UnInhibit(marke)
            except Exception:  # noqa: BLE001
                pass
        self._marken.clear()


def foto(pfad: Path) -> bool:
    """Ein Vollbild über alle Schirme. `-b` ohne Oberfläche, `-n` ohne
    Benachrichtigung — sonst stapeln sich die Meldungen im Panel."""
    pfad.unlink(missing_ok=True)
    subprocess.run(
        ["spectacle", "-b", "-n", "-f", "-o", str(pfad)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30, check=False,
    )
    return pfad.exists()


def ausschnitt(pfad: Path, x: int, y: int, w: int, h: int) -> np.ndarray:
    with Image.open(pfad) as bild:
        return np.asarray(bild.convert("RGB").crop((x, y, x + w, y + h)), dtype=np.int16)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bereich", required=True, help="x,y,breite,hoehe")
    ap.add_argument("--proben", type=int, default=30)
    ap.add_argument("--label", default="probe")
    a = ap.parse_args()
    x, y, w, h = (int(v) for v in a.bereich.split(","))

    mittel: list[float] = []
    unterschiede: list[float] = []
    vorheriges: np.ndarray | None = None
    wache = Wachhalter()
    t0 = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="schirmprobe-") as tmp:
        ziel = Path(tmp) / "schirm.png"
        for _ in range(a.proben):
            if not foto(ziel):
                print("spectacle lieferte kein Bild", file=sys.stderr)
                return 1
            feld = ausschnitt(ziel, x, y, w, h)
            mittel.append(float(feld.mean()))
            if vorheriges is not None:
                unterschiede.append(float(np.abs(feld - vorheriges).mean()))
            vorheriges = feld
    wache.freigeben()
    dauer = time.monotonic() - t0

    mw = statistics.fmean(mittel)
    spanne = max(mittel) - min(mittel)
    print(f"[{a.label}] {len(mittel)} Aufnahmen in {dauer:.1f} s "
          f"({len(mittel) / dauer:.2f} je Sekunde), Ausschnitt {w}x{h} bei ({x},{y})")
    print(f"[{a.label}] Flaechenhelligkeit  Mittel {mw:.4f}  min {min(mittel):.4f}  "
          f"max {max(mittel):.4f}")
    print(f"[{a.label}] Spanne              {spanne:.4f} von 255 "
          f"({spanne / max(mw, 1e-9) * 100:.3f} % der Helligkeit)")
    if unterschiede:
        print(f"[{a.label}] Unterschied je Bildpunkt zwischen zwei Aufnahmen: "
              f"Mittel {statistics.fmean(unterschiede):.4f}  "
              f"min {min(unterschiede):.4f}  max {max(unterschiede):.4f} Stufen")
    print(f"[{a.label}] Verlauf: " + " ".join(f"{v:.2f}" for v in mittel))
    return 0


if __name__ == "__main__":
    sys.exit(main())
