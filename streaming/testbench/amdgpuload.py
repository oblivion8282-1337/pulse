#!/usr/bin/env python3
"""GPU-Last auf AMD — das Gegenstueck zu `gpuload.py` (das ist reines nvidia-smi).

`gpuload.py` faellt auf AMD still aus. Ohne Ersatz ist die dritte Achse neben
Latenz und Bild nicht messbar, und damit ist die Frage "was kostet diese
Encoder-Einstellung" auf AMD unbeantwortbar.

**Gemessen wird pro PROZESS, nicht global.** Das ist der Kern und nicht
offensichtlich: `/sys/class/drm/card*/device/gpu_busy_percent` ist
maschinenweit. Bei einer Messreihe laeuft aber `bewegtbild.py` mit — mpv
dekodiert dort AV1 auf derselben Karte. Ein globaler Zaehler schreibt dessen
Decode-Last unserem Encoder zu, und zwar in einer Groesse, die sich mit dem
Inhalt aendert. Die Zahl waere unbrauchbar und saehe trotzdem plausibel aus.

Quelle ist deshalb **DRM-fdinfo** (`/proc/<pid>/fdinfo/*`): amdgpu schreibt dort
je Engine die kumulierte Beschaeftigungszeit in Nanosekunden, fuer genau diesen
Prozess. Zwei Engines zaehlen hier:

* `drm-engine-enc` — der VCN-Encoder-Block. Das ist die eigentliche
  Encoder-Rechenzeit und das direkte Gegenstueck zu `nvidia-smi`s `enc`-Prozent.
* `drm-engine-compute` — bei uns der `scale_vaapi`-Durchgang, also die
  BGRx->NV12-Farbumrechnung. Die gibt es NUR im AMD-Pfad (NVENC nimmt RGB
  direkt und wandelt intern). Sie getrennt zu sehen ist der einzige Weg, diesen
  Zusatzposten zu beurteilen, statt ihn dem Encoder anzulasten.

Zwei Fallen, beide schon zugeschlagen:

* **Nach `drm-client-id` deduplizieren.** Derselbe Client erscheint unter
  mehreren Dateideskriptoren mit identischen Zaehlern. Wer alle fdinfo-Dateien
  aufsummiert, zaehlt die Zeit mehrfach und bekommt Auslastungen ueber 100 %.
* **Je BILD normalisieren, nicht je Sekunde.** Eine Prozentzahl haengt an der
  Bildrate: derselbe Encoder ist bei 144 fps "mehr belastet" als bei 60, ohne
  dass eine Einstellung teurer geworden waere. Die vergleichbare Groesse ist
  Encoder-Zeit JE BILD (us/Bild).

Leistungsaufnahme und Takt werden mitgeschrieben, sind aber **ausdruecklich
nachrangig**: sie sind maschinenweit und tragen mpv mit. Sie taugen als
Plausibilitaetskontrolle, nicht als Messwert.

    with AmdGpuLoad(pid) as g:
        ...
    f = g.fenster(ab, bis)
    print(g.je_bild_us(f, "enc", 60), "us VCN je Bild")
"""

from __future__ import annotations

import threading
import time
from pathlib import Path

DRM = Path("/sys/class/drm")


def _karte() -> Path | None:
    """Der erste amdgpu-Knoten mit Auslastungszaehler."""
    for c in sorted(DRM.glob("card*")):
        if (c / "device/gpu_busy_percent").exists():
            return c / "device"
    return None




def _engines(pid: int) -> dict[str, dict[str, int]]:
    """Engine-Zeiten (ns) je DRM-Client dieses Prozesses: {client_id: {engine: ns}}.

    **Je Client, nicht aufsummiert** — und das ist keine Kosmetik. Die Zaehler
    sind kumulativ je Client, und die Client-Menge aendert sich waehrend eines
    Laufs (der VAAPI-Filtergraph oeffnet seinen eigenen Kontext). Wer erst
    aufsummiert und dann die Differenz zweier Summen bildet, verrechnet einen
    neu erschienenen Client mit seiner GESAMTEN Vorgeschichte als Zuwachs und
    einen verschwundenen als negativen Zuwachs.

    Gemessene Folge dieses Fehlers am 2026-07-30: die `scale_vaapi`-Zeit streute
    ueber fuenf identische Laeufe um 904 us/Bild bei einem Median von 1170 —
    also um 77 %, was jede Aussage darueber unmoeglich machte. Die
    Encoder-Zeit war weniger betroffen (ihr Client lebt den ganzen Lauf), aber
    nicht immun.
    """
    gesehen: dict[str, dict[str, int]] = {}
    try:
        eintraege = sorted(Path(f"/proc/{pid}/fdinfo").iterdir())
    except OSError:
        return gesehen
    for f in eintraege:
        try:
            text = f.read_text()
        except OSError:
            continue          # fd waehrend des Lesens geschlossen — normal
        if "drm-driver" not in text:
            continue
        felder = {}
        for zeile in text.splitlines():
            k, _, v = zeile.partition(":")
            if v:
                felder[k.strip()] = v.strip()
        cid = felder.get("drm-client-id")
        if cid is None or cid in gesehen:
            continue
        eng: dict[str, int] = {}
        for k, v in felder.items():
            if k.startswith("drm-engine-"):
                try:
                    eng[k[len("drm-engine-"):]] = int(v.split()[0])
                except (ValueError, IndexError):
                    continue
        gesehen[cid] = eng
    return gesehen


def _lies(p: Path, standard: int = 0) -> int:
    try:
        return int(p.read_text().split()[0])
    except (OSError, ValueError, IndexError):
        return standard


class AmdGpuLoad:
    """Sammelt Engine-Zeiten des Prozesses `pid`, bis der Block verlassen wird."""

    def __init__(self, pid: int, interval: float = 0.25) -> None:
        self.pid = pid
        self.interval = interval
        self.proben: list[tuple[float, dict[str, int], int, int, int]] = []
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._dev = _karte()
        hwmon = sorted((self._dev / "hwmon").glob("hwmon*")) if self._dev else []
        self._hwmon = hwmon[0] if hwmon else None

    def __enter__(self) -> AmdGpuLoad:
        if self._dev is None:
            return self
        self._thread = threading.Thread(target=self._poll, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=3)

    def _poll(self) -> None:
        while not self._stop.is_set():
            t = time.monotonic()
            eng = _engines(self.pid)
            busy = _lies(self._dev / "gpu_busy_percent")
            leistung = _lies(self._hwmon / "power1_average") if self._hwmon else 0
            takt = _lies(self._hwmon / "freq1_input") if self._hwmon else 0
            self.proben.append((t, eng, busy, leistung, takt))
            self._stop.wait(self.interval)

    # --- Auswertung -------------------------------------------------------

    def fenster(self, ab: float, bis: float) -> dict[str, float] | None:
        """Auswertung ueber ein Zeitfenster (monotone Uhr), Anfang/Ende exklusiv
        der Proben davor/danach. `None`, wenn zu wenige Proben im Fenster liegen.

        Der Aufrufer schneidet den Anlauf bewusst SELBST ab: der erste Keyframe
        und die Encoder-Initialisierung liegen sonst mit im Mittel und machen
        jede Variante teurer, als sie ist.
        """
        drin = [p for p in self.proben if ab <= p[0] <= bis]
        if len(drin) < 4:
            return None
        t0, eng0 = drin[0][0], drin[0][1]
        t1, eng1 = drin[-1][0], drin[-1][1]
        dauer = t1 - t0
        if dauer <= 0:
            return None
        ergebnis: dict[str, float] = {"fenster_s": round(dauer, 2), "proben": len(drin)}
        # NUR Clients, die an BEIDEN Enden des Fensters da sind (s. `_engines`).
        # Ein Client, der dazwischen auftaucht oder geht, hat keine gueltige
        # Differenz — er wird gezaehlt, aber nicht verrechnet.
        gemeinsam = set(eng0) & set(eng1)
        ergebnis["clients_gemeinsam"] = len(gemeinsam)
        ergebnis["clients_wechsel"] = len(set(eng0) ^ set(eng1))
        engines = {e for cid in gemeinsam for e in (set(eng0[cid]) | set(eng1[cid]))}
        for name in sorted(engines):
            delta_ns = sum(eng1[cid].get(name, 0) - eng0[cid].get(name, 0)
                           for cid in gemeinsam)
            ergebnis[f"{name}_util_pct"] = round(delta_ns / (dauer * 1e9) * 100, 2)
            ergebnis[f"{name}_ns"] = delta_ns
        ergebnis["gpu_busy_pct_mittel"] = round(sum(p[2] for p in drin) / len(drin), 1)
        ergebnis["leistung_w_mittel"] = round(sum(p[3] for p in drin) / len(drin) / 1e6, 2)
        ergebnis["takt_mhz_mittel"] = round(sum(p[4] for p in drin) / len(drin) / 1e6, 0)
        return ergebnis

    def je_bild_us(self, fenster: dict[str, float], engine: str, fps: int) -> float | None:
        """Engine-Zeit je Bild in Mikrosekunden — die vergleichbare Groesse.

        Bilder werden aus fps x Fensterdauer gerechnet, nicht gezaehlt: der
        Sender haelt die Bildrate mit Duplikaten konstant (`stream_controller`),
        die Zahl ist also exakt und braucht keine zweite Quelle.
        """
        ns = fenster.get(f"{engine}_ns")
        if ns is None:
            return None
        bilder = fps * fenster["fenster_s"]
        return round(ns / bilder / 1000, 1) if bilder > 0 else None

    def summary(self, fenster: dict[str, float] | None, fps: int) -> str:
        if self._dev is None:
            return "  GPU-Last: kein amdgpu-Knoten, nicht gemessen"
        if fenster is None:
            return "  GPU-Last: zu wenige Proben"
        z = [
            f"  VCN-Encoder     {fenster.get('enc_util_pct', 0):6.2f} %   "
            f"{self.je_bild_us(fenster, 'enc', fps)} us/Bild",
        ]
        if "compute_util_pct" in fenster:
            z.append(
                f"  scale_vaapi     {fenster['compute_util_pct']:6.2f} %   "
                f"{self.je_bild_us(fenster, 'compute', fps)} us/Bild"
            )
        z.append(
            f"  (nachrangig, maschinenweit) GPU busy {fenster['gpu_busy_pct_mittel']} %, "
            f"{fenster['leistung_w_mittel']} W, {fenster['takt_mhz_mittel']:.0f} MHz"
        )
        return "\n".join(z)
