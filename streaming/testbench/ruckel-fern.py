#!/usr/bin/env python3
"""Ruckel-Messreihe ueber die echte Leitung: RTMPS gegen WHIP im Wechsel.

Der Aufbau, der alles zusammensteckt, was fuer die Reproduktion des Ruckelns
noetig ist — jede Zutat hat einen gemessenen Grund:

* **Bewegtbild** (`bewegtbild.py`) auf jedem Schirm: ohne Bewegung sind die
  Bilder 1-2 Pakete gross und es gibt keinen Schwall, den die Leitung
  breitziehen koennte. Das Ruckeln ist dann nicht reproduzierbar.
* **Zeitmuster** (`pattern-one.py`, nur der aufgenommene Schirm): Ende-zu-Ende-
  Latenz je Bild. Ein Schirm statt drei, weil das durchsichtige Qt-Fenster
  ~55 % GPU-sm kostet — Eigenlast klein halten.
* **Tonsignal** (`tonsignal.py`): Dauertraeger + Sekunden-Beeps, lautlos in
  einen Null-Sink. Deckt Ton-Aussetzer und A/V-Versatz auf.
* **Abwechselnd** rtmps/whip statt blockweise: die Leitung schwankt ueber
  Minuten — blockweise Messungen vergleichen sonst Leitungszustaende statt
  Sendewege (Messfalle vom 2026-07-28).
* **Player stumm** (`volume 0` beim Oeffnen): sein Ton liefe sonst ueber den
  Desktop-Capture zurueck in den Stream (Rueckkopplung).

Je Lauf faellt an: `player-<tag>.log` (Ankunftsluecken mit Wanduhr,
`PULSE_PLAYER_ARRIVAL_GAP_LOG_MS=25`), `samples-<tag>.json` (Stats je Sekunde),
`rec-<tag>.mkv` (Mitschnitt fuer die Ton-Auswertung), `gpu-<tag>.log`.
Am Ende: `ruckel-<label>.json` mit allem Geparsten, plus Vergleichstabelle.

    ./ruckel-fern.py --paare 3 --secs 60 --label serie1
    ./ruckel-fern.py --paare 1 --secs 45 --pattern aus --ton aus --label kontrolle
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time

import numpy as np

from gemeinsam import laden, sender_starten
from gpuload import GpuLoad
from harness import HERE, Player
from tonsignal import Tonquelle
import bewegtbild

_fern = laden("fern-harness")
Sidecar = laden("real-harness").Sidecar

GAP_RE = re.compile(r"Ankunftsluecke ([\d.]+) ms, erstes Paket danach um ([\d.]+)")


def gaps_aus_log(pfad) -> list[dict]:
    out = []
    try:
        text = pfad.read_text(errors="replace")
    except OSError:
        return out
    for m in GAP_RE.finditer(text):
        out.append({"ms": float(m.group(1)), "wand_ms": float(m.group(2))})
    return out


def lauf(args, i: int, proto: str, epoch: str | None, ton_start,
         sender_env: dict | None = None, tag_suffix: str = "") -> dict:
    tag = f"{args.label}-{i}-{proto}{tag_suffix}"
    send_log = open(HERE / f"send-{tag}.log", "w")
    player_log_path = HERE / f"player-{tag}.log"
    player_log = open(player_log_path, "w")

    path, pub, rd = _fern.mint_remote()
    whep = f"https://{_fern.HOST}/whep/{path}/whep?token={rd}"
    push = _fern.push_url(path, pub, proto, 120)
    print(f"[{tag}] {proto} -> {_fern.HOST}", flush=True)

    player_env = {"PULSE_PLAYER_ARRIVAL_GAP_LOG_MS": "25"}
    if epoch:
        player_env |= {"PULSE_PLAYER_LATENCY_PROBE": "1",
                       "PULSE_PLAYER_LATENCY_EPOCH_MS": epoch}

    ergebnis: dict = {"tag": tag, "proto": proto, "sekunden": args.secs}
    if sender_env:
        ergebnis["sender_env"] = sender_env
    sender = Sidecar(send_log, sender_env or {})
    player = None
    sid = None
    samples: list[dict] = []
    rec_path = HERE / f"rec-{tag}.mkv"
    with GpuLoad(HERE / f"gpu-{tag}.log") as gpu:
        try:
            if not sender_starten(sender, args, pub, push):
                ergebnis["fehler"] = "sender-start"
                return ergebnis
            time.sleep(6.0)

            player = Player(player_log, player_env)
            res = player.call("open", url=whep, title=f"Ruckel {tag}",
                              options={"volume": 0.0}, timeout=30)
            if not res.get("ok"):
                ergebnis["fehler"] = f"open: {res}"
                return ergebnis
            sid = res["session"]

            if getattr(args, "keyframe_nach_open", False):
                # Intra-Refresh-Betrieb: der Strom hat nach t=0 KEINE IDR mehr,
                # der Player wartet aber auf eines (decode.rs). Ein Beitritt
                # braucht deshalb genau ein angefordertes Vollbild — das
                # produktive Gegenstueck waere "PLI nur bei Beitritt" statt der
                # 2-s-Uhr in MediaMTX.
                time.sleep(1.0)
                sender.call("keyframe", timeout=10)

            if args.record:
                for _ in range(80):
                    st = player.call("stats", session=sid)
                    if st.get("ok") and (st.get("frames_decoded") or 0) > 0:
                        break
                    time.sleep(0.25)
                ergebnis["rec_wall_ms"] = int(time.time() * 1000)
                rr = player.call("record", session=sid, path=str(rec_path))
                if rr.get("ok"):
                    ergebnis["rec"] = rr.get("path", str(rec_path))
                else:
                    ergebnis["rec_fehler"] = str(rr)

            ende = time.monotonic() + args.secs
            while time.monotonic() < ende:
                time.sleep(1.0)
                s = player.call("stats", session=sid)
                if s.get("ok"):
                    samples.append(s)
        finally:
            if player is not None:
                if args.record and sid:
                    try:
                        player.call("stop_record", session=sid)
                    except Exception as e:
                        print(f"stop_record: {e}", file=sys.stderr)
                player.stop()
            sender.stop()
            send_log.close()
            player_log.close()

    nutz = samples[2:]
    (HERE / f"samples-{tag}.json").write_text(json.dumps(nutz, indent=1))
    gaps = gaps_aus_log(player_log_path)
    dauer = max(args.secs, 1)
    gap_ms = [g["ms"] for g in gaps]
    ergebnis |= {
        "gaps_ueber_25ms": len(gaps),
        "gaps_je_s": round(len(gaps) / dauer, 2),
        "gap_typisch_ms": round(float(np.median(gap_ms)), 1) if gap_ms else None,
        "gap_max_ms": max(gap_ms) if gap_ms else None,
        "gap_ereignisse": gaps,
    }
    for name in ("fps", "kbps", "packets_lost", "frames_dropped", "frames_never_drawn",
                 "e2e_avg_us", "e2e_max_us", "e2e_misses", "glass_avg_us"):
        vals = [float(s.get(name, 0) or 0) for s in nutz]
        if vals:
            ergebnis[name] = {"min": min(vals), "mittel": round(sum(vals) / len(vals), 1),
                              "max": max(vals)}
    ergebnis["gpu"] = gpu.summary()

    if args.record and ergebnis.get("rec") and ton_start is not None and epoch:
        r = subprocess.run(
            [sys.executable, str(HERE / "ton-auswertung.py"),
             "--rec", ergebnis["rec"], "--epoch", epoch, "--start", str(ton_start),
             "--wall-hint", str(ergebnis.get("rec_wall_ms", "0")),
             "--json", str(HERE / f"ton-{tag}.json")],
            capture_output=True, text=True,
        )
        if r.returncode == 0:
            ton = json.loads(r.stdout)
            ton.pop("av_versatz", None)  # Einzelwerte stehen in ton-<tag>.json
            ergebnis["ton"] = ton
        else:
            ergebnis["ton_fehler"] = r.stderr.strip()[-300:]
    return ergebnis


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--paare", type=int, default=3, help="je Paar ein rtmps- und ein whip-Lauf")
    ap.add_argument("--secs", type=float, default=60.0)
    ap.add_argument("--fps", type=int, default=60)
    ap.add_argument("--kbps", type=int, default=3000)
    ap.add_argument("--codec", default="av1")
    ap.add_argument("--bits", type=int, default=10)
    ap.add_argument("--audio", default="Desktop")
    ap.add_argument("--pattern", default="an", choices=["an", "aus"])
    ap.add_argument("--ton", default="an", choices=["an", "aus"])
    ap.add_argument("--record", action=argparse.BooleanOptionalAction, default=True)
    ap.add_argument("--wechsel", default="proto", choices=["proto", "mux"],
                    help="proto: rtmps/whip im Wechsel. mux: rtmps fest, "
                         "Interleave-Queue gegen Direktschreiben (PULSE_MUX_DIRECT) im Wechsel.")
    ap.add_argument("--keyframe-nach-open", action="store_true",
                    help="einmal ein Vollbild anfordern, sobald der Player offen "
                         "ist (noetig bei intra-refresh: sonst wartet er ewig)")
    ap.add_argument("--nur-proto", default=None, choices=["rtmps", "whip"],
                    help="alle Laeufe mit DIESEM Weg (statt Wechsel) — fuer "
                         "Encoder-Vergleiche, deren Schalter als Env an der "
                         "ganzen Serie haengt")
    ap.add_argument("--label", default="serie")
    args = ap.parse_args()

    laeufe: list[dict] = []
    pattern = None
    epoch: str | None = None
    mpvs: list[subprocess.Popen] = []
    mpv_log = open(HERE / f"bewegtbild-{args.label}.log", "w")
    gesamt_s = int(args.paare * 2 * (args.secs + 25) + 90)

    try:
        mpvs = bewegtbild.abspielen(bewegtbild.datei(args.fps), mpv_log)
        time.sleep(3.0)
        if args.pattern == "an":
            epoch = str(int(time.time() * 1000))
            pattern_log = open(HERE / f"pattern-{args.label}.log", "w")
            pattern = subprocess.Popen(
                [sys.executable, str(HERE / "pattern-one.py")],
                env={**os.environ, "PULSE_LATENCY_EPOCH_MS": epoch},
                stdout=pattern_log, stderr=pattern_log,
            )
            time.sleep(2.0)
            if pattern.poll() is not None:
                print("Zeitmuster startete nicht", file=sys.stderr)
                return 1

        ton_ctx = Tonquelle(gesamt_s, label=args.label) if args.ton == "an" else None
        try:
            if ton_ctx is not None:
                ton_ctx.__enter__()
            for i in range(args.paare * 2):
                if args.wechsel == "mux":
                    proto, direct = "rtmps", i % 2 == 1
                    env = {"PULSE_MUX_DIRECT": "1"} if direct else None
                    suffix = "-direkt" if direct else "-queue"
                elif args.nur_proto:
                    proto, env, suffix = args.nur_proto, None, ""
                else:
                    proto, env, suffix = ("rtmps" if i % 2 == 0 else "whip"), None, ""
                laeufe.append(lauf(args, i, proto, epoch,
                                   ton_ctx.startdatei if ton_ctx else None,
                                   sender_env=env, tag_suffix=suffix))
                time.sleep(3.0)
        finally:
            if ton_ctx is not None:
                ton_ctx.__exit__()
    finally:
        if pattern is not None:
            pattern.terminate()
        bewegtbild.beenden(mpvs)
        mpv_log.close()

    (HERE / f"ruckel-{args.label}.json").write_text(
        json.dumps({"laeufe": laeufe, "args": vars(args)}, indent=1, ensure_ascii=False))

    print(f"\n[{args.label}] Vergleich (je Lauf):")
    kopf = f"{'Lauf':22s} {'Luecken/s':>9s} {'typ. ms':>8s} {'max ms':>7s} " \
           f"{'e2e mi/ma':>12s} {'Verlust':>7s} {'Ton-Lk':>6s} {'A/V ms (Spanne)':>15s}"
    print(kopf)
    for e in laeufe:
        if "fehler" in e:
            print(f"{e['tag']:22s} FEHLER: {e['fehler']}")
            continue
        e2e = e.get("e2e_avg_us") or {}
        e2m = e.get("e2e_max_us") or {}
        ton = e.get("ton") or {}
        av = ton.get("av_versatz_zusammenfassung") or {}
        av_txt = (f"{av['mittel_ms']:+.0f} ({av['spanne_ms']:.0f})"
                  if av.get("mittel_ms") is not None else "-")
        print(f"{e['tag']:22s} {e.get('gaps_je_s', 0):9.2f} "
              f"{e.get('gap_typisch_ms') or 0:8.1f} {e.get('gap_max_ms') or 0:7.1f} "
              f"{(e2e.get('mittel') or 0)/1000:5.1f}/{(e2m.get('max') or 0)/1000:5.1f} ms "
              f"{int((e.get('packets_lost') or {}).get('max') or 0):7d} "
              f"{ton.get('ton_verlust_pakete', '-') if ton else '-':>6} {av_txt:>15s}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
