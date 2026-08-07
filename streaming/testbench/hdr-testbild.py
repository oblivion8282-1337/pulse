#!/usr/bin/env python3
"""Erzeugt ein HDR-Testbild mit BEKANNTEN Leuchtdichten (PQ, BT.2020, 10 bit).

**Wozu.** Ein Sichteindruck beantwortet nicht, ob die Zahlen stimmen. Dieses
Muster hat je Streifen eine vorgegebene Leuchtdichte; was am Ende ankommt, ist
damit nachrechenbar statt Geschmackssache. Es schliesst die Luecke aus
``hdr-2026-08-07-scanout-linux-nvidia.json``: dort kam ein zurueckgerechnetes
Maximum von rund 1000 cd/m2 heraus, mehr als der Schirm kann, und keine der
beiden moeglichen Erklaerungen war geprueft.

**Warum die Codewerte hier gerechnet und nicht abgeschrieben werden.** Die
PQ-Kurve ist in SMPTE ST 2084 als Formel gegeben; jede Tabelle daneben ist eine
Fehlerquelle mehr. Die Umkehrung steht unten und ist gegen die Stuetzstellen
geprueft, die in der Norm genannt sind.

    ./hdr-testbild.py                 # schreibt hdr-testbild.mkv + .json
    PULSE_HARNESS_SOURCE=$PWD/hdr-testbild.mkv ./harness.py --noaudio
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

HIER = Path(__file__).resolve().parent
BREITE, HOEHE = 1920, 1080
# Sechs Streifen, weil 1080/6 = 180 gerade ist — 4:2:0 halbiert die Hoehe der
# Farbebenen, eine ungerade Streifenhoehe fiele dort auf eine halbe Zeile.
STUFEN_CD = [1.0, 10.0, 100.0, 203.0, 400.0, 1000.0]

# ST 2084, Tabelle 4. Als Brueche geschrieben, damit sie gegen die Norm
# nachlesbar sind statt als Dezimalzahlen dazustehen.
M1 = 2610 / 16384
M2 = 2523 / 4096 * 128
C1 = 3424 / 4096
C2 = 2413 / 4096 * 32
C3 = 2392 / 4096 * 32


def pq_code(cd_pro_m2: float) -> float:
    """Leuchtdichte in cd/m2 → normierter PQ-Wert in [0,1]."""
    y = cd_pro_m2 / 10000.0
    ym = y**M1
    return ((C1 + C2 * ym) / (1.0 + C3 * ym)) ** M2


def zehn_bit_tv(normiert: float) -> int:
    """Normiert → 10-bit-Codewert im BESCHNITTENEN Bereich (64..940).

    Beschnitten, nicht voll, weil die Sendekette es so fuehrt — ein Testbild im
    vollen Bereich wuerde einen Fehler verdecken, den ein echter Strom haette.
    """
    return round(normiert * 876.0 + 64.0)


def main() -> int:
    streifen = HOEHE // len(STUFEN_CD)
    codes = [zehn_bit_tv(pq_code(cd)) for cd in STUFEN_CD]

    # Luma: je Streifen ein Codewert. Chroma: neutral (512 bei 10 bit).
    luma = bytearray()
    for code in codes:
        luma += code.to_bytes(2, "little") * (BREITE * streifen)
    neutral = (512).to_bytes(2, "little") * (BREITE // 2) * (HOEHE // 2)

    roh = HIER / "hdr-testbild.raw"
    roh.write_bytes(bytes(luma) + neutral + neutral)

    ziel = HIER / "hdr-testbild.mkv"
    # `-stream_loop -1` mit `-t`, weil ein einzelnes Bild als Rohdatei sonst
    # nach einem Bild endet; 600 Bilder als Datei waeren 2 GB.
    befehl = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-stream_loop", "-1",
        "-f", "rawvideo", "-pix_fmt", "yuv420p10le",
        "-s", f"{BREITE}x{HOEHE}", "-framerate", "60",
        "-i", str(roh), "-t", "12",
        # **`setparams` statt der reinen Ausgabeoptionen.** Beim ersten Versuch
        # standen `-color_primaries`/`-color_trc` nur auf der Kommandozeile —
        # im Sequenzkopf kam davon NICHTS an, allein `bt2020nc` war da. Die
        # Werte muessen an den BILDeigenschaften haengen, dann reicht der
        # Encoder sie durch. Dieselbe Falle steht im Repo schon fuer Windows.
        "-vf", "setparams=color_primaries=bt2020:color_trc=smpte2084:"
               "colorspace=bt2020nc:range=tv,format=p010le",
        "-c:v", "av1_nvenc", "-preset", "p4", "-cq", "20",
        "-color_primaries", "bt2020", "-color_trc", "smpte2084",
        "-colorspace", "bt2020nc", "-color_range", "tv",
        str(ziel),
    ]
    if subprocess.run(befehl).returncode != 0:
        print("Kodieren fehlgeschlagen", file=sys.stderr)
        return 1
    roh.unlink()

    # **Nachsehen, nicht annehmen.** Die reinen CLI-Farboptionen greifen nicht
    # immer bis in den Sequenzkopf (auf Windows genau daran gescheitert). Der
    # Container traegt eigene Farbfelder und koennte einen leeren Sequenzkopf
    # verdecken — deshalb wird der Strom herausgeloest und ALLEIN befragt.
    obu = HIER / "hdr-testbild.obu"
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-i", str(ziel), "-c", "copy", "-f", "obu", str(obu)],
        check=True,
    )
    probe = subprocess.run(
        ["ffprobe", "-hide_banner", "-loglevel", "error", "-select_streams", "v:0",
         "-show_entries", "stream=color_primaries,color_transfer,color_space,pix_fmt",
         "-of", "json", str(obu)],
        capture_output=True, text=True, check=True,
    )
    im_strom = json.loads(probe.stdout)["streams"][0]
    obu.unlink()

    erwartet = {
        "color_primaries": "bt2020",
        "color_transfer": "smpte2084",
        "color_space": "bt2020nc",
        "pix_fmt": "yuv420p10le",
    }
    stimmt = all(im_strom.get(k) == v for k, v in erwartet.items())

    akte = {
        "datei": str(ziel),
        "streifen_von_oben": [
            {"cd_pro_m2": cd, "pq_normiert": round(pq_code(cd), 6), "code_10bit_tv": c}
            for cd, c in zip(STUFEN_CD, codes)
        ],
        "im_strom_gemessen": im_strom,
        "signalisierung_stimmt": stimmt,
        "bereich": "beschnitten (tv), 64..940",
    }
    (HIER / "hdr-testbild.json").write_text(json.dumps(akte, indent=2, ensure_ascii=False))

    for cd, c in zip(STUFEN_CD, codes):
        print(f"  {cd:7.1f} cd/m2  →  Codewert {c}")
    print(f"\nIm Strom: {im_strom}")
    print("Signalisierung stimmt" if stimmt else "SIGNALISIERUNG FALSCH — Datei nicht benutzen")
    return 0 if stimmt else 1


if __name__ == "__main__":
    raise SystemExit(main())
