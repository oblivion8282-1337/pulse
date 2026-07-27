#!/usr/bin/env python3
"""GPU-Last waehrend einer Messung — die dritte Achse neben Latenz und Bild.

Ohne sie ist die Frage "wie weit koennen wir den Encoder aufdrehen" nicht zu
beantworten: `preset`, `multipass` und die AQ-Schalter kosten **keine Latenz**,
sondern Rechenzeit. Die Grenze ist damit nicht die Verzoegerung, sondern der
Punkt, an dem die Karte bei 1440p144 oder 4K nicht mehr mitkommt — und der ist
nur messbar, nicht auszurechnen.

Zwei Quellen, weil keine allein reicht:

* `nvidia-smi dmon` — Auslastung in Prozent je Sekunde (`sm` = Shader,
  `enc` = Encoder-Block, `dec` = Decoder-Block). Der `enc`-Wert ist eine
  Auslastungs-Schaetzung des festen Encoder-Blocks; er sagt, wie nah man an
  dessen Decke ist.
* `nvidia-smi --query-gpu=encoder.stats.*` — was NVENC SELBST ueber seine
  Sitzungen meldet, inklusive eigener Durchschnittslatenz. Das ist die
  ehrlichste Zahl zur Encoder-Verzoegerung, weil sie nicht durch unsere
  Warteschlangen hindurch gemessen ist.

Auf dieser Maschine laeuft eine RTX 5080; auf allem ohne `nvidia-smi` faellt
die Messung still aus, statt den Prueflauf zu verhindern.

    from gpuload import GpuLoad
    with GpuLoad(Path("gpu-lauf.log")) as g:
        ...
    print(g.summary())
"""

from __future__ import annotations

import shutil
import subprocess
import threading
from pathlib import Path
from typing import TextIO


def available() -> bool:
    return shutil.which("nvidia-smi") is not None


class GpuLoad:
    """Sammelt Auslastung und NVENC-Eigenmeldung, bis der Block verlassen wird."""

    def __init__(self, log: Path, interval: float = 1.0) -> None:
        self.log = log
        self.interval = interval
        self.dmon: subprocess.Popen | None = None
        self._handle: TextIO | None = None
        self.samples: list[tuple[int, int, int]] = []   # (sm, enc, dec)
        self.nvenc: list[tuple[int, float, float]] = []  # (Sitzungen, fps, Latenz us)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def __enter__(self) -> GpuLoad:
        if not available():
            return self
        self._handle = self.log.open("w")
        self.dmon = subprocess.Popen(
            ["nvidia-smi", "dmon", "-s", "u", "-d", str(int(self.interval))],
            stdout=self._handle, stderr=subprocess.STDOUT, text=True,
        )
        self._thread = threading.Thread(target=self._poll_nvenc, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=3)
        if self.dmon is not None:
            self.dmon.terminate()
            try:
                self.dmon.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.dmon.kill()
            self._handle.close()
            self._read_dmon()

    def _poll_nvenc(self) -> None:
        felder = (
            "encoder.stats.sessionCount,encoder.stats.averageFps,"
            "encoder.stats.averageLatency"
        )
        while not self._stop.wait(self.interval):
            try:
                out = subprocess.run(
                    ["nvidia-smi", f"--query-gpu={felder}", "--format=csv,noheader,nounits"],
                    capture_output=True, text=True, timeout=3,
                ).stdout.strip()
            except (subprocess.SubprocessError, OSError):
                continue
            teile = [t.strip() for t in out.split(",")]
            if len(teile) == 3:
                try:
                    self.nvenc.append((int(teile[0]), float(teile[1]), float(teile[2])))
                except ValueError:
                    continue

    def _read_dmon(self) -> None:
        for zeile in self.log.read_text().splitlines():
            if zeile.startswith("#"):
                continue
            teile = zeile.split()
            # gpu sm mem enc dec jpg ofa — bei aelteren Treibern ohne jpg/ofa.
            if len(teile) >= 5 and all(t.lstrip("-").isdigit() for t in teile[:5]):
                self.samples.append((int(teile[1]), int(teile[3]), int(teile[4])))

    def summary(self) -> str:
        if not available():
            return "  GPU-Last: kein nvidia-smi, nicht gemessen"
        zeilen = []
        # Die ersten zwei Proben sind Aufbau (Encoder-Sitzung entsteht erst).
        nutz = self.samples[2:]
        if nutz:
            for name, i in (("sm", 0), ("enc", 1), ("dec", 2)):
                werte = [s[i] for s in nutz]
                zeilen.append(
                    f"  GPU {name:3s} %             min {min(werte):9d}  "
                    f"mittel {sum(werte) / len(werte):9.1f}  max {max(werte):9d}"
                )
        aktiv = [n for n in self.nvenc[2:] if n[0] > 0]
        if aktiv:
            fps = [n[1] for n in aktiv]
            lat = [n[2] for n in aktiv]
            zeilen.append(
                f"  NVENC eigene Meldung    fps {sum(fps) / len(fps):9.1f}  "
                f"Latenz {sum(lat) / len(lat) / 1000:.2f} ms (max {max(lat) / 1000:.2f})"
            )
        return "\n".join(zeilen) if zeilen else "  GPU-Last: keine Proben"
