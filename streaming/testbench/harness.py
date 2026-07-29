#!/usr/bin/env python3
"""Prüfstand für den nativen HQ-Player — ohne App, ohne Portal, ohne Klick.

Legt Publish-/Read-Token selbst in Redis ab (Schema aus
``dcc_media_svc/streamkeys.py``), pusht eine vorkodierte 10-bit-AV1-Datei per
``-c copy`` nach MediaMTX (also ein exakt gleichmäßiger Referenzsender, ganz
ohne unser Sidecar), öffnet den Player über seine stdio-Schnittstelle und
sammelt die Messwerte per ``stats``-Operation ein.

Damit ist der Empfangsweg allein messbar: bündelt es auch hier in Schüben,
liegt es an MediaMTX oder am Player — nicht am Sender.

    ./harness.py                 # mit Ton
    ./harness.py --noaudio       # ohne Ton (Gegenprobe)
    ./harness.py --secs 20
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

HERE = Path(__file__).parent
# Ueberschreibbar, weil die STRUKTUR der Vorlage das Ergebnis veraendert:
# `synth10.mkv` ist mit av1_nvenc-Datei-Defaults kodiert und enthaelt
# Alt-Ref-Bilder (rund die Haelfte aller Zugriffseinheiten sind reine
# "zeige vorhandenes Bild"-Header). Der Live-Sidecar kodiert mit
# `zerolatency=1`/`delay=0`/`b_ref_mode=0` und erzeugt sie nicht. Wer Befunde
# auf den Livebetrieb uebertragen will, braucht eine Vorlage mit den
# Live-Einstellungen — sonst misst er die Vorlage statt den Player.
SOURCE = Path(os.environ.get("PULSE_HARNESS_SOURCE", HERE / "synth10.mkv"))
# Pfade ueber die Umgebung ueberschreibbar — der Sidecar liegt in einem
# EIGENEN Repo, dessen Ort je Maschine abweicht.
PLAYER = Path(os.environ.get(
    "PULSE_PLAYER_BIN",
    Path(__file__).resolve().parents[1] / "pulse-player/target/release/pulse-player",
))
REDIS = "redis://localhost:6380/0"
# API des lokalen MediaMTX — nur um abzuwarten, ob ein Pfad bereit ist.
MEDIAMTX_API = "http://localhost:9997/v3/paths/list"
CID = "100000000000000001"
UID = "200000000000000002"


def redis_set(key: str, value: str, ttl: int = 900) -> None:
    subprocess.run(
        ["redis-cli", "-u", REDIS, "SET", key, value, "EX", str(ttl)],
        check=True, stdout=subprocess.DEVNULL,
    )


def token_payloads() -> tuple[str, str, str, dict, dict]:
    """(mediamtx-Pfad, publish-token, read-token, publish-payload, read-payload).

    Das Schema, das ``mint_tokens`` unten (lokales ``redis-cli``) UND
    ``fern-harness.py::mint_remote`` (SSH-Batch in die Redis eines entfernten
    Containers) teilen — nur wie die beiden Payloads gespeichert werden,
    unterscheidet sich zwischen den beiden.
    """
    nonce = secrets.token_hex(16)
    pub, rd = secrets.token_hex(16), secrets.token_hex(16)
    base = {"channel_id": CID, "user_id": UID, "nonce": nonce,
            "created_at": datetime.now(UTC).isoformat()}
    pub_payload = {**base, "scope": "publish", "protocol": "rtmps", "ten_bit": True}
    rd_payload = {**base, "scope": "read", "protocol": "webrtc"}
    return f"channel-{CID}-{UID}-{nonce}", pub, rd, pub_payload, rd_payload


def mint_tokens() -> tuple[str, str, str]:
    """(mediamtx-Pfad, publish-token, read-token)."""
    path, pub, rd, pub_payload, rd_payload = token_payloads()
    redis_set(f"stream:token:{pub}", json.dumps(pub_payload))
    redis_set(f"stream:token:{rd}", json.dumps(rd_payload))
    return path, pub, rd


def start_push(path: str, token: str, audio: bool, log, extra: list[str] | None = None) -> subprocess.Popen:
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "warning",
        "-re", "-stream_loop", "-1", "-i", str(SOURCE),
        "-c", "copy",
    ]
    cmd += extra or []
    if not audio:
        cmd.append("-an")
    cmd += ["-f", "flv", "-tls_verify", "0", f"rtmps://localhost:1936/{path}?token={token}"]
    return subprocess.Popen(cmd, stdout=log, stderr=log)


def warte_auf_strom(path: str, push: subprocess.Popen, timeout: float = 45.0) -> bool:
    """Wartet, bis MediaMTX den Pfad als bereit meldet.

    Vorher stand hier ein festes ``sleep(3)``. Das reichte auf der ungestoerten
    Schleife und **nur dort**: sobald `netz-harness.py` 26,7 ms Laufzeit auflegt,
    braucht der RTMPS-Aufbau rund fuenf Sekunden laenger, der Player oeffnet WHEP
    zu frueh, MediaMTX antwortet `no stream is available` — und die Messung sieht
    aus, als haette der Player unter Last versagt. Am 2026-07-28 genau so
    passiert; fast jeder gestoerte Lauf lieferte "keine Messwerte", und der
    Grund lag im Pruefstand, nicht im Player.

    Gefragt wird die MediaMTX-API statt laenger zu schlafen: eine feste Wartezeit
    ist immer entweder zu kurz oder Zeitverschwendung.
    """
    ende = time.monotonic() + timeout
    while time.monotonic() < ende:
        if push.poll() is not None:
            print("Sender ist gestorben — siehe push-Log", file=sys.stderr)
            return False
        try:
            with urllib.request.urlopen(MEDIAMTX_API, timeout=2) as r:
                daten = json.load(r)
            if any(p.get("name") == path and p.get("ready") for p in daten.get("items", [])):
                return True
        except (urllib.error.URLError, json.JSONDecodeError, TimeoutError):
            pass  # MediaMTX noch nicht erreichbar — weiter warten
        time.sleep(0.5)
    print(f"Strom wurde in {timeout:.0f}s nicht bereit — siehe push-Log", file=sys.stderr)
    return False


class Player:
    def __init__(self, log, env_extra: dict | None = None) -> None:
        env = {**os.environ, "PULSE_PLAYER_STATS_LOG": "1", "RUST_LOG": "info",
               **(env_extra or {})}
        self.p = subprocess.Popen(
            [str(PLAYER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=log, env=env, text=True, bufsize=1,
        )
        self.next_id = 1

    def call(self, op: str, timeout: float = 15.0, **kw) -> dict:
        rid = self.next_id
        self.next_id += 1
        self.p.stdin.write(json.dumps({"op": op, "id": rid, **kw}) + "\n")
        self.p.stdin.flush()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            line = self.p.stdout.readline()
            if not line:
                raise RuntimeError("Player hat stdout geschlossen")
            msg = json.loads(line)
            if msg.get("id") == rid:
                return msg
        raise TimeoutError(f"keine Antwort auf {op}")

    def stop(self) -> None:
        try:
            self.call("shutdown", timeout=5)
        except Exception:
            pass
        try:
            self.p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.p.send_signal(signal.SIGKILL)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--noaudio", action="store_true")
    ap.add_argument("--secs", type=float, default=15.0)
    ap.add_argument("--label", default="")
    ap.add_argument("--extra", default="", help="zusaetzliche ffmpeg-Ausgabeoptionen")
    # Der Decoder-Weg muss von aussen festnagelbar sein: am 2026-07-29 stirbt
    # der Player unter Paketverlust reproduzierbar mit SIGSEGV in libnvcuvid
    # (vier von vier Laeufen, Backtrace ueber avcodec_send_packet). Ob das an
    # NVIDIAs Decoder haengt oder an unserer Einspeisung, ist nur mit der
    # Gegenprobe zu trennen — und ohne diesen Schalter braucht sie einen
    # Umbau des Players.
    ap.add_argument("--hwdec", choices=("auto", "hw", "sw"), default="auto",
                    help="Decoder erzwingen: hw = nur GPU, sw = nur Software")
    args = ap.parse_args()
    audio = not args.noaudio

    if not SOURCE.exists():
        print(f"Vorlage fehlt: {SOURCE}", file=sys.stderr)
        return 1

    tag = args.label or ("mit-ton" if audio else "ohne-ton")
    push_log = open(HERE / f"push-{tag}.log", "w")
    player_log = open(HERE / f"player-{tag}.log", "w")

    path, pub, rd = mint_tokens()
    whep = f"http://localhost:8889/{path}/whep?token={rd}"
    print(f"[{tag}] Pfad {path}")

    push = start_push(path, pub, audio, push_log, args.extra.split() if args.extra else None)
    if not warte_auf_strom(path, push):
        return 1

    player = Player(player_log)
    samples: list[dict] = []
    try:
        optionen = {"auto": {}, "hw": {"hwdec": True}, "sw": {"hwdec": False}}[args.hwdec]
        res = player.call("open", url=whep, title=f"Pruefstand {tag}", options=optionen)
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
        player.stop()
        push.send_signal(signal.SIGINT)
        try:
            push.wait(timeout=5)
        except subprocess.TimeoutExpired:
            push.kill()
        push_log.close()
        player_log.close()

    # Die ersten zwei Sekunden sind Aufbau (ICE, erste Keyframes) — weglassen.
    useful = samples[2:]
    if not useful:
        print("keine Messwerte", file=sys.stderr)
        return 1

    def col(name: str) -> list[float]:
        return [float(s.get(name, 0) or 0) for s in useful]

    print(f"[{tag}] {len(useful)} Proben")
    for name in ("fps", "kbps", "frames_presented", "frames_never_drawn",
                 "acquire_misses", "arrival_gap_max_us", "arrival_gaps_over_5ms",
                 "packets_lost", "buffer_ms", "frames_dropped"):
        vals = col(name)
        if not any(vals):
            continue
        print(f"  {name:24s} min {min(vals):9.1f}  mittel {sum(vals)/len(vals):9.1f}  max {max(vals):9.1f}")
    (HERE / f"samples-{tag}.json").write_text(json.dumps(useful, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
