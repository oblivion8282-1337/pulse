#!/usr/bin/env python3
"""HEVC 8 gegen 10 bit auf der ECHTEN Kette (Sidecar → WHIP → WHEP → Player).

Wie `real-harness.py`, aber mit der AMD-GPU-Last je Prozess (`amdgpuload.py`)
an Sender UND Player gleichzeitig. Die Frage ist der VCN-Aufpreis von HEVC
Main10 auf dem echten Weg — Vorlage ist `2026-09-12-amd-780m-8-gegen-10-bit.md`
(dort Sonde + Referenzsender; der echte Sidecar importiert per DMABUF direkt
auf die GPU und hat den Upload-Posten der Sonde nicht).

Phoenix-Besonderheit (s. Messakte): fdinfo kennt nur `gfx` und `enc`, KEIN
`dec` — die Dekodierzeit des Players landet im `enc`-Zaehler. Der Player-Block
der Ausgabe liest `enc` deshalb als Dekoder-Zeit.

    ./amd-hevc-real.py                       # 8 + 10 bit, je 2 Durchgaenge
    ./amd-hevc-real.py --secs 30 --bits 8    # ein Arm, ein Durchgang
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from amdgpuload import AmdGpuLoad  # noqa: E402
from harness import HERE, Player, mint_tokens  # noqa: E402

# `real-harness.py` traegt einen Bindestrich und ist nicht importierbar —
# die Sidecar-Klasse (stdio-JSON-RPC, Ereignis-Aufbewahrung) kommt per Pfad.
_spec = importlib.util.spec_from_file_location(
    "real_harness", Path(__file__).parent / "real-harness.py")
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
Sidecar = _mod.Sidecar


def lauf(bits: int, durchgang: int, secs: float, fps: int) -> dict:
    tag = f"hevc{bits}-{durchgang}"
    with open(HERE / f"send-{tag}.log", "w") as send_log, \
         open(HERE / f"player-{tag}.log", "w") as player_log:
        path, pub, rd = mint_tokens()
        sender = Sidecar(send_log)
        sender_gpu = AmdGpuLoad(sender.p.pid)
        player_gpu: AmdGpuLoad | None = None
        player: Player | None = None
        proben: list[dict] = []
        try:
            with sender_gpu:
                t0 = time.monotonic()
                res = sender.call(
                    "start",
                    channel={"id": 1, "token": pub,
                             "push_url": f"http://localhost:8889/{path}/whip?token={pub}"},
                    capture="portal", audio={"mode": "Aus"},
                    overrides={"codec": "hevc", "fps": fps, "bitrate_kbps": 25000,
                               "bit_depth": bits},
                )
                if not res.get("ok"):
                    print(f"[{tag}] start fehlgeschlagen: {res}", file=sys.stderr)
                    return {}
                time.sleep(4.0)
                player = Player(player_log)
                player_gpu = AmdGpuLoad(player.p.pid)
                with player_gpu:
                    res = player.call("open", url=f"http://localhost:8889/{path}/whep?token={rd}",
                                      title=f"Pruefstand {tag}")
                    if not res.get("ok"):
                        print(f"[{tag}] open fehlgeschlagen: {res}", file=sys.stderr)
                        return {}
                    t_spieler = time.monotonic()
                    ende = t_spieler + secs
                    while time.monotonic() < ende:
                        time.sleep(1.0)
                        s = player.call("stats", session=res["session"])
                        if s.get("ok"):
                            proben.append(s)
        finally:
            if player is not None:
                player.stop()
            sender.stop()
        nuetzlich = proben[2:]
        if not nuetzlich:
            print(f"[{tag}] keine Messwerte", file=sys.stderr)
            return {}
        fps_werte = [float(s.get("fps", 0) or 0) for s in nuetzlich]
        ergebnis = {
            "tag": tag, "bits": bits,
            "fps_mittel": round(sum(fps_werte) / len(fps_werte), 1),
            "fps_min": min(fps_werte),
            # Fenster schneidet Anlauf/Abbau ab: Sender ab 6 s (2 s nach
            # Beitritt des Players, Keyframe und Init sind raus), Player ab
            # 3 s nach `open` (Einstieg + Aufbau der Bruecke sind raus).
            "sender": sender_gpu.fenster(t0 + 6.0, t0 + 4.0 + secs),
            "player": player_gpu.fenster(t_spieler + 3.0, t_spieler + secs),
        }
        (HERE / f"samples-amd-hevc-{tag}.json").write_text(json.dumps(ergebnis, indent=1))
        return ergebnis


def zeile(name: str, f: dict | None, engine: str, fps: int) -> str:
    if f is None:
        return f"  {name}: zu wenige Proben"
    ns = f.get(f"{engine}_ns")
    us_bild = round(ns / (fps * f["fenster_s"]) / 1000, 1) if ns is not None else None
    return (f"  {name:18s} {f.get(engine + '_util_pct', 0):6.2f} %   "
            f"{us_bild} us/Bild   ({f['fenster_s']} s, {f['proben']} Proben)")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--secs", type=float, default=30.0)
    ap.add_argument("--fps", type=int, default=144)
    ap.add_argument("--bits", type=int, nargs="+", default=[8, 10])
    ap.add_argument("--durchgaenge", type=int, default=2)
    args = ap.parse_args()

    for bits in args.bits:
        for d in range(1, args.durchgaenge + 1):
            e = lauf(bits, d, args.secs, args.fps)
            if not e:
                continue
            print(f"[{e['tag']}] fps mittel {e['fps_mittel']} (min {e['fps_min']})")
            # Phoenix: eine VCN-Instanz, fdinfo kennt gfx+enc. Sender-`enc`
            # ist der Encoder-Block; Player-`enc` ist die DEKODIER-Zeit,
            # Player-`gfx` der Render-/Import-Weg.
            print(zeile("Sender VCN (enc)", e["sender"], "enc", args.fps))
            if e["sender"] and "compute_util_pct" in e["sender"]:
                print(zeile("Sender scale_vaapi", e["sender"], "compute", args.fps))
            print(zeile("Player VCN (dec)", e["player"], "enc", args.fps))
            print(zeile("Player gfx", e["player"], "gfx", args.fps))
            sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
