#!/usr/bin/env python3
"""Sender-Messung OHNE Server: der echte Sidecar, Ziel ist eine Datei.

Warum es das neben `real-harness.py` braucht: der dortige Weg verlangt
MediaMTX, Redis und den auth-hook, und fuer die Ende-zu-Ende-Zahl zusaetzlich
den nativen Player. Die Fragen an den ENCODER — Latenz, Bildqualitaet,
GPU-Kosten — brauchen davon nichts. `channel.push_url` darf ein Dateipfad sein:
`encode::url_format_hint` liefert dafuer `None`, und der Muxer schreibt eine
Datei statt zu pushen. Damit laeuft die komplette Kette Portal -> PipeWire-
DMABUF -> hwmap -> scale_vaapi -> Encoder, nur der Netzweg fehlt.

Was hier NICHT messbar ist, und das ist wichtig: alles hinter dem Encoder.
`max_interleave_delta`, der Ton-Rueckstand im Muxer, `tcp_nodelay` — dafuer
braucht es ein echtes RTMPS-Ziel. Diese Datei beantwortet ausschliesslich
Encoder-Fragen.

Drei Achsen je Lauf:

* **Latenz** — die Zeile, die der Sidecar selbst je Sekunde schreibt
  ("Encode-Latenz: Einschieben bis Paket"). Nicht von aussen geschaetzt.
* **GPU-Kosten** — `amdgpuload.AmdGpuLoad`, pro Prozess ueber DRM-fdinfo, in
  Mikrosekunden VCN-Zeit je Bild.
* **Bildqualitaet** — `PULSE_DUMP_RAW` schreibt den Encoder-Eingang verlustfrei
  mit, `vmaf_common.measure_vmaf` vergleicht die Ausgabe dagegen. Der
  Mitschnitt liegt auf `~/.cache` und NICHT unter `/tmp` (das ist tmpfs, also
  Arbeitsspeicher — 180 Bilder bei 1440p sind rund 1 GB).

Wiederholungen sind Pflicht, nicht Zierde: Einzelmessungen beweisen bei
schwankenden Groessen nichts (s. `README.md`).

    ./datei-harness.py --codec av1 --secs 40 --qualitaet
    ./datei-harness.py --codec h264 --opts async_depth=1 --wiederholungen 3
"""

from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import subprocess
import sys
import threading
import time
from pathlib import Path

from amdgpuload import AmdGpuLoad
from vmaf_common import measure_vmaf, read_header

HERE = Path(__file__).resolve().parent
# Der Sidecar liegt seit 2026-07-29 im Baum (vorher eigenes Repo).
SIDECAR = Path(os.environ.get(
    "PULSE_LINUX_HQ_SIDECAR",
    HERE.parent / "linux-hq-sidecar/target/release/pulse-linux-hq-sidecar",
))
# Rohmitschnitte und Ausgabestroeme: echte Platte, nicht tmpfs.
ARBEIT = Path(os.environ.get("PULSE_MESS_DIR", Path.home() / ".cache/pulse-messung"))

# Anlauf, der aus jedem Fenster fliegt: Encoder-Init, erster Keyframe und die
# ersten Bilder, in denen die Ratenkontrolle noch einschwingt. Ohne diesen
# Schnitt ist jede Variante teurer und langsamer, als sie ist.
ANLAUF_S = 5.0
# Dieselbe Zahl als PROBENZAHL. Der Sidecar schreibt genau eine
# "Encode-Latenz"-Zeile je Sekunde — nur deshalb sind Sekunden und Proben hier
# dasselbe. Die Kopplung steht hier, damit sie nicht als Zufall gelesen wird.
ANLAUF_PROBEN = int(ANLAUF_S)
# Bilder fuer die Qualitaetsmessung. 180 ist die Vorgabe des Mitschnitts.
QUALITAETS_BILDER = 180
# Vorlauf, bevor der Rohmitschnitt beginnt. Die pts-Luecken des Anlaufs lagen
# gemessen alle in den ersten 3,2 s; 8 s halten dazu Abstand. Eine loechrige
# Referenz macht die Qualitaetszahl zu Zufall (s. `encode/raw_dump.rs`).
DUMP_VORLAUF_S = 8


def _binaer_kennung() -> str:
    """Groesse + Aenderungszeit des Sidecars.

    Ein Neubau MITTEN in einer Messreihe macht die Zahlen unvergleichbar
    und faellt sonst nicht auf — genau das ist am 2026-07-30 passiert.
    Die Kennung steht deshalb in jedem Lauf.
    """
    try:
        st = SIDECAR.stat()
        return f"{st.st_size}@{int(st.st_mtime)}"
    except OSError:
        return "?"


def _zahl(muster: str, text: str) -> list[float]:
    return [float(m) for m in re.findall(muster, text)]


def _pts_luecken(pts_datei: Path) -> int:
    """Wie oft der pts des Mitschnitts um mehr als 1 springt.

    Reine Diagnose — Spruenge verschieben die BildZUORDNUNG nicht (die laeuft
    ueber die Reihenfolge). Ein ploetzlicher Anstieg heisst, der getaktete Loop
    kam nicht mit, also Fremdlast im Lauf.
    """
    werte = [int(z.split()[0]) for z in pts_datei.read_text().splitlines()
             if z and not z.startswith("#")]
    return sum(1 for a, b in zip(werte, werte[1:]) if b - a != 1)



def lauf(codec: str, opts: str, secs: int, label: str, fps: int,
         qualitaet: bool) -> dict:
    ARBEIT.mkdir(parents=True, exist_ok=True)
    ziel = ARBEIT / f"strom-{label}.mkv"
    roh = ARBEIT / f"referenz-{label}.raw"
    pts_datei = roh.with_suffix(".pts")
    # EINE Zahl fuer beides: der Vorlauf, den der Sidecar ueberspringt, ist
    # genau der Versatz, den der Bildvergleich anwenden muss. Zwei Stellen
    # wuerden auseinanderlaufen und der Vergleich still Nachbarbilder messen.
    versatz = fps * DUMP_VORLAUF_S
    for f in (ziel, roh, pts_datei):
        f.unlink(missing_ok=True)

    try:
        env = dict(os.environ)
        env["PULSE_PORTAL_REUSE"] = "1"      # Restore-Token, kein Dialog
        env["PULSE_HQ_LOG"] = "info"
        if opts:
            env["PULSE_ENCODER_OPTS"] = opts
        else:
            env.pop("PULSE_ENCODER_OPTS", None)
        if qualitaet:
            env["PULSE_DUMP_RAW"] = str(roh)
            env["PULSE_DUMP_RAW_FRAMES"] = str(QUALITAETS_BILDER)
            env["PULSE_DUMP_RAW_SKIP"] = str(versatz)
        else:
            env.pop("PULSE_DUMP_RAW", None)

        p = subprocess.Popen(
            [str(SIDECAR)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, env=env, text=True, bufsize=1,
        )
        err: list[str] = []
        out: list[str] = []
        for strom, senke in ((p.stderr, err), (p.stdout, out)):
            threading.Thread(target=lambda s=strom, k=senke: [k.append(z.rstrip("\n")) for z in s],
                             daemon=True).start()

        # Op-Parameter liegen FLACH neben op/id (`proto.rs` sammelt "alles andere").
        # Ein {"params": {...}}-Wrapper wird als leeres params gelesen und der Op
        # lehnt mit "channel ist Pflicht" ab.
        p.stdin.write(json.dumps({
            "op": "start", "id": 1,
            "channel": {"push_url": str(ziel)},
            "overrides": {"codec": codec, "fps": fps, "resolution": "Native"},
            "show_cursor": True,
            "audio": {"mode": "Aus"},
        }) + "\n")
        p.stdin.flush()

        # Auf `live` warten, NICHT auf die start-Antwort: `start` antwortet sofort,
        # der Worker laeuft erst an. Wer das fuer fertig haelt und `stop` schickt,
        # bricht die Portal-Verhandlung ab (Falle aus `portal-grant.py`).
        frist = time.monotonic() + 40
        live_ab = None
        while time.monotonic() < frist:
            verbund = "\n".join(out)
            if '"state":"live"' in verbund:
                live_ab = time.monotonic()
                break
            if '"state":"error"' in verbund:
                break
            time.sleep(0.2)

        messung = None
        je_bild: dict[str, float | None] = {}
        if live_ab is not None:
            with AmdGpuLoad(p.pid) as gpu:
                time.sleep(secs)
                ende = time.monotonic()
            messung = gpu.fenster(live_ab + ANLAUF_S, ende)
            if messung:
                je_bild = {"vcn_us_je_bild": gpu.je_bild_us(messung, "enc", fps),
                           "csc_us_je_bild": gpu.je_bild_us(messung, "compute", fps)}

        p.stdin.write(json.dumps({"op": "stop", "id": 2}) + "\n")
        p.stdin.flush()
        try:
            p.wait(timeout=25)
        except subprocess.TimeoutExpired:
            p.kill()

        text = "\n".join(err)
        (ARBEIT / f"sidecar-{label}.log").write_text(text + "\n")

        avg = _zahl(r"avg_ms=([0-9.]+)", text)
        mx = _zahl(r"max_ms=([0-9.]+)", text)
        # Die ersten Sekunden gehoeren zum Anlauf und fliegen auch hier raus,
        # damit Latenz und GPU-Zahl dasselbe Fenster beschreiben.
        nutz = avg[ANLAUF_PROBEN:] or avg

        e: dict = {
            "label": label, "codec": codec, "opts": opts or "(Vorgabe)",
            "binaer": _binaer_kennung(),
            "fps_soll": fps, "live": live_ab is not None,
            "latenz_ms_median": round(statistics.median(nutz), 2) if nutz else None,
            "latenz_ms_ausschlag": round(max(mx[ANLAUF_PROBEN:] or mx), 2) if mx else None,
            "latenz_proben": len(nutz),
            "duplikate": sum(int(m) for m in re.findall(r"duplicates=(\d+)", text)),
            "bytes": ziel.stat().st_size if ziel.exists() else 0,
            # Unbekannte Encoder-Optionen sind ein HARTER Befund: die Variante hat
            # dann nicht gewirkt und die Zahl darf nicht gedeutet werden.
            "unbekannte_optionen": re.findall(r"unbekannt.*?key=\"([^\"]+)\"", text),
        }
        if messung:
            e["gpu"] = messung
            e.update(je_bild)

        if qualitaet and pts_datei.exists() and ziel.exists():
            pix, w, h = read_header(pts_datei)
            # Zuordnung über die REIHENFOLGE: Mitschnitt und Encoder bekommen im
            # selben Schleifendurchgang dasselbe Bild (`stream_controller.rs`:
            # `dump.note(...)` direkt vor `enc.send_hw(...)`). Referenzbild k ist
            # also Strombild `versatz + k`, unabhängig von pts-Lücken.
            e["bild_zuordnung"] = {"versatz_bilder": versatz,
                                   "pts_luecken": _pts_luecken(pts_datei)}
            try:
                e["bild"] = {k: round(v, 3) for k, v in measure_vmaf(
                    ziel, roh, pix, w, h, fps, QUALITAETS_BILDER,
                    dist_start=versatz).items()}
            except SystemExit as x:
                e["bild_fehler"] = str(x)
        # Rohmitschnitt sofort weg — 1 GB je Lauf summiert sich ueber eine Messreihe.
        return e
    finally:
        # Der Rohmitschnitt ist rund 1 GB je Lauf und der Ausgabestrom wird nur
        # fuer seine GROESSE gebraucht — beides muss weg, auch wenn oben etwas
        # geworfen hat. Sonst bleiben je abgebrochenem Lauf 995 MB liegen, und
        # weil das Label eindeutig ist, raeumt kein spaeterer Lauf sie weg.
        for f in (roh, pts_datei, ziel):
            f.unlink(missing_ok=True)



def main() -> int:
    a = argparse.ArgumentParser()
    a.add_argument("--codec", default="av1", choices=["av1", "h264"])
    a.add_argument("--opts", default="")
    a.add_argument("--secs", type=int, default=30)
    a.add_argument("--fps", type=int, default=60)
    a.add_argument("--label", default="")
    a.add_argument("--wiederholungen", type=int, default=1)
    a.add_argument("--qualitaet", action="store_true")
    n = a.parse_args()
    basis = n.label or f"{n.codec}-{(n.opts or 'vorgabe').replace('=', '').replace(',', '-')}"
    for i in range(n.wiederholungen):
        r = lauf(n.codec, n.opts, n.secs, f"{basis}-{i + 1}", n.fps, n.qualitaet)
        print(json.dumps(r, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
