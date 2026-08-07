#!/usr/bin/env python3
"""Faehrt die Probe ueber alle Arme und Materialien und sammelt die Ergebnisse.

Warum ein Treiber und nicht eine Schleife in der Shell:

* **Arme abwechselnd, Reihenfolge je Runde gedreht.** Ein Lauf je Variante
  traegt in diesem Labor keine Entscheidung (siehe hq-labor/CLAUDE.md), und
  wenn alle Laeufe eines Arms hintereinander liegen, misst man den
  Warmlaufzustand der Karte mit.
* **Jeder Lauf ein eigener Prozess.** Der CUDA-Kontext, der Decoder und der
  Speicher werden dadurch zwischen den Armen nicht geteilt — ein Arm kann den
  naechsten nicht schoenen oder verderben.
* **GPU-Takt wird mitgeschrieben.** Die Kostenmessung vom 2026-08-06 hat
  gezeigt, dass diese Karte in einen Sparzustand faellt und sich damit alle
  Posten um ein Vielfaches verschieben. Ohne den Takt daneben ist eine
  Zeitangabe hier nicht deutbar.
"""

import json
import os
import pathlib
import subprocess
import sys
import threading
import time

HIER = pathlib.Path(__file__).resolve().parent
BINAER = HIER / "target" / "release" / "cuvid-cuda-ausgabe"

# name -> Umgebungsvariablen. Die Kommentare sagen, wozu der Arm da ist —
# nicht jeder ist ein Messarm, mehrere sind Kontrollen.
ARME = {
    # Der Bezugsarm: Byte fuer Byte der Weg, den pulse-player heute geht.
    "hauptspeicher": {"SPIKE_HWCTX": "0", "SPIKE_FORMATWAHL": "roh"},
    # Der geprueste Weg: nur ein CUDA-Geraet angehaengt, sonst nichts geaendert.
    "cuda": {"SPIKE_HWCTX": "1", "SPIKE_FORMATWAHL": "roh"},
    # Kontrolle: derselbe CUDA-Weg, aber jedes Bild ausdruecklich
    # zurueckgeholt. Muss beim Bezugsarm landen, sonst ist der Gewinn nur
    # verschobene Arbeit.
    "cuda_abholen": {"SPIKE_HWCTX": "1", "SPIKE_FORMATWAHL": "roh", "SPIKE_ABHOLEN": "1"},
    # Kontrolle: der Abhol-Schalter allein darf im Hauptspeicher-Arm nichts
    # kosten (dort gibt es nichts abzuholen).
    "hauptspeicher_abholen": {"SPIKE_HWCTX": "0", "SPIKE_FORMATWAHL": "roh", "SPIKE_ABHOLEN": "1"},
    # Derselbe Weg, aber FFmpeg benutzt den primaeren CUDA-Kontext des Geraets
    # statt eines eigenen. Das ist die Form, die der Umbau braucht, damit
    # Decoder und Vulkan-Einhaengung im selben Kontext sitzen.
    "cuda_primaer": {"SPIKE_HWCTX": "1", "SPIKE_FORMATWAHL": "roh", "SPIKE_CUDA_FLAGS": "1"},
    # Kontrolle: reicht es, das Format zu erzwingen, OHNE ein CUDA-Geraet?
    # Beantwortet, ob hw_device_ctx notwendig ist oder nur hinreichend.
    "nur_formatwahl": {"SPIKE_HWCTX": "0", "SPIKE_FORMATWAHL": "cuda"},
}


class Taktwacht(threading.Thread):
    """Schreibt SM-Takt, Speichertakt und Decoder-Auslastung waehrend des Laufs mit."""

    def __init__(self):
        super().__init__(daemon=True)
        self.laeuft = True
        self.proben = []

    def run(self):
        while self.laeuft:
            try:
                aus = subprocess.run(
                    ["nvidia-smi", "--query-gpu=clocks.sm,clocks.mem,utilization.gpu,"
                     "utilization.decoder", "--format=csv,noheader,nounits"],
                    capture_output=True, text=True, timeout=5,
                )
                teile = [t.strip() for t in aus.stdout.strip().split(",")]
                if len(teile) == 4:
                    self.proben.append([int(t) for t in teile])
            except Exception:
                pass
            time.sleep(0.05)

    def zusammenfassung(self):
        if not self.proben:
            return None
        sm = [p[0] for p in self.proben]
        dec = [p[3] for p in self.proben]
        return {
            "sm_mhz_min": min(sm), "sm_mhz_max": max(sm),
            "sm_mhz_mittel": round(sum(sm) / len(sm)),
            "decoder_prozent_max": max(dec),
            "proben": len(self.proben),
        }


def lauf(datei, arm, bilder, aufwaermen):
    env = dict(os.environ)
    env["SPIKE_DATEI"] = str(datei)
    env["SPIKE_BILDER"] = str(bilder)
    env["SPIKE_AUFWAERMEN"] = str(aufwaermen)
    env.update(ARME[arm])

    wacht = Taktwacht()
    wacht.start()
    aus = subprocess.run([str(BINAER)], capture_output=True, text=True, env=env)
    wacht.laeuft = False
    wacht.join(timeout=2)

    zeile = next((z for z in aus.stdout.splitlines() if z.startswith("ERGEBNIS ")), None)
    if zeile is None:
        return {"arm": arm, "fehler": (aus.stderr or aus.stdout).strip()[-600:]}
    d = json.loads(zeile[len("ERGEBNIS "):])
    d["arm"] = arm
    d["gpu"] = wacht.zusammenfassung()
    return d


def main():
    material = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else HIER / "material"
    runden = int(os.environ.get("RUNDEN", "3"))
    bilder = int(os.environ.get("BILDER", "600"))
    aufwaermen = int(os.environ.get("AUFWAERMEN", "120"))

    dateien = sorted(material.glob("*.mkv"))
    if not dateien:
        sys.exit(f"kein Material in {material}")

    ergebnisse = []
    namen = list(ARME)
    for datei in dateien:
        for r in range(runden):
            # Reihenfolge je Runde drehen, damit kein Arm systematisch der
            # erste (kalte) oder der letzte (heisse) ist.
            folge = namen[r % len(namen):] + namen[: r % len(namen)]
            for arm in folge:
                d = lauf(datei, arm, bilder, aufwaermen)
                d["runde"] = r
                d["material"] = datei.name
                ergebnisse.append(d)
                if "fehler" in d:
                    print(f"{datei.name} r{r} {arm:22s} FEHLER: {d['fehler'][:160]}")
                else:
                    print(
                        f"{datei.name} r{r} {arm:22s} {d['bildformat']:8s} "
                        f"{'GPU' if d['im_grafikspeicher'] else 'RAM'} "
                        f"send {d['send_us']:7.0f} us  {d['fps']:7.1f} B/s  "
                        f"{d['kerne']:.3f} Kerne  SM {d['gpu']['sm_mhz_mittel'] if d['gpu'] else '?'} MHz"
                    )

    ziel = HIER / "matrix-ergebnis.json"
    ziel.write_text(json.dumps(ergebnisse, indent=1, ensure_ascii=False))
    print(f"\ngeschrieben: {ziel}")


if __name__ == "__main__":
    main()
