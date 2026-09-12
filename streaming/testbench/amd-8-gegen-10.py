#!/usr/bin/env python3
"""8 gegen 10 bit auf AMD — das Gegenstueck zur NVIDIA-Messreihe vom 2026-09-12
(docs/2026-09-12-av1-10bit-encoder-last.md), gefahren auf der 780M.

Zwei Ebenen, beide mit prozessgenauer Engine-Zeit aus DRM-fdinfo
(`amdgpuload.py`):

* Sender-Sonde: `av1_vaapi`-Encode (CBR, async_depth 1 — die Sidecar-Optionen)
  eines Testbilds. Kein echter Sidecar (der braucht Portal und Bildschirm) —
  die Frage ist nur, was der VCN-Encoder-Block selbst an 8-gegen-10-bit
  zulegt. Erreichte fps gegen die angeforderte Rate sagt, ob der Block folgt.
* Player-Lauf: `harness.py` schickt eine vorkodierte Datei (8 oder 10 bit)
  per `-c copy` ueber MediaMTX, der Player dekodiert auf der Karte. Gemessen:
  fps/kbps aus den Player-Statistiken plus `dec`/`gfx`-Engine-Zeit je Bild.

Vorlagen muessen fuer beide Bittiefen existieren:
  vorlage-amd-<punkt>-<8|10>bit.mkv (1920x1080@144, 2560x1440@144)
Sie werden sonst hier erzeugt (av1_vaapi, CBR 25M, 2-s-GOP, 30 s).

    ./amd-8-gegen-10.py --sender
    ./amd-8-gegen-10.py --player --secs 60
    ./amd-8-gegen-10.py --sender --player
"""

from __future__ import annotations

import argparse
import json
import os
import statistics as st
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
from amdgpuload import AmdGpuLoad  # noqa: E402

PUNKTE: dict[str, tuple[int, int, int]] = {
    "1080p144": (1920, 1080, 144),
    "1440p144": (2560, 1440, 144),
}
KBPS = 25000
DAUER_VORLAGE = 30.0


def ffmpeg_bremse() -> dict[str, str]:
    """Das SYSTEM-FFmpeg: der private Bau hat keinen lavfi-Eingang (Testbild-
    Quelle), und av1_vaapi beherrscht er ebenfalls (seit Mesa 26 problemlos).
    Der private Bau bleibt, wofuer er da ist: Player und Sidecar linken ihn."""
    return {"bin": "/usr/bin/ffmpeg", "env": {}}


def vorlage(punkt: str, bits: int) -> Path:
    b, h, fps = PUNKTE[punkt]
    p = HERE / f"vorlage-amd-{punkt}-{bits}bit.mkv"
    if p.exists():
        return p
    ff = ffmpeg_bremse()
    cmd = [
        ff["bin"], "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", f"testsrc2=size={b}x{h}:rate={fps}:duration={DAUER_VORLAGE}",
        "-vaapi_device", "/dev/dri/renderD128",
        "-vf", f"format={'p010le' if bits == 10 else 'nv12'},hwupload",
        "-c:v", "av1_vaapi", "-rc_mode", "CBR", "-async_depth", "1",
        "-g", str(fps * 2), "-b:v", f"{KBPS}k", str(p),
    ]
    print(f"[vorlage] {p.name} …")
    subprocess.run(cmd, check=True, env={"PATH": "/usr/bin:/bin", **ff["env"]})
    return p


def sender_lauf(punkt: str, bits: int, async_depth: int = 1) -> dict:
    """Encoder-Sonde: erreicht der VCN die angeforderte Rate, und was kostet
    ein Bild an Engine-Zeit?"""
    b, h, fps = PUNKTE[punkt]
    ff = ffmpeg_bremse()
    cmd = [
        ff["bin"], "-hide_banner", "-loglevel", "error", "-stats", "-y",
        "-f", "lavfi", "-i", f"testsrc2=size={b}x{h}:rate={fps}:duration={DAUER_VORLAGE}",
        "-vaapi_device", "/dev/dri/renderD128",
        "-vf", f"format={'p010le' if bits == 10 else 'nv12'},hwupload",
        "-c:v", "av1_vaapi", "-rc_mode", "CBR", "-async_depth", str(async_depth),
        "-g", str(fps * 2), "-b:v", f"{KBPS}k", "-f", "null", "-",
    ]
    p = subprocess.Popen(cmd, stderr=subprocess.PIPE, text=True,
                         env={"PATH": "/usr/bin:/bin", **ff["env"]})
    ab = time.monotonic()
    with AmdGpuLoad(p.pid) as g:
        _, err = p.communicate()
        bis = time.monotonic()
    if p.returncode != 0:
        return {"punkt": punkt, "bits": bits,
                "fehler": f"rc={p.returncode}: {err[-180:]}"}
    wand_s = bis - ab
    f = g.fenster(ab + 3, bis - 1)
    bilder = fps * DAUER_VORLAGE
    # Je BILD aus WANDzeit und Enc-Auslastung — NICHT aus `je_bild_us`: das
    # rechnet fps x Fensterdauer und setzt damit Echtzeitbetrieb voraus
    # (Sidecar). Diese Sonde laeuft schneller als Echtzeit, die Spalte waere
    # um den Beschleunigungsfaktor zu hoch.
    enc_ms = round((f or {}).get("enc_util_pct", 0) / 100 * wand_s / bilder * 1000, 2)
    return {
        "punkt": punkt, "bits": bits, "tiefe": async_depth,
        "wand_s": round(wand_s, 1),
        "erreichte_fps": round(bilder / wand_s, 1),
        "folgt": wand_s <= DAUER_VORLAGE * 1.05,
        "enc_pct": (f or {}).get("enc_util_pct", 0),
        "enc_ms_bild": enc_ms,
        "gfx_pct": (f or {}).get("gfx_util_pct", 0),
        "compute_pct": (f or {}).get("compute_util_pct", 0),
        "leistung_w": (f or {}).get("leistung_w_mittel", 0),
    }


def player_lauf(punkt: str, bits: int, run: int, secs: float) -> dict:
    """harness.py im Hintergrund, Player-PID suchen, Engine-Zeiten sammeln."""
    vorlage(punkt, bits)
    tag = f"amd810-{punkt}-{bits}bit-r{run}"
    # NICHT sys.executable: unter der ZCode-AppImage ist das die AppImage-
    # Huelle selbst — als Kindprozess gestartet laeuft deren Node-Starter
    # los (Protokoll-Fehler-Rauschen) statt Python, und der Harness stirbt
    # stumm. System-Python reicht: harness.py braucht nur stdlib.
    befehl = ["/usr/bin/python3", str(HERE / "harness.py"), "--secs", str(secs),
              "--label", tag, "--noaudio"]
    env = {**os.environ,
           "PULSE_HARNESS_SOURCE": str(HERE / f"vorlage-amd-{punkt}-{bits}bit.mkv")}
    p = subprocess.Popen(befehl, env=env, stdout=subprocess.DEVNULL,
                         stderr=subprocess.PIPE, text=True)
    # Auf den Player warten, dann Sampling-Fenster merken.
    pid = None
    fruehst = time.monotonic() + 45
    while pid is None and time.monotonic() < fruehst:
        try:
            out = subprocess.run(["pgrep", "-f", "pulse-player/target/release/pulse-player"],
                                 capture_output=True, text=True).stdout.split()
            pid = int(out[-1]) if out else None
        except (ValueError, IndexError):
            pid = None
        if pid is None:
            time.sleep(0.5)
    if pid is None:
        p.kill()
        ursache = (p.stderr.read() or "").strip()[-200:]
        return {"punkt": punkt, "bits": bits, "run": run,
                "fehler": f"Player nie gestartet: {ursache}"}
    ab = time.monotonic()
    with AmdGpuLoad(pid) as g:
        rc = p.wait()
        ursache = (p.stderr.read() or "").strip()[-200:]
        bis = time.monotonic()
    # Anlauf (ICE, Keyframes) abschneiden: Fenster = [ab+12, bis-2].
    f = g.fenster(ab + 12, bis - 2)
    probs = HERE / f"samples-{tag}.json"
    fps_med = kbps_med = 0.0
    if probs.exists():
        s = json.loads(probs.read_text())[2:]
        if s:
            fps_med = st.median(x.get("fps", 0) for x in s)
            kbps_med = st.median(x.get("kbps", 0) for x in s)
    return {
        "punkt": punkt, "bits": bits, "run": run, "rc": rc, "harness_err": ursache,
        "fps": round(fps_med, 1), "kbps": round(kbps_med),
        # Phoenix hat EINE VCN-Instanz mit unified Ring: fdinfo kennt kein dec,
        # die Dekodierzeit des Players landet im enc-Zaehler (am 2026-09-12 in
        # /proc/<pid>/fdinfo nachgesehen: nur gfx und enc). dec bleibt mit dabei
        # fuer Maschinen mit getrennten Dekoder-Ringen.
        "vcn_pct": (f or {}).get("enc_util_pct", 0),
        "vcn_us_bild": g.je_bild_us(f, "enc", int(fps_med) or 60) if f else None,
        "dec_pct": (f or {}).get("dec_util_pct", 0),
        "dec_us_bild": g.je_bild_us(f, "dec", int(fps_med) or 60) if f else None,
        "gfx_pct": (f or {}).get("gfx_util_pct", 0),
        "gfx_us_bild": g.je_bild_us(f, "gfx", int(fps_med) or 60) if f else None,
    }


def tabelle(rows: list[dict], titel: str) -> None:
    print(f"\n== {titel}")
    if not rows:
        print("  (nichts)")
        return
    spalten = [k for k in rows[0] if k != "fehler"]
    print("  " + "  ".join(f"{c:>14}" for c in spalten))
    for r in rows:
        print("  " + "  ".join(f"{str(r.get(c, '')):>14}" for c in spalten))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sender", action="store_true")
    ap.add_argument("--player", action="store_true")
    ap.add_argument("--secs", type=float, default=60.0)
    ap.add_argument("--wdh", type=int, default=2)
    a = ap.parse_args()
    if not (a.sender or a.player):
        a.sender = a.player = True

    if a.sender:
        rows = [sender_lauf(p, b, d)
                for p in PUNKTE for b in (8, 10) for d in (1, 2)]
        tabelle(rows, "Sender-Sonde: av1_vaapi-Encode, VCN-Block")
        (HERE / "samples-amd810-sender.json").write_text(json.dumps(rows, indent=1))

    if a.player:
        rows = []
        for run in range(1, a.wdh + 1):
            for punkt in PUNKTE:
                for bits in (8, 10):
                    r = player_lauf(punkt, bits, run, a.secs)
                    rows.append(r)
                    print(f"  {r}")
        tabelle(rows, "Player: 8 gegen 10 bit, VCN-Dekoder + Render")
        (HERE / "samples-amd810-player.json").write_text(json.dumps(rows, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
