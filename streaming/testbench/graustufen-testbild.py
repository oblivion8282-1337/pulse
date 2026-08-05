#!/usr/bin/env python3
"""Testbild fuer die Frage: kommt 10 bit durch die Kette, oder wird es auf 8 gekappt?

Erzeugt EIN Bild mit vier Baendern, das als 10-bit-Video (yuv420p10le) verpackt
wird. Zwei der Baender sind absichtlich auf 8 bit quantisiert, zwei nicht — wer
sie nebeneinander sieht, braucht kein Messgeraet:

    1  Vollverlauf, auf 8 bit gerastert    -> sichtbare Stufen
    2  Vollverlauf in voller 10-bit-Feinheit -> glatt
    3  FLACHER Verlauf, 8 bit               -> grobe Balken   (die Lupe)
    4  FLACHER Verlauf, 10 bit              -> feine Balken

Band 3 und 4 sind der eigentliche Test. Ein Vollverlauf ueber 2560 Bildpunkte
hat in 8 bit rund 256 Stufen, also gut zehn Punkte je Stufe — das sieht man nur
mit gutem Willen. Ein flacher Verlauf spreizt WENIGE Codewerte ueber die ganze
Breite; dieselbe Quantisierung wird damit zu handbreiten Balken. Genau dort
zeigt sich, ob irgendwo auf dem Weg auf 8 bit gekappt wurde.

**Was dieses Bild NICHT beantworten kann.** Die Bildschirmaufnahme selbst ist
8 bit: der Compositor liefert `XRGB8888` (`capture/pipewire_stream.rs` bewirbt
BGRx/BGRA). Wer dieses Video auf dem Schirm abspielt und den Schirm streamt,
schickt also in JEDEM Fall eine 8-bit-Quelle los. Der Unterschied zwischen den
Baendern verschwindet dabei — nicht weil die Kette 10 bit verliert, sondern weil
die Quelle keine hat.

Wofuer es trotzdem taugt, und das ist der Punkt: **denselben Schirm einmal mit
8 und einmal mit 10 bit streamen und die flachen Baender vergleichen.** Der
10-bit-Encoder quantisiert nicht ein zweites Mal, der 8-bit-Encoder schon —
dort wird aus feinen Balken ein grober Treppenverlauf. Das ist der Gewinn, den
10 bit auf einer 8-bit-Quelle wirklich bringt.

Aufruf:
    python3 streaming/testbench/graustufen-testbild.py [zieldatei.mkv]
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent

BREITE, HOEHE = 2560, 1440
FPS = 30
SEKUNDEN = 30

# Begrenzter Wertebereich (BT.709 "tv"), wie ihn der Sidecar signalisiert
# (`out_range=limited`). In 10 bit liegt Schwarz bei 64 und Weiss bei 940 —
# und 8 bit sind darin exakt jeder VIERTE Wert, weil 8-bit-Limited (16..235)
# mal vier genau 64..940 ergibt. Deshalb ist "auf 8 bit runden" hier schlicht
# "auf ein Vielfaches von 4 runden", ohne Umrechnungsfehler.
SCHWARZ, WEISS = 64, 940
ACHT_BIT_SCHRITT = 4

# Der flache Verlauf. 40 Codewerte auf 2560 Bildpunkte: in 10 bit sind das 64
# Punkte je Stufe, in 8 bit (nur jeder vierte Wert existiert) 256 — ein
# fingerbreiter Balken. Mittleres Grau, weil Banding dort am besten sichtbar
# ist; in den Ecken des Wertebereichs versteckt es die Wahrnehmung.
FLACH_VON, FLACH_BIS = 480, 520


def band_verlauf(von: int, bis: int, quantisiert: bool) -> list[int]:
    """Eine Bildzeile: linearer Verlauf von `von` nach `bis` ueber die Breite."""
    zeile = []
    for x in range(BREITE):
        wert = von + (bis - von) * x // max(BREITE - 1, 1)
        if quantisiert:
            # Auf das 8-bit-Raster runden — dieselbe Stufung, die eine
            # 8-bit-Kette dem Bild ohnehin aufzwingt.
            wert = round((wert - SCHWARZ) / ACHT_BIT_SCHRITT) * ACHT_BIT_SCHRITT + SCHWARZ
        zeile.append(max(SCHWARZ, min(WEISS, wert)))
    return zeile


def luma_ebene() -> bytearray:
    """Die Y-Ebene des Testbilds, 16 bit je Punkt (10 bit genutzt)."""
    baender = [
        band_verlauf(SCHWARZ, WEISS, quantisiert=True),
        band_verlauf(SCHWARZ, WEISS, quantisiert=False),
        band_verlauf(FLACH_VON, FLACH_BIS, quantisiert=True),
        band_verlauf(FLACH_VON, FLACH_BIS, quantisiert=False),
    ]
    hoehe_band = HOEHE // len(baender)
    # Eine duenne schwarze Trennlinie, damit die Baender nicht ineinander
    # laufen — ohne sie sieht ein Uebergang wie eine weitere Stufe aus.
    trenner = [SCHWARZ] * BREITE

    ebene = bytearray()
    for i, zeile in enumerate(baender):
        for y in range(hoehe_band):
            ist_rand = y < 2 or y >= hoehe_band - 2
            quelle = trenner if (ist_rand and i > 0) else zeile
            for wert in quelle:
                ebene += wert.to_bytes(2, "little")
    # Reste auffuellen, falls die Hoehe nicht glatt teilbar ist.
    while len(ebene) < BREITE * HOEHE * 2:
        ebene += baender[-1][0].to_bytes(2, "little")
    return ebene


def main() -> int:
    # Vorgabe NEBEN das Skript, nicht ins aktuelle Verzeichnis. Der Aufruf aus
    # dem Repo-Wurzelverzeichnis (so steht er im Docstring) legte sonst 66 MB
    # dorthin — und `.gitignore` fuer Artefakte des Pruefstands ist mit fuehrendem
    # Schraegstrich bewusst auf DIESE Ebene verankert, greift dort also nicht.
    # Genau diese Unfallklasse haelt `streaming/testbench/.gitignore` schon fest
    # (2026-07-29: 98 Dateien bis 110 MB, Push von GitHub abgelehnt).
    ziel = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "graustufen-testbild.mkv"

    y = luma_ebene()
    # Farblos: beide Chroma-Ebenen auf die Mitte (512 in 10 bit). yuv420 heisst
    # je ein Viertel der Punkte.
    chroma = (512).to_bytes(2, "little") * (BREITE // 2) * (HOEHE // 2)
    frame = bytes(y) + chroma + chroma

    # Griff in eine andere Komponente — die Datei ist getrackt, der Pfad also
    # tragfaehig. Fehlt sie doch, scheitert sonst ffmpeg mit einer
    # `drawtext`-Meldung, die nicht sagt, woran es liegt.
    schriftart = HERE.parent / "pulse-player/assets/fonts/PlusJakartaSans-SemiBold.ttf"
    if not schriftart.is_file():
        sys.stderr.write(f"Schriftart fehlt: {schriftart}\n")
        return 1
    hoehe_band = HOEHE // 4
    beschriftung = [
        "Vollverlauf – auf 8 bit gerastert",
        "Vollverlauf – volle 10 bit",
        "FLACH – auf 8 bit gerastert  (die Lupe)",
        "FLACH – volle 10 bit",
    ]
    zeichnen = ",".join(
        f"drawtext=fontfile={schriftart}:text='{t}':x=40:"
        f"y={i * hoehe_band + 30}:fontsize=34:fontcolor=white:"
        f"box=1:boxcolor=black@0.6:boxborderw=12"
        for i, t in enumerate(beschriftung)
    )

    # FFV1 ist verlustfrei — das Testbild soll die Kette pruefen, nicht seine
    # eigene Kompression. Ein verlustbehaftetes Referenzbild brauchte sonst als
    # Erstes den Nachweis, dass die Balken nicht von IHM stammen.
    # Das Einzelbild ueber eine DATEI statt ueber die Pipe: `-stream_loop`
    # spult zum Anfang zurueck, und eine Pipe kann das nicht ("Illegal seek").
    # Alle 900 Bilder durch die Pipe zu schieben waeren rund 10 GB.
    with tempfile.NamedTemporaryFile(suffix=".yuv") as roh:
        roh.write(frame)
        roh.flush()
        befehl = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "rawvideo", "-pix_fmt", "yuv420p10le",
            "-s", f"{BREITE}x{HOEHE}", "-r", str(FPS), "-stream_loop", "-1",
            "-i", roh.name, "-t", str(SEKUNDEN),
            "-vf", zeichnen,
            "-c:v", "ffv1", "-level", "3",
            "-color_primaries", "bt709", "-color_trc", "bt709",
            "-colorspace", "bt709", "-color_range", "tv",
            str(ziel),
        ]
        lauf = subprocess.run(befehl, capture_output=True)
    if lauf.returncode != 0:
        sys.stderr.write(lauf.stderr.decode(errors="replace"))
        return 1
    print(f"{ziel}  ({ziel.stat().st_size / 1e6:.1f} MB, {SEKUNDEN}s, {BREITE}x{HOEHE}, 10 bit)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
