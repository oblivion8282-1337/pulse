#!/usr/bin/env python3
"""Ende-zu-Ende-Pruefung des Mitschnitts — gegen einen LEBENDEN Strom.

Der offene Punkt von 2026-09-15 („E2E-Mitschnitt gegen einen lebenden Strom
ungeprueft, der Sender starb bei jedem Versuch") war nicht mit dem Pruefstand
allein zu schliessen: genau hier kamen 2026-09-27 beide Aufnahme-Fehler ans
Licht (Ton-Stempel-Kollisionen im MPEG-TS, Leerdateien nach Kurz-Aufnahme).

Ablauf je Lauf: Token minten, Quelle per RTMPS (H.264/AV1) oder WHIP
(H.264+Opus, der Weg des echten Senders) nach MediaMTX pushen, Player per
stdio oeffnen, `record` 8 s laufen lassen, `stop_record`, Datei mit ffprobe
und einem Dekodiervollzug pruefen; danach Clip und Kurz-Aufnahme.

    ./aufnahme-e2e.py synth-h264-whip.mkv whip h264
    ./aufnahme-e2e.py synth-av1.mkv rtmps av1

Die Vorlagen bewusst NICHT hier erzeugt — beide muessen dem Sender aehneln,
sonst misst man die Vorlage: H.264 ohne B-Frames (MediaMTX reisst WHEP sonst
ab: „WebRTC doesn't support H264 streams with B-frames") mit Opus in Stereo
(der WHIP-Muxer lehnt Mono ab), AV1 mit 2-s-GOP:

    ffmpeg -f lavfi -i testsrc2=s=1280x720:r=30 -f lavfi -i sine=...:sample_rate=48000 \
      -t 120 -ac 2 -c:v libx264 -tune zerolatency -bf 0 -g 60 -keyint_min 60 \
      -sc_threshold 0 -pix_fmt yuv420p -b:v 3000k -c:a libopus -b:a 96k \
      -application lowdelay synth-h264-whip.mkv
    ffmpeg -f lavfi -i testsrc2=s=1280x720:r=30 -t 120 -c:v libsvtav1 \
      -preset 12 -crf 35 -g 60 -sc_threshold 0 -b:v 0 -an synth-av1.mkv

Kein Messwerkzeug: es prueft Funktion (Datei entsteht, laeuft die volle
Spanne, ist dekodierbar), keine Zahlen.
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from harness import Player, mint_tokens, warte_auf_strom  # noqa: E402

AUFNAHMEN = Path("/tmp/pulse-aufnahme-e2e")


def sh(cmd: list[str]) -> str:
    return subprocess.run(cmd, capture_output=True, text=True).stdout.strip()


def ffprobe(pfad: Path) -> dict:
    out = sh(["ffprobe", "-v", "error", "-show_entries",
              "format=duration:stream=codec_name,codec_type",
              "-of", "json", str(pfad)])
    return json.loads(out) if out else {}


def dekodierbar(pfad: Path) -> tuple[bool, str]:
    r = subprocess.run(["ffmpeg", "-v", "error", "-xerror", "-i", str(pfad),
                        "-f", "null", "-"], capture_output=True, text=True)
    return r.returncode == 0, r.stderr.strip()[-400:]


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    quelle = Path(sys.argv[1])
    proto = sys.argv[2]
    label = sys.argv[3] if len(sys.argv) > 3 else quelle.stem
    AUFNAHMEN.mkdir(parents=True, exist_ok=True)
    for alt in AUFNAHMEN.glob(f"{label}-*"):
        alt.unlink()

    path, pub, rd = mint_tokens()
    whep = f"http://localhost:8889/{path}/whep?token={rd}"
    print(f"[{label}] Pfad {path}, Proto {proto}")

    if proto == "rtmps":
        push_url = f"rtmps://localhost:1936/{path}?token={pub}"
        fmt = ["-f", "flv", "-tls_verify", "0"]
    else:
        push_url = f"http://localhost:8889/{path}/whip?token={pub}"
        fmt = ["-f", "whip"]
    push_log = open(HERE / f"push-{label}.log", "w")
    push = subprocess.Popen(
        ["ffmpeg", "-hide_banner", "-loglevel", "warning",
         "-re", "-stream_loop", "-1", "-i", str(quelle), "-c", "copy", *fmt, push_url],
        stdout=push_log, stderr=push_log)
    if not warte_auf_strom(path, push):
        return 1

    player_log = open(HERE / f"player-{label}.log", "w")
    player = Player(player_log)
    fehler = 0
    try:
        res = player.call("open", url=whep, title=f"Aufnahme-E2E {label}")
        if not res.get("ok"):
            print(f"[{label}] OPEN FEHLGESCHLAGEN: {res}")
            return 1
        sid = res["session"]

        # Warten bis Bilder fliessen, hoechstens 20 s.
        deadline = time.monotonic() + 20
        frames = 0
        while time.monotonic() < deadline:
            frames = player.call("stats", session=sid).get("frames_presented", 0)
            if frames > 60:
                break
            time.sleep(0.5)
        s = player.call("stats", session=sid)
        print(f"[{label}] decoder={s.get('decoder')} hw={s.get('hardware_decode')} "
              f"frames_presented={s.get('frames_presented')} state={s.get('state')}")
        if frames <= 60:
            print(f"[{label}] ABBRUCH: keine Bilder ({frames}) — siehe player-Log")
            return 1

        # 1) Aufnahme: 8 s laufen lassen (GOP der Vorlagen ist 2 s — das
        #    Keyframe-Gate fuer den Aufnahmebeginn traegt also auf jeden Fall).
        ziel = AUFNAHMEN / f"{label}-aufnahme"
        t0 = time.monotonic()
        r = player.call("record", session=sid, path=str(ziel), timeout=20)
        print(f"[{label}] record: {json.dumps(r, ensure_ascii=False)}")
        fehler += 0 if r.get("ok") else 1
        time.sleep(8)
        r2 = player.call("stop_record", session=sid, timeout=20)
        print(f"[{label}] stop_record nach {time.monotonic() - t0:.1f}s: "
              f"{json.dumps(r2, ensure_ascii=False)}")
        fehler += 0 if r2.get("ok") else 1

        datei = Path(r.get("path", str(ziel)))
        if not datei.exists():
            datei = next(AUFNAHMEN.glob(f"{label}-aufnahme.*"), datei)
        if datei.exists():
            info = ffprobe(datei)
            streams = [(x.get("codec_type"), x.get("codec_name")) for x in info.get("streams", [])]
            ok, err = dekodierbar(datei)
            dauer = float(info.get("format", {}).get("duration", 0))
            print(f"[{label}] DATEI {datei.name}: {datei.stat().st_size} Bytes, "
                  f"Dauer {dauer:.2f}s, Spuren {streams}, dekodierbar={ok}")
            fehler += 0 if ok and dauer > 4 else 1
            if not ok:
                print(f"[{label}] DECODE-FEHLER: {err}")
        else:
            print(f"[{label}] KEINE DATEI entstanden")
            fehler += 1

        # 2) Clip der letzten 5 s aus dem Ringpuffer (beginnt am letzten
        #    Keyframe davor — etwas laenger als 5 s ist korrekt).
        cziel = AUFNAHMEN / f"{label}-clip"
        rc = player.call("clip", session=sid, path=str(cziel), seconds=5, timeout=30)
        print(f"[{label}] clip: {json.dumps(rc, ensure_ascii=False)}")
        fehler += 0 if rc.get("ok") else 1
        cdatei = Path(rc.get("path", str(cziel)))
        if not cdatei.exists():
            cdatei = next(AUFNAHMEN.glob(f"{label}-clip.*"), cdatei)
        if cdatei.exists():
            ok, err = dekodierbar(cdatei)
            dauer = float(ffprobe(cdatei).get("format", {}).get("duration", 0))
            print(f"[{label}] CLIP {cdatei.name}: {cdatei.stat().st_size} Bytes, "
                  f"Dauer {dauer:.2f}s, dekodierbar={ok}")
            fehler += 0 if ok and dauer > 4 else 1
            if not ok:
                print(f"[{label}] CLIP-DECODE-FEHLER: {err}")
        else:
            print(f"[{label}] KEIN CLIP entstanden")
            fehler += 1

        # 3) Kurz-Aufnahme: Stopp VOR dem ersten Keyframe. Erwartet: Fehler
        #    „nichts aufgenommen" UND keine liegengebliebene Leerdatei.
        kziel = AUFNAHMEN / f"{label}-kurz"
        rk = player.call("record", session=sid, path=str(kziel), timeout=20)
        time.sleep(0.3)
        rk2 = player.call("stop_record", session=sid, timeout=20)
        print(f"[{label}] kurz-aufnahme: start={rk.get('ok')} "
              f"stop={json.dumps(rk2, ensure_ascii=False)}")
        fehler += 0 if rk2.get("ok") is False else 1
        liegen = list(AUFNAHMEN.glob(f"{label}-kurz.*"))
        if liegen:
            print(f"[{label}] FEHLER: Leerdatei liegengeblieben: "
                  f"{[k.name for k in liegen]}")
            fehler += 1
    finally:
        player.stop()
        push.send_signal(2)
        try:
            push.wait(timeout=5)
        except subprocess.TimeoutExpired:
            push.kill()
        player_log.close()
        push_log.close()
    print(f"[{label}] {'GRUEN' if fehler == 0 else f'{fehler} FEHLER'}")
    return 1 if fehler else 0


if __name__ == "__main__":
    sys.exit(main())
