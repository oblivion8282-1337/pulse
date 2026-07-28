#!/usr/bin/env python3
"""Prüfstand mit dem ECHTEN Sender (Linux-Rust-Sidecar) statt ffmpeg.

Wie ``harness.py``, aber die Quelle ist unsere eigene Aufnahme-und-Encode-Kette.
Der Wayland-Dialog erscheint nur beim ERSTEN Lauf: ``PULSE_PORTAL_REUSE=1``
speichert das Restore-Token des Portals, danach startet der Sender ohne Klick.

    ./real-harness.py --secs 15
    ./real-harness.py --secs 15 --audio Aus     # Gegenprobe ohne Ton
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from gpuload import GpuLoad
from harness import CID, HERE, Player, mint_tokens

SIDECAR = Path(os.environ.get(
    "PULSE_LINUX_HQ_SIDECAR",
    Path.home() / "Dokumente/Linux_Rust_Sidecar/target/release/pulse-linux-hq-sidecar",
))


class Sidecar:
    """stdio-JSON-RPC wie der Player — gleiches Protokoll, andere Richtung."""

    def __init__(self, log, env_extra: dict | None = None) -> None:
        env = {**os.environ, "PULSE_PORTAL_REUSE": "1", "RUST_LOG": "info",
               **(env_extra or {})}
        self.p = subprocess.Popen(
            [str(SIDECAR)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=log, env=env, text=True, bufsize=1,
        )
        self.next_id = 1

    def call(self, op: str, timeout: float = 90.0, **kw) -> dict:
        rid = self.next_id
        self.next_id += 1
        self.p.stdin.write(json.dumps({"op": op, "id": rid, **kw}) + "\n")
        self.p.stdin.flush()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            line = self.p.stdout.readline()
            if not line:
                raise RuntimeError("Sender hat stdout geschlossen")
            msg = json.loads(line)
            if msg.get("id") == rid:      # Antwort
                return msg
            # alles andere sind Events ({"ev": ...}) — mitschreiben, nicht warten
        raise TimeoutError(f"keine Antwort auf {op}")

    def stop(self) -> None:
        try:
            self.call("stop", timeout=15)
        except Exception:
            pass
        self.p.send_signal(signal.SIGTERM)
        try:
            self.p.wait(timeout=8)
        except subprocess.TimeoutExpired:
            self.p.kill()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--secs", type=float, default=15.0)
    ap.add_argument("--fps", type=int, default=144)
    ap.add_argument("--audio", default="Desktop", help='"Desktop" oder "Aus"')
    ap.add_argument("--bits", type=int, default=10)
    # H.264 kann bei NVENC kein 10 bit — mit `--codec h264` gehoert `--bits 8`
    # dazu, sonst verfaellt die Tiefe still (ten_bit_possible im Sidecar).
    ap.add_argument("--codec", default="av1", help="av1 oder h264")
    ap.add_argument("--kbps", type=int, default=25000)
    ap.add_argument("--quality", action="store_true",
                    help="Bildqualitaet: Rohmitschnitt im Sender + Aufnahme im Player")
    ap.add_argument("--content", type=Path, default=None,
                    help="Video, das waehrend der Messung als Bildinhalt laeuft")
    ap.add_argument("--e2e", action="store_true",
                    help="Ende-zu-Ende messen: Zeitmuster anzeigen und im Player zurücklesen")
    ap.add_argument("--keyframe-on-gap", action="store_true",
                    help="bei jeder gemeldeten Luecke ein Vollbild anfordern — bildet den Rueckkanal nach, den es noch nicht gibt")
    ap.add_argument("--proto", default="rtmps", choices=["rtmps", "srt"],
                    help="Transportweg zum lokalen MediaMTX (srt nur mit --codec h264)")
    ap.add_argument("--label", default="")
    args = ap.parse_args()

    tag = args.label or f"echt-{args.audio.lower()}"
    send_log = open(HERE / f"send-{tag}.log", "w")
    player_log = open(HERE / f"player-{tag}.log", "w")

    # Ende-zu-Ende: gemeinsame Epoche fuer Muster und Sonde. Beide rechnen in
    # Millisekunden seit DIESEM Zeitpunkt — ohne gemeinsamen Nullpunkt waere die
    # Differenz sinnlos.
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
        time.sleep(2.0)  # Fenster aufbauen lassen
        if pattern.poll() is not None:
            print("Zeitmuster startete nicht — siehe pattern-Log", file=sys.stderr)
            return 1
        player_env = {"PULSE_PLAYER_LATENCY_PROBE": "1",
                      "PULSE_PLAYER_LATENCY_EPOCH_MS": epoch}

    # Bildinhalt: ohne bewegtes Bild sagt eine Qualitaetsmessung nichts. Auf
    # JEDEM Bildschirm eine Wiedergabe, weil nicht feststeht, welchen der Sender
    # aufnimmt (dieselbe Ueberlegung wie beim Zeitmuster).
    players_content: list[subprocess.Popen] = []
    if args.content is not None:
        content_log = open(HERE / f"content-{tag}.log", "w")
        screens = int(os.environ.get("PULSE_SCREENS", "3"))
        for i in range(screens):
            # Zusammen mit dem Zeitmuster NICHT im Vollbild: ein
            # Vollbild-Fenster legt KWin auch ueber ein "immer oben"-Fenster,
            # das Muster ist dann weg. Am 2026-07-27 nachgemessen, nachdem das
            # Muster durchsichtig und nach vorn gewandert war und die Vermutung
            # nahelag, der Umweg sei nun ueberfluessig: 61 Bilder ohne Muster,
            # also keine einzige Ablesung. Im Fenster bleiben von den zwoelf
            # Balken genug frei.
            geom = ["--fullscreen", f"--fs-screen={i}"] if not args.e2e else [
                "--geometry=55%x55%", f"--screen={i}"]
            players_content.append(subprocess.Popen(
                ["mpv", "--no-audio", "--loop-file=inf", *geom,
                 "--no-osc", "--no-input-default-bindings",
                 "--profile=low-latency", str(args.content)],
                stdout=content_log, stderr=content_log,
            ))
        time.sleep(3.0)

    sender_env: dict[str, str] = {}
    ref_path = HERE / f"ref-{tag}.raw"
    if args.quality:
        # Der Mitschnitt ist unkomprimiert (gut 660 MB je Sekunde bei 1440p60) —
        # er gehoert auf die SSD, und die Bildzahl bleibt klein.
        sender_env["PULSE_DUMP_RAW"] = str(ref_path)
        # 180 Bilder sind rund 2 GB und decken nur die ERSTEN drei Sekunden ab.
        # Fuer die Frage "waechst ein Posten im Lauf der Zeit?" reicht das
        # nicht — dafuer laesst sich die Grenze von aussen anheben (600 Bilder
        # sind gut 6,5 GB, das gehoert auf eine SSD und nicht nach /tmp).
        sender_env["PULSE_DUMP_RAW_FRAMES"] = os.environ.get("PULSE_DUMP_RAW_FRAMES", "180")

    path, pub, rd = mint_tokens()
    whep = f"http://localhost:8889/{path}/whep?token={rd}"
    # `--proto srt` wechselt den Transportweg, ohne sonst etwas zu aendern —
    # gedacht als Einzelvariablen-Test. Am 2026-07-28 gebraucht, um den
    # H.264-Latenzaufschlag zwischen FLV-Muxer und MediaMTX aufzuteilen:
    # dieselbe Aufnahme, derselbe Encoder, nur RTMPS/FLV gegen SRT/MPEG-TS.
    # ACHTUNG: MPEG-TS traegt kein AV1 (landet als `bin_data`, MediaMTX erkennt
    # es nicht) — `--proto srt` ist also nur mit `--codec h264` sinnvoll.
    if args.proto == "srt":
        push = f"srt://localhost:8890?streamid=publish:{path}:pulse:{pub}&pkt_size=1316"
    else:
        push = f"rtmps://localhost:1936/{path}?token={pub}"
    print(f"[{tag}] Pfad {path}")

    sender = Sidecar(send_log, sender_env)
    player = None
    samples: list[dict] = []
    # GPU-Last IMMER mitschreiben, nicht auf Zuruf: die Encoder-Schalter, die
    # keine Latenz kosten (preset, multipass, AQ), kosten genau hier — eine
    # Messreihe ohne diese Achse waere nur halb aussagekraeftig, und ein
    # Schalter, den man vergessen kann, wird vergessen.
    gpu = GpuLoad(HERE / f"gpu-{tag}.log")
    try:
        gpu.__enter__()
        res = sender.call(
            "start",
            channel={"id": CID, "token": pub, "push_url": push},
            capture="portal",
            audio={"mode": args.audio},
            overrides={"codec": args.codec, "fps": args.fps, "bitrate_kbps": args.kbps,
                       "bit_depth": args.bits},
        )
        if not res.get("ok"):
            print(f"start fehlgeschlagen: {res}", file=sys.stderr)
            return 1
        time.sleep(4.0)  # Publish + Auth abwarten

        player = Player(player_log, player_env)
        res = player.call("open", url=whep, title=f"Pruefstand {tag}")
        if not res.get("ok"):
            print(f"open fehlgeschlagen: {res}", file=sys.stderr)
            return 1
        sid = res["session"]
        rec_path = HERE / f"rec-{tag}.mkv"
        if args.quality:
            # Auf das erste Bild WARTEN, nicht schaetzen: `record` lehnt vorher
            # ab ("noch kein Bild empfangen"), weil es den Codec des Stroms
            # kennen muss, um den Container zu waehlen. Ein fester Vorlauf war
            # zu kurz und die Aufnahme fiel still aus.
            for _ in range(60):
                st = player.call("stats", session=sid)
                if st.get("ok") and (st.get("frames_decoded") or 0) > 0:
                    break
                time.sleep(0.25)
            rr = player.call("record", session=sid, path=str(rec_path))
            if not rr.get("ok"):
                print(f"Aufnahme abgelehnt: {rr}", file=sys.stderr)
                return 1
            print(f"Aufnahme laeuft: {rr.get('path', rec_path)}")
        end = time.monotonic() + args.secs
        naechste_probe = time.monotonic() + 1.0
        letzte_anforderung = 0.0
        letzte_drops = 0
        # Fein abfragen, aber weiterhin nur eine Probe je Sekunde ablegen: die
        # Vollbild-Anforderung muss kurz nach der Luecke kommen, nicht am Ende
        # der Sekunde. Mit 1-Hz-Abfrage waere die gemessene Wirkung allein durch
        # den Prueftakt gedaempft.
        takt = 0.05 if args.keyframe_on_gap else 1.0
        while time.monotonic() < end:
            time.sleep(takt)
            s = player.call("stats", session=sid)
            if not s.get("ok"):
                continue
            if args.keyframe_on_gap:
                # `frames_dropped` zaehlt gemeldete Luecken. Steigt der Zaehler,
                # hat der Zuschauer gerade den Anschluss verloren — genau dann
                # wuerde ein echter Rueckkanal ein Vollbild anfordern.
                drops = s.get("frames_dropped", 0)
                jetzt = time.monotonic()
                if drops > letzte_drops and jetzt - letzte_anforderung >= 0.2:
                    letzte_anforderung = jetzt
                    sender.call("keyframe", timeout=10)
                letzte_drops = drops
            if time.monotonic() >= naechste_probe:
                samples.append(s)
                naechste_probe += 1.0
    finally:
        gpu.__exit__()
        if player is not None:
            if args.quality:
                try:
                    player.call("stop_record", session=sid)
                except Exception as e:
                    print(f"stop_record: {e}", file=sys.stderr)
            player.stop()
        for c in players_content:
            c.terminate()
        for c in players_content:
            try:
                c.wait(timeout=5)
            except subprocess.TimeoutExpired:
                c.kill()
        sender.stop()
        if pattern is not None:
            pattern.terminate()
            try:
                pattern.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pattern.kill()
        send_log.close()
        player_log.close()

    if args.quality:
        print(f"\nVergleich starten mit:\n  ./compare-quality.py --ref {ref_path} "
              f"--rec {HERE / f'rec-{tag}.mkv'}")

    useful = samples[2:]
    if not useful:
        print("keine Messwerte", file=sys.stderr)
        return 1
    print(f"[{tag}] {len(useful)} Proben")
    for name in ("fps", "kbps", "frames_never_drawn", "arrival_gap_max_us",
                 "arrival_gaps_over_5ms", "packets_lost", "frames_dropped",
                 "decode_avg_us", "glass_avg_us", "glass_max_us",
                 "e2e_avg_us", "e2e_max_us", "e2e_misses"):
        vals = [float(s.get(name, 0) or 0) for s in useful]
        if any(vals):
            print(f"  {name:24s} min {min(vals):9.1f}  mittel {sum(vals)/len(vals):9.1f}  max {max(vals):9.1f}")
    print(gpu.summary())
    (HERE / f"samples-{tag}.json").write_text(json.dumps(useful, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
