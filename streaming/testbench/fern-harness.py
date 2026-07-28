#!/usr/bin/env python3
"""Prüfstand gegen einen ECHTEN Server über die echte Leitung.

Wie ``real-harness.py``, nur zeigen Token, Push-Ziel und WHEP-Adresse auf einen
entfernten Server statt auf die lokale Schleife. Das ist der einzige Aufbau, der
misst, was ein Nutzer tatsächlich erlebt.

**Warum es das braucht.** Am 2026-07-27 lag die Kette lokal bei 16,3 ms und über
die echte Leitung bei 143 — bei nur 26,7 ms Laufzeit. Rund 100 ms entstehen also
irgendwo, was auf der Schleife per Konstruktion unsichtbar bleibt: dort gibt es
keine Laufzeit, keine Schwankung und keinen Verlust. Jede Aussage über Latenz,
die nur auf der Schleife erhoben wurde, sagt über den Betrieb wenig.

**Voraussetzungen.** SSH-Zugang zum Server ohne Passwort, dort Docker-Zugriff,
und der Pulse-Container heisst wie in ``PULSE_FERN_CONTAINER`` angegeben. Die
Token werden per ``docker exec … redis-cli`` direkt in die Redis DES CONTAINERS
gelegt — media-svc ist bewusst nicht im Spiel, der Prüfstand baut die Adresse
selbst (genau deshalb kann er auch Protokolle fahren, die media-svc gar nicht
ausgibt).

    ./fern-harness.py --secs 30 --fps 60 --kbps 4000 --e2e --label fern1
    ./fern-harness.py --proto srt --codec h264 --bits 8 --label srt1

**SRT trägt kein AV1.** MPEG-TS hat für AV1 keine reguläre Zuordnung; ffmpeg
schreibt es als „private data stream", MediaMTX erkennt es nicht, und beim
Zuschauer kommt nur Ton an. Für SRT-Läufe also ``--codec h264``.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import subprocess
import sys
import time

from gpuload import GpuLoad
from harness import CID, HERE, Player, token_payloads

# `real-harness.py` trägt einen Bindestrich und ist deshalb nicht importierbar —
# der Sidecar-Wrapper wird nachgeladen statt kopiert.
_spec = importlib.util.spec_from_file_location("rh", HERE / "real-harness.py")
_rh = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_rh)
Sidecar = _rh.Sidecar

HOST = os.environ.get("PULSE_FERN_HOST", "pulse.unicutmedia.com")
SSH = os.environ.get("PULSE_FERN_SSH", "michael@77.42.71.166")
CONTAINER = os.environ.get("PULSE_FERN_CONTAINER", "pulse")
RTMPS_PORT = int(os.environ.get("PULSE_FERN_RTMPS_PORT", "1936"))
# MediaMTX lauscht per Voreinstellung auf 8890 — der Container veröffentlicht
# diesen Port aber nicht, und einen Port nachträglich zu veröffentlichen ginge
# nur durch Neuerstellen des Containers. Ausweg: MediaMTX auf einen bereits
# veröffentlichten, aber unbenutzten Port legen (`srtAddress: :7890`; der
# LiveKit-Bereich 7882-7892 ist auf der Testinstanz nach aussen offen und innen
# leer, weil dort kein LiveKit läuft).
SRT_PORT = int(os.environ.get("PULSE_FERN_SRT_PORT", "7890"))


def redis_set_remote(pairs: list[tuple[str, str]], ttl: int = 1800) -> None:
    """Token in die Redis IM Container legen — ein SSH-Aufruf für alle."""
    cmds = "\n".join(f"SET {k} '{v}' EX {ttl}" for k, v in pairs)
    r = subprocess.run(
        ["ssh", "-o", "BatchMode=yes", SSH,
         f"docker exec -i {CONTAINER} redis-cli <<'EOF'\n{cmds}\nEOF"],
        capture_output=True, text=True, timeout=60,
    )
    if r.returncode != 0:
        raise RuntimeError(f"redis-set fehlgeschlagen: {r.stderr.strip()}")
    if "OK" not in r.stdout:
        raise RuntimeError(f"redis antwortete unerwartet: {r.stdout.strip()}")


def mint_remote() -> tuple[str, str, str]:
    """(mediamtx-Pfad, publish-token, read-token) — Payload-Schema aus ``harness.py``,
    nur die Ablage geht per SSH in die Redis DES ENTFERNTEN Containers statt lokal."""
    path, pub, rd, pub_payload, rd_payload = token_payloads()
    redis_set_remote([
        (f"stream:token:{pub}", json.dumps(pub_payload)),
        (f"stream:token:{rd}", json.dumps(rd_payload)),
    ])
    return path, pub, rd


def push_url(path: str, token: str, proto: str, srt_latency_ms: int) -> str:
    if proto == "whip":
        # Eigener WebRTC-Sendeweg des Sidecars. Der Weg durch Caddy ist derselbe
        # wie beim Zuschauen: `handle_path /whep/*` streift das Praefix ab, und
        # MediaMTX sieht `/<pfad>/whip`. Ton laeuft darueber noch nicht.
        return f"https://{HOST}/whep/{path}/whip?token={token}"
    if proto == "srt":
        return (f"srt://{HOST}:{SRT_PORT}?streamid=publish:{path}:pulse:{token}"
                f"&pkt_size=1316&latency={srt_latency_ms * 1000}")
    return f"rtmps://{HOST}:{RTMPS_PORT}/{path}?token={token}"


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser()
    ap.add_argument("--secs", type=float, default=30.0)
    ap.add_argument("--fps", type=int, default=60)
    ap.add_argument("--kbps", type=int, default=4000)
    ap.add_argument("--codec", default="av1", help="av1 oder h264 (SRT nur h264)")
    ap.add_argument("--bits", type=int, default=10)
    ap.add_argument("--audio", default="Desktop", help='"Desktop" oder "Aus"')
    ap.add_argument("--e2e", action="store_true",
                    help="Zeitmuster anzeigen und im Player zurücklesen")
    ap.add_argument("--proto", default="rtmps", choices=["rtmps", "srt", "whip"])
    ap.add_argument("--srt-latency-ms", type=int, default=120,
                    help="SRT-Puffer. Voreinstellung 120 wie bei SRT selbst; "
                         "am 2026-07-27 gemessen, dass 40 praktisch nichts ändert "
                         "— die ~300 ms des SRT-Wegs kommen NICHT von hier.")
    ap.add_argument("--label", default="fern")
    return ap.parse_args()


def main() -> int:
    args = parse_args()
    tag = args.label
    send_log = open(HERE / f"send-{tag}.log", "w")
    player_log = open(HERE / f"player-{tag}.log", "w")

    pattern = None
    player_env: dict[str, str] = {}
    if args.e2e:
        epoch = str(int(time.time() * 1000))
        pattern_log = open(HERE / f"pattern-{tag}.log", "w")
        pattern = subprocess.Popen(
            [sys.executable, str(HERE / "latency-pattern.py")],
            env={**os.environ, "PULSE_LATENCY_EPOCH_MS": epoch},
            stdout=pattern_log, stderr=pattern_log,
        )
        time.sleep(2.0)
        if pattern.poll() is not None:
            print("Zeitmuster startete nicht — siehe pattern-Log", file=sys.stderr)
            return 1
        player_env = {"PULSE_PLAYER_LATENCY_PROBE": "1",
                      "PULSE_PLAYER_LATENCY_EPOCH_MS": epoch}

    path, pub, rd = mint_remote()
    whep = f"https://{HOST}/whep/{path}/whep?token={rd}"
    push = push_url(path, pub, args.proto, args.srt_latency_ms)
    print(f"[{tag}] {args.proto} -> {HOST}   Pfad {path}")

    sender = Sidecar(send_log, {})
    player = None
    sid = None
    samples: list[dict] = []
    gpu = GpuLoad(HERE / f"gpu-{tag}.log")
    try:
        gpu.__enter__()
        res = sender.call(
            "start",
            channel={"id": CID, "token": pub, "push_url": push},
            capture="portal",
            audio={"mode": args.audio},
            overrides={"codec": args.codec, "fps": args.fps,
                       "bitrate_kbps": args.kbps, "bit_depth": args.bits},
        )
        if not res.get("ok"):
            print(f"start fehlgeschlagen: {res}", file=sys.stderr)
            return 1
        # Über die echte Leitung dauert Publish + Auth länger als lokal; mit 4 s
        # (dem Wert aus real-harness.py) war der Player gelegentlich früher da
        # als der Strom.
        time.sleep(6.0)

        player = Player(player_log, player_env)
        res = player.call("open", url=whep, title=f"Fern {tag}", timeout=30)
        if not res.get("ok"):
            print(f"open fehlgeschlagen: {res}", file=sys.stderr)
            return 1
        sid = res["session"]
        end = time.monotonic() + args.secs
        while time.monotonic() < end:
            time.sleep(1.0)
            s = player.call("stats", session=sid)
            if s.get("ok"):
                samples.append(s)
    finally:
        gpu.__exit__()
        if player is not None:
            if sid:
                try:
                    player.call("close", session=sid)
                except Exception as e:
                    print(f"close: {e}", file=sys.stderr)
            player.stop()
        sender.stop()
        if pattern is not None:
            pattern.terminate()
        send_log.close()
        player_log.close()

    (HERE / f"samples-{tag}.json").write_text(json.dumps(samples, indent=1))
    print(f"[{tag}] {len(samples)} Proben")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
