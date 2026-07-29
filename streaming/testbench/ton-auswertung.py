#!/usr/bin/env python3
"""Ton-Fehler und A/V-Versatz aus einem Player-Mitschnitt lesen.

Voraussetzung: ein Lauf mit Zeitmuster (`--e2e`), laufendem `tonsignal.py`
und Aufnahme im Player (`record`). Dann stehen im Mitschnitt beide Uhren:

* Das **Bild** traegt die Wanduhr selbst (Zeitbalken, `pattern_format`).
* Der **Ton** traegt Beeps, deren Sendezeit bekannt ist (Anker aus
  `tonsignal-*.start.json` + k Sekunden).

Der Mitschnitt stempelt beide Spuren mit der ANKUNFTSZEIT beim Player
(`session.rs` gibt `started.elapsed()` weiter) — gemessen wird also der
Versatz, wie er ankommt. Das ist zugleich das, was der heutige Player
wiedergibt, denn eine echte zeitstempel-basierte A/V-Synchronisierung hat er
noch nicht (offener Punkt).

Drei Ergebnisse:

* **Aussetzer** — Luecken in der Ankunft der Ton-Pakete (Container-PTS) und
  stumme Stellen im dekodierten Signal (der Traeger ist nie still; Stille IST
  der Fehler).
* **A/V-Versatz** — je Beep: Ankunfts-PTS des Beeps gegen den Ankunfts-PTS des
  Bildes, das dieselbe Wanduhrzeit zeigt. Positiv = Ton kommt spaeter als das
  Bild desselben Moments.
* **Taktabweichung** — Beep-Abstaende im Ton (Soll exakt 1000 ms Signalzeit).

Messgrenzen, im Ergebnis ausgewiesen: der Beep-Anker traegt die
Wiedergabelatenz von `pw-play` (Latenzvorgabe 20 ms), die Balken sind bis zu
8 ms alt (Zeichenraster). Fuer VERAENDERUNG des Versatzes im Lauf spielen
beide Konstanten keine Rolle.

    ./ton-auswertung.py --rec rec-x.mkv --epoch 1785... [--start tonsignal-ton.start.json]
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

from harness import HERE
from pattern_format import BLOCK, BLOCKS, MARKER, POSITIONS

RATE = 48000
TRAEGER_HZ = 440.0
BEEP_HZ = 3000.0
BEEP_MS = 40


def ffprobe_paketliste(rec: Path, strom: str) -> list[tuple[float, float]]:
    """(pts_time, duration_time) je Paket eines Stroms, in Sekunden."""
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", strom, "-show_packets",
         "-show_entries", "packet=pts_time,duration_time", "-of", "json", str(rec)],
        capture_output=True, text=True, check=True,
    )
    out = []
    for p in json.loads(r.stdout).get("packets", []):
        try:
            out.append((float(p["pts_time"]), float(p.get("duration_time") or 0)))
        except (KeyError, ValueError):
            continue
    return out


def audio_dekodieren(rec: Path) -> np.ndarray:
    r = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(rec), "-map", "0:a:0",
         "-ac", "1", "-ar", str(RATE), "-f", "f32le", "-"],
        capture_output=True, check=True,
    )
    return np.frombuffer(r.stdout, dtype=np.float32)


def band_huelle(x: np.ndarray, hz: float, fenster_ms: float = 2.0) -> np.ndarray:
    """Betragshuelle des Signals um `hz` — Mischung ins Basisband + Mittelung."""
    n = len(x)
    t = np.arange(n) / RATE
    basis = x * np.exp(-2j * np.pi * hz * t)
    fenster = max(8, int(RATE * fenster_ms / 1000))
    kern = np.ones(fenster) / fenster
    return 2 * np.abs(np.convolve(basis, kern, mode="same"))


def beeps_finden(x: np.ndarray) -> list[float]:
    """Beep-Anfaenge in Sekunden (Sample-Zeit), per Huellen-Flanke."""
    h = band_huelle(x, BEEP_HZ)
    schwelle = h.max() * 0.4
    if schwelle < 1e-4:
        return []
    ueber = h > schwelle
    kanten = np.flatnonzero(~ueber[:-1] & ueber[1:]) + 1
    starts: list[float] = []
    min_abstand = int(0.5 * RATE)
    for k in kanten:
        if starts and k - starts[-1] * RATE < min_abstand:
            continue
        starts.append(k / RATE)
    return starts


def stumme_stellen(x: np.ndarray) -> list[tuple[float, float]]:
    """(Start s, Dauer ms) aller Abschnitte, in denen der Traeger fehlt."""
    h = band_huelle(x, TRAEGER_HZ, fenster_ms=5.0)
    schwelle = np.median(h) * 0.3
    still = h < schwelle
    # Beep-Fenster maskieren nicht noetig: der Beep ADDIERT sich zum Traeger.
    out = []
    i = 0
    n = len(still)
    while i < n:
        if still[i]:
            j = i
            while j < n and still[j]:
                j += 1
            dauer_ms = (j - i) / RATE * 1000
            if dauer_ms >= 3.0:
                out.append((i / RATE, dauer_ms))
            i = j
        else:
            i += 1
    return out


def video_wanduhr(rec: Path, epoch_ms: int, wall_hint_ms: int | None) -> list[tuple[float, int]]:
    """(pts_s, wanduhr_ms) je Bild mit lesbarem Balken.

    Dekodiert nur die Luma-Ebene in 8 bit — die Schwellen (70/180) stammen aus
    `dump-latency.py` und sind gegen echte Mitschnitte erprobt.
    """
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=width,height", "-of", "json", str(rec)],
        capture_output=True, text=True, check=True,
    )
    s = json.loads(r.stdout)["streams"][0]
    w, h = int(s["width"]), int(s["height"])

    pakete = ffprobe_paketliste(rec, "v:0")
    # `-fps_mode passthrough` ist PFLICHT: der Mitschnitt hat Zeitbasis 1/1000,
    # ohne den Schalter haelt ffmpeg das fuer 1000 fps und DUPLIZIERT jedes
    # Bild ~16-fach — die Balken schienen dann eingefroren (1,5 s Fortschritt
    # in 23 s Aufnahme), obwohl sie liefen.
    proc = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-i", str(rec), "-map", "0:v:0",
         "-fps_mode", "passthrough",
         "-vf", "extractplanes=y", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        stdout=subprocess.PIPE,
    )
    frame_bytes = w * h
    ergebnisse: list[tuple[float, int]] = []
    letzte_wand: int | None = None
    letzter_zaehler: int | None = None
    hit = None
    idx = 0
    while True:
        raw = proc.stdout.read(frame_bytes)
        if not raw or len(raw) < frame_bytes:
            break
        if idx >= len(pakete):
            break
        luma = np.frombuffer(raw, dtype=np.uint8).reshape(h, w)
        zaehler = _lesen_bei(luma, *hit) if hit is not None else None
        if zaehler is None:
            hit = None
            for pos in POSITIONS:
                zaehler = _lesen_bei(luma, *pos)
                if zaehler is not None:
                    hit = pos
                    break
        if zaehler is not None:
            if letzte_wand is None:
                # Erstes lesbares Bild verankern. Der Zaehler laeuft nach
                # 65,5 s um — ohne Anhaltspunkt stimmt `epoch + zaehler` nur,
                # wenn die Aufnahme im ERSTEN Umlauf beginnt. Bei einer Serie
                # (eine Epoche, viele Laeufe) liefert `--wall-hint` die
                # Wanduhr kurz vor Aufnahmestart und waehlt den Umlauf.
                wand = epoch_ms + zaehler
                if wall_hint_ms is not None:
                    wand += 65536 * round((wall_hint_ms - wand) / 65536)
            else:
                wand = letzte_wand + ((zaehler - letzter_zaehler) & 0xFFFF)
            letzte_wand, letzter_zaehler = wand, zaehler
            ergebnisse.append((pakete[idx][0], wand))
        idx += 1
    proc.stdout.close()
    proc.wait()
    return ergebnisse


def _lesen_bei(luma: np.ndarray, x0: int, y0: int) -> int | None:
    """An gegebener Blockposition lesen; ausserhalb/unlesbar -> None."""
    cy = y0 + BLOCK // 2
    if cy >= luma.shape[0] or x0 + BLOCKS * BLOCK > luma.shape[1]:
        return None
    bits = []
    for i in range(BLOCKS):
        v = int(luma[cy, x0 + i * BLOCK + BLOCK // 2])
        if v <= 70:
            bits.append(0)
        elif v >= 180:
            bits.append(1)
        else:
            return None
    if bits[: len(MARKER)] != MARKER:
        return None
    z = 0
    for bit in bits[len(MARKER):]:
        z = (z << 1) | bit
    return z


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rec", required=True, type=Path)
    ap.add_argument("--epoch", required=True, type=int)
    ap.add_argument("--start", type=Path, default=None,
                    help="tonsignal-*.start.json (Anker); ohne: nur Fehler, kein Versatz")
    ap.add_argument("--wall-hint", type=int, default=None,
                    help="Wanduhr (ms) kurz vor Aufnahmestart — waehlt den 65,5-s-Umlauf")
    ap.add_argument("--json", type=Path, default=None, help="Ergebnis zusaetzlich als JSON")
    args = ap.parse_args()

    audio_pakete = ffprobe_paketliste(args.rec, "a:0")
    if not audio_pakete:
        print("KEINE Tonspur im Mitschnitt", file=sys.stderr)
        return 1
    x = audio_dekodieren(args.rec)

    # 1) Verlust: die Quelle liefert exakt 200 Opus-Pakete je Sekunde (5 ms).
    #    Fehlende Pakete = Soll (aus der Zeitspanne) minus Ist. Die PTS-Abstaende
    #    taugen dafuer NICHT — der Mitschnitt stempelt Ankunft, und die kommt
    #    gebuendelt (das ist Buendelung, kein Verlust; anfangs verwechselt).
    spanne_s = audio_pakete[-1][0] - audio_pakete[0][0]
    je_paket_s = spanne_s / max(len(audio_pakete) - 1, 1)
    soll_pakete = round(spanne_s / 0.005) + 1
    verlust = max(0, soll_pakete - len(audio_pakete))

    # 2) Ankunfts-Buendelung des Tons — dieselbe Groesse wie die Video-Luecken,
    #    ab 25 ms (fuenf Paketdauern am Stueck ohne Ankunft).
    buendel = []
    for (p0, _), (p1, _) in zip(audio_pakete, audio_pakete[1:]):
        if p1 - p0 > 0.025:
            buendel.append({"bei_s": round(p0, 3), "ms": round((p1 - p0) * 1000, 1)})

    # 3) Stille im dekodierten Signal (die ersten 50 ms sind Decoder-Anlauf)
    stille = [{"bei_s": round(s, 3), "ms": round(d, 1)}
              for s, d in stumme_stellen(x) if s > 0.05]

    # 4) Beeps + Taktabweichung
    beeps = beeps_finden(x)
    abstaende = [round((b1 - b0) * 1000, 1) for b0, b1 in zip(beeps, beeps[1:])]

    ergebnis: dict = {
        "rec": args.rec.name,
        "ton_pakete": len(audio_pakete),
        "ton_verlust_pakete": verlust,
        "ton_buendelung_ueber_25ms": buendel,
        "stille": stille,
        "beeps": len(beeps),
        "beep_abstaende_ms": {
            "min": min(abstaende) if abstaende else None,
            "max": max(abstaende) if abstaende else None,
        },
    }

    # 5) A/V-Versatz je Beep, wenn der Anker da ist
    if args.start is not None:
        anker = json.loads(args.start.read_text())["start_wall_ms"]
        video = video_wanduhr(args.rec, args.epoch, args.wall_hint)
        if not video:
            print("kein lesbares Zeitmuster im Mitschnitt — Versatz nicht messbar",
                  file=sys.stderr)
        else:
            pts_v = np.array([p for p, _ in video])
            wand_v = np.array([wd for _, wd in video], dtype=np.float64)
            # Ton-Sample -> Ankunfts-PTS ueber die PAKETLISTE, nicht ueber die
            # Sample-Position: der Decoder haengt die Pakete lueckenlos
            # aneinander, ihre Ankunft ist aber gebuendelt — Sample-Zeit und
            # Ankunfts-PTS laufen sonst auseinander.
            gesamt_samples = len(x)
            je_paket = gesamt_samples / len(audio_pakete)
            versaetze = []
            for j, b in enumerate(beeps):
                idx_p = min(int(b * RATE / je_paket), len(audio_pakete) - 1)
                beep_pts = audio_pakete[idx_p][0] + \
                    (b * RATE - idx_p * je_paket) / RATE
                # Welche Sendezeit hatte dieser Beep? k aus der Naehe bestimmen:
                # grobe Wanduhr des Beeps = Wanduhr des Bildes am selben PTS.
                wand_hier = float(np.interp(beep_pts, pts_v, wand_v))
                k = round((wand_hier - anker) / 1000)
                if k < 0:
                    continue
                sende_wand = anker + k * 1000
                # PTS, an dem das BILD dieser Sendezeit ankam:
                bild_pts = float(np.interp(sende_wand, wand_v, pts_v))
                versaetze.append({
                    "beep": int(k),
                    "versatz_ms": round((beep_pts - bild_pts) * 1000, 1),
                })
            ergebnis["av_versatz"] = versaetze
            if versaetze:
                v = np.array([e["versatz_ms"] for e in versaetze])
                ergebnis["av_versatz_zusammenfassung"] = {
                    "mittel_ms": round(float(v.mean()), 1),
                    "min_ms": round(float(v.min()), 1),
                    "max_ms": round(float(v.max()), 1),
                    "spanne_ms": round(float(v.max() - v.min()), 1),
                    "messgrenze": "Anker +-20 ms (pw-play), Balkenraster 8 ms; "
                                   "die SPANNE ist davon unberuehrt",
                }

    print(json.dumps(ergebnis, indent=1, ensure_ascii=False))
    if args.json:
        args.json.write_text(json.dumps(ergebnis, indent=1, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
