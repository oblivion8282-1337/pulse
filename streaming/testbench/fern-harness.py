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

**Voraussetzungen.** Auf dem Zielserver läuft der Labor-MediaMTX (seit
2026-07-31 eigenständig, vorher steckte er im All-in-one-Container der
Self-Host-Testinstanz). Zugangsdaten kommen aus der Umgebung:

    PULSE_FERN_PASS    Passwort des MediaMTX-Zugangs (Pflicht)
    PULSE_FERN_TOKEN   Lese-Token, das Caddy vor dem WHEP-Weg prüft (Pflicht)
    PULSE_FERN_USER    Nutzername, Vorgabe ``labor``

Beide stehen auf dem Server in ``~/mediamtx-labor/zugang.txt``.

**Kein SSH mehr, keine Redis.** Bis zum 2026-07-31 legte der Prüfstand für
jeden Lauf zwei Token per ``ssh`` + ``docker exec … redis-cli`` in die Redis
des Containers, weil MediaMTX dort gegen den Pulse-Auth-Hook prüfte. Der Hook
ist mit dem Container weg; der Messstand nutzt die eingebaute Auth von
MediaMTX. Ein Lauf braucht damit keinen Serverzugriff mehr — nur die
Zugangsdaten.

**Warum der WHEP-Weg trotzdem einen ``token=``-Parameter trägt.** MediaMTX
nimmt für WHEP ausschließlich Basic-Auth (Query-Parameter beantwortet 1.19.1
mit 401), und unser Player kann keinen Auth-Header. Caddy übersetzt deshalb:
es prüft den Token und setzt den Header. Für alle Aufrufer hier sieht die
Adresse deshalb aus wie vorher.

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
# Nur noch für `verzoegerung.py` (misst die Umlaufzeit zur Server-Adresse) —
# der Prüfstand selbst braucht seit 2026-07-31 keinen Serverzugriff mehr.
SSH = os.environ.get("PULSE_FERN_SSH", "michael@77.42.71.166")
USER = os.environ.get("PULSE_FERN_USER", "labor")
RTMPS_PORT = int(os.environ.get("PULSE_FERN_RTMPS_PORT", "1936"))
# MediaMTX lauscht per Voreinstellung auf 8890 — der Container veröffentlicht
# diesen Port aber nicht, und einen Port nachträglich zu veröffentlichen ginge
# nur durch Neuerstellen des Containers. Ausweg: MediaMTX auf einen bereits
# veröffentlichten, aber unbenutzten Port legen (`srtAddress: :7890`; der
# LiveKit-Bereich 7882-7892 ist auf der Testinstanz nach aussen offen und innen
# leer, weil dort kein LiveKit läuft).
SRT_PORT = int(os.environ.get("PULSE_FERN_SRT_PORT", "7890"))


def _pflicht(name: str) -> str:
    wert = os.environ.get(name, "")
    if not wert:
        raise SystemExit(
            f"{name} fehlt. Die Zugangsdaten des Labor-MediaMTX stehen auf dem "
            f"Server in ~/mediamtx-labor/zugang.txt:\n"
            f"    export PULSE_FERN_PASS=…   export PULSE_FERN_TOKEN=…"
        )
    return wert


def mint_remote() -> tuple[str, str, str]:
    """(mediamtx-Pfad, Publish-Passwort, Lese-Token).

    Heisst weiter ``mint_remote``, obwohl nichts mehr geprägt wird: die Form
    ``(pfad, publish, lesen)`` teilen sich sechs Aufrufer, und sie passt
    unverändert — nur sind die beiden Geheimnisse jetzt fest statt je Lauf neu.

    Der Pfad bleibt einmalig (Nonce), und das aus demselben Grund wie im
    Produkt: derselbe Pfad Sekundenbruchteile später ist für MediaMTX eine noch
    lebende Sitzung, und der neue Push fällt in deren ICE-Abbau.
    """
    path, _pub, _rd, _pp, _rp = token_payloads()
    return path, _pflicht("PULSE_FERN_PASS"), _pflicht("PULSE_FERN_TOKEN")


def push_url(path: str, token: str, proto: str, srt_latency_ms: int) -> str:
    """Push-Adresse. ``token`` ist das Passwort aus ``mint_remote``."""
    if proto == "whip":
        # Eigener WebRTC-Sendeweg des Sidecars. Der Weg durch Caddy ist derselbe
        # wie beim Zuschauen: `handle_path /whep/*` streift das Praefix ab, und
        # MediaMTX sieht `/<pfad>/whip`. Hier zaehlt deshalb der LESE-Token, den
        # Caddy prüft — die MediaMTX-Zugangsdaten setzt Caddy selbst. Ton laeuft
        # ueber diesen Weg noch nicht.
        return f"https://{HOST}/whep/{path}/whip?token={_pflicht('PULSE_FERN_TOKEN')}"
    if proto == "srt":
        return (f"srt://{HOST}:{SRT_PORT}?streamid=publish:{path}:{USER}:{token}"
                f"&pkt_size=1316&latency={srt_latency_ms * 1000}")
    # RTMPS geht direkt an MediaMTX (Port 1936, an Caddy vorbei) — dort traegt
    # die URL die Zugangsdaten selbst.
    return f"rtmps://{HOST}:{RTMPS_PORT}/{path}?user={USER}&pass={token}"


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
    ap.add_argument("--jitter-ms", type=int, default=None,
                    help="Geduld des Jitter-Puffers BEI EINER LUECKE (Vorgabe 20). "
                         "Kein Vorhalt: ohne Luecke gibt `jitter.rs::poll` sofort "
                         "frei. Ueber die echte Leitung dauert eine "
                         "NACK-Nachlieferung rund 61 ms — unter diesem Wert ist "
                         "jede Nachlieferung zu spaet und wird verworfen.")
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
        auf = {"url": whep, "title": f"Fern {tag}"}
        if args.jitter_ms is not None:
            auf["options"] = {"jitter_ms": args.jitter_ms}
        res = player.call("open", timeout=30, **auf)
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
