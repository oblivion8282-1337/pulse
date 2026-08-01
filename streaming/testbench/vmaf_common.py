"""Gemeinsamer Code fuer die Offline-Sweeps (sweep-offline.py, sweep-resolution.py).

Beide vergleichen einen neu kodierten av1_nvenc-Strom per libvmaf gegen dieselbe
Referenz und unterscheiden sich nur darin, WAS zwischen Kodierung und Vergleich
zusaetzlich passiert (Preset vs. Skalierung). Dieses Modul buendelt den Teil, der
identisch ist.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

VMAF_MODEL = "/usr/share/model/vmaf_v0.6.1.json"


def _modell_param() -> str:
    """`:model=path=…` nur, wenn die Datei da ist — sonst leer.

    libvmaf ab 2.x traegt `vmaf_v0.6.1` EINGEBAUT; der Pfad ist eine
    Bequemlichkeit, keine Notwendigkeit. Auf Fedora liefert das Paket keine
    Modelldateien, und der fest verdrahtete Pfad liess dort jede
    Qualitaetsmessung scheitern (`libvmaf` bricht beim Filter-Init ab). Auf
    Arch, wo die Datei liegt, bleibt das Verhalten unveraendert — es wird
    weiterhin genau dieses Modell benutzt, damit Werte zwischen den Maschinen
    vergleichbar bleiben.
    """
    return f":model=path={VMAF_MODEL}" if Path(VMAF_MODEL).exists() else ""


def read_header(pts: Path) -> tuple[str, int, int]:
    kopf = pts.read_text().splitlines()[0]
    m = re.search(r"pix_fmt=(\S+)\s+size=(\d+)x(\d+)", kopf)
    if not m:
        raise SystemExit(f"{pts}: Kopfzeile unlesbar: {kopf}")
    return m.group(1), int(m.group(2)), int(m.group(3))


def run_ffmpeg(cmd: list[str], was: str) -> None:
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stderr[-1500:], file=sys.stderr)
        raise SystemExit(f"{was} fehlgeschlagen")


def encode_cmd(ref: Path, pix_fmt: str, w: int, h: int, fps: int, kbps: int,
                frames: int, out: Path, *, pre: list[str] = (),
                post: list[str] = (), codec: str = "av1_nvenc") -> list[str]:
    """Encode-Kommando in den Einstellungen des Sidecars. `pre` sitzt vor
    `-c:v` (Skalierungsfilter), `post` dahinter vor der Ausgabedatei
    (Preset/Variante) — Reihenfolge bewusst getrennt, weil beide Sweeps sie an
    unterschiedlicher Stelle brauchen.

    **Die Grundeinstellungen haengen am Encoder.** Bis 2026-08-01 standen hier
    fest die NVENC-Namen (`-tune ll -rc cbr -zerolatency -delay -b_ref_mode`);
    auf `av1_vaapi`/`h264_vaapi` gibt es die nicht, ffmpeg bricht damit ab. Die
    Frage "was kostet diese Encoder-Einstellung an Bildqualitaet" war auf AMD
    also gar nicht stellbar — dieselbe Luecke, die `amdgpuload.py` fuer die
    GPU-Last geschlossen hat. Die VAAPI-Seite spiegelt `encode/opts.rs`:
    `rc_mode=CBR` plus `async_depth=1`.
    """
    vaapi = codec.endswith("_vaapi")
    geraet: list[str] = []
    vorne = list(pre)
    if vaapi:
        basis = ["-rc_mode", "CBR", "-async_depth", "1"]
        geraet = ["-vaapi_device", os.environ.get("PULSE_VAAPI_DEVICE", "/dev/dri/renderD128")]
        # VAAPI encodiert aus einer GPU-Surface — die Rohbilder muessen erst
        # hinauf. Ein vorhandener `pre`-Filter (Aufloesungs-Sweep) wird davor
        # gehaengt statt ersetzt, sonst gewaenne das zweite `-vf` und die
        # Skalierung fiele still aus.
        if vorne[:1] == ["-vf"]:
            vorne = ["-vf", f"{vorne[1]},format=nv12,hwupload"] + vorne[2:]
        else:
            vorne = ["-vf", "format=nv12,hwupload"] + vorne
    else:
        basis = ["-tune", "ll", "-rc", "cbr",
                 "-b_ref_mode", "0", "-zerolatency", "1", "-delay", "0"]
    return [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *geraet,
        "-f", "rawvideo", "-pix_fmt", pix_fmt, "-s", f"{w}x{h}", "-r", str(fps),
        "-i", str(ref), "-frames:v", str(frames),
        *vorne,
        "-c:v", codec, *basis,
        "-b:v", f"{kbps}k", "-maxrate", f"{kbps}k",
        "-g", str(fps * 2),
        *post,
        str(out),
    ]


def measure_vmaf(enc: Path, ref: Path, pix_fmt: str, w: int, h: int, fps: int,
                  frames: int, dist_scale: str = "", dist_start: int = 0) -> dict[str, float]:
    """Vergleicht enc gegen ref per libvmaf (VMAF/PSNR/SSIM, gepoolt). `dist_scale`
    (z.B. "1920:1080:flags=lanczos") skaliert die kodierte Seite vor dem Vergleich
    hoch — fuer den Aufloesungs-Sweep; leer laesst sie unveraendert.

    `dist_start` verwirft die ersten N Bilder der KODIERTEN Seite, bevor
    verglichen wird. Gebraucht wird das, wenn die Referenz nicht bei Bild 0 des
    Stroms beginnt — beim Mitschnitt aus einem LAUFENDEN Sender (`PULSE_DUMP_RAW`)
    ist genau das der Fall.

    **Beide Seiten werden auf die Bildrate als Zeitbasis gesetzt und neu
    durchnummeriert** (`settb=1/fps,setpts=N`). Das ist nicht Kosmetik, sondern
    die Voraussetzung dafuer, dass ueberhaupt die richtigen Bilder verglichen
    werden: `libvmaf` paart ueber ZEITSTEMPEL, nicht ueber die Reihenfolge. Die
    beiden Eingaben liegen aber in verschiedenen Zeitbasen — die kodierte Seite
    in der ihres Containers (Matroska 1/1000), die Referenz als rohe Bildfolge
    in 1/fps. In 1/1000 sind 60 Bilder/s nicht darstellbar (16,666 ms), die
    Zeitstempel werden also gerundet, und die Rundung trifft nur EINE Seite.
    Dazu kommt beim Mitschnitt aus einem LAUFENDEN Sender, dass dessen pts
    wanduhr-abgeleitet sind und einzelne Werte fehlen (`pts_gaps`).

    **`settb` ist dabei der Teil, der zaehlt** — nur damit rechnet `setpts=N`
    exakt. Gemessen 2026-07-30 an einer Datei, die aus der Referenz selbst
    kodiert wurde (die Paarung MUSS also gleichmaessig hohe Werte liefern):

    | Graph | VMAF Mittel | VMAF min |
    |---|---|---|
    | ohne Umnummerierung | 79,85 | 51,13 |
    | `setpts=N/(fps*TB)` allein | 68,07 | 51,88 |
    | **`settb=1/fps,setpts=N`** | **93,19** | **92,00** |

    Ein zusammengebrochenes MINIMUM bei hohem Mittel ist die Signatur einer
    verrutschten Paarung — deshalb liefert diese Funktion `vmaf_min` mit zurueck.

    **Offen (2026-07-30):** mit `settb` ist das MITTEL eng und tragfaehig
    (+-0,5 VMAF ueber Wiederholungen), `vmaf_min` schwankt aber weiter zwischen
    15 und 99. Gelegentlich rutscht also noch ein einzelnes Bild. Verdacht:
    klemmt der Sender zwei Bilder auf denselben pts (`pts_clamps`), verwirft der
    Muxer eines, und ab da ist der Index um eins verschoben. Fuer gepoolte
    Aussagen reicht es; wer EINZELBILDER auswerten will, muss das erst klaeren
    (`compare-quality.py` paart inhaltsbasiert und waere der Ansatzpunkt).

    Der Effekt sieht NICHT wie ein Fehler aus, sondern wie ein schlechter
    Encoder: gemessen wurden fuer dieselbe Einstellung VMAF 15,5 / 47,5 / 41,7
    ueber drei Laeufe, und fuer eine reine Latenz-Aenderung, die den Bitstrom
    nachweislich byte-identisch laesst, ein Absturz auf 6.

    **Folge fuer aeltere Messakten:** die Offline-Sweeps
    (`sweep-offline.py`, `sweep-resolution.py`) vergleichen ebenfalls Rohvideo
    gegen eine kodierte Datei, waren also von derselben Fehlpaarung betroffen.
    Werte aus `profiles/bild-2026-07-27-*.json` sind mit neuen Laeufen **nicht
    vergleichbar**. Ein Vergleich ZWISCHEN Varianten derselben alten Reihe
    bleibt tragfaehig (alle litten gleich), aber die Streuung darin war
    kuenstlich erhoeht — eine Aussage der Form "die ganze Leiter liegt innerhalb
    von X VMAF" kann daran liegen, dass X das Rauschen der Fehlpaarung war.
    """
    with tempfile.TemporaryDirectory() as td:
        log = Path(td) / "vmaf.json"
        vor_skalierung = f"scale={dist_scale}," if dist_scale else ""
        versatz = f"trim=start_frame={dist_start}," if dist_start else ""
        takt = f"settb=1/{fps},setpts=N,"
        graph = (
            f"[0:v]{versatz}{takt}{vor_skalierung}format=yuv420p10le[d];"
            f"[1:v]{takt}format=yuv420p10le[r];"
            "[d][r]libvmaf=feature='name=psnr|name=float_ssim'"
            f"{_modell_param()}:log_path={log}:log_fmt=json"
        )
        cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-i", str(enc),
            "-f", "rawvideo", "-pix_fmt", pix_fmt, "-s", f"{w}x{h}", "-r", str(fps),
            "-i", str(ref),
            "-frames:v", str(frames), "-lavfi", graph, "-f", "null", "-",
        ]
        run_ffmpeg(cmd, "libvmaf")
        roh = json.loads(log.read_text())
        pooled = roh.get("pooled_metrics", {})
        e = {k: pooled.get(k, {}).get("mean", float("nan"))
             for k in ("vmaf", "psnr_y", "float_ssim")}
        # Wächter gegen die Fehlpaarung, s. Tabelle oben. Zusätzlich die Zahl
        # der Paare: weniger als angefordert heisst, eine Seite war kürzer.
        e["vmaf_min"] = pooled.get("vmaf", {}).get("min", float("nan"))
        e["paare"] = float(len(roh.get("frames", [])))
        return e
