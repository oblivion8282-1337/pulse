#!/usr/bin/env python3
"""Was kostet der Vollbild-Abstand — an Bildqualitaet und an Sendespitzen?

**Die Luecke, die das hier schliesst.** Am 2026-08-18 wurde die Obergrenze von
`PULSE_KEYFRAME_SECONDS` von 10 auf 120 Sekunden angehoben, weil die 10 eine
hingeschriebene Zahl ohne Herleitung waren. Was dabei auffiel: zur eigentlichen
Frage — wieviel Bildqualitaet ein laengerer Abstand bei fester Datenrate bringt
— gibt es im ganzen Repo KEINE Zahl. Gemessen sind nur die beiden Extreme
(`allintra-2026-07-29.json`: jedes Bild ein Vollbild kostet rund die
vierzigfache Bitrate) und der Vergleich gegen Intra-Refresh
(`qualitaet-2026-07-31-intra-refresh-gegen-keyframes.json`). Dazwischen ist
nichts, und `verlust-2026-07-28-keyframe-abstand.json` sagt das ausdruecklich:
„Seine Kosten bei der Bildqualitaet sind NICHT gemessen."

**Was gemessen wird**, je Abstand, an IDENTISCHEN Bildern:

* **Bildqualitaet** (VMAF/PSNR/SSIM) bei fester Bitrate. Unter CBR kann sich
  ein Vollbild seine Bits nicht zusaetzlich nehmen — es nimmt sie den folgenden
  Bildern weg. Genau dieser Tausch soll hier sichtbar werden.
* **Sendespitzen**: groesster und p99-Wert der Datenmenge in einem gleitenden
  100-ms-Fenster, dazu das Gewicht eines Vollbilds gegenueber einem normalen
  Bild. Der zweite belegte Grund fuers Strecken — bei 20 s GOP fiel p99 auf
  der echten Kette von 12053 auf 5108 kbit/s
  (`docs/plans/2026-07-31-av-sync-und-uebertragungsspitzen.md`).

**Und was dabei NICHT gemessen wird, sonst liest man die Zahlen falsch:** die
Spitzen hier sind die des ENCODER-AUSGANGS, nicht die auf der Leitung. Der
WHIP-Weg hat einen Pacer (`win-hq-sidecar/src/whip/pacer.rs`), der jedes Bild
ueber seinen Bildabstand verteilt — er bekommt diese Spitzen als EINGANG. Die
Zahl beantwortet also „wieviel Stoss erzeugt der Encoder", nicht „wieviel Stoss
kommt beim Zuschauer an". Das ist die Ursache, nicht die Wirkung; die Wirkung
misst man auf der echten Kette.

**Der Inhalt entscheidet mit, und zwar stark.** Ein Vollbild kostet auf einem
stehenden, detailreichen Bildschirm anteilig viel mehr als in einer bewegten
Spielszene — die Antwort auf „wieviel bringt Strecken" ist deshalb je Inhalt
verschieden. Wer eine Zahl will, die traegt, faehrt die Reihe ueber MEHRERE
Referenzen (Desktop, Spiel) und schreibt beide in die Messakte.

## Referenz herstellen

Gebraucht wird ein Rohmitschnitt des Encoder-EINGANGS aus einem echten Lauf —
kein synthetisches Muster (Begruendung im Kopf von `sweep-offline.py`: die
Schwankung des Bildinhalts ist sonst groesser als der gesuchte Unterschied).

    PULSE_DUMP_RAW=$HOME/mess/ref-desktop.raw \\
    PULSE_DUMP_RAW_FRAMES=500 \\
      <Sidecar wie ueblich starten, Stream anwerfen, laufen lassen>

Das legt `ref-desktop.raw` samt `ref-desktop.pts` an (die Kopfzeile darin
nennt Format und Groesse, beides liest dieses Skript selbst aus). **Nicht nach
`/tmp`** — das ist ein tmpfs, also Arbeitsspeicher; bei 1440p60 sind es gut
660 MB je Sekunde.

## Laufen lassen

    ./vollbild-abstand.py --ref ~/mess/ref-desktop.raw --codec av1_vaapi
    ./vollbild-abstand.py --ref ~/mess/ref-desktop.raw --codec av1_nvenc \\
        --abstaende 0.5,1,2,4,10,30,60 --json profiles/vollbild-2026-08-18.json

`--codec` muss zur Maschine passen (`*_vaapi` auf AMD/Intel, `*_nvenc` auf
NVIDIA) — der Sweep bricht sonst beim Encoder-Open ab, laut und richtig.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from vmaf_common import encode_cmd, measure_vmaf, read_header

# Vollbild-Abstaende in Sekunden. Die Vorgabe (2) steht mittendrin, damit der
# heutige Stand in derselben Reihe abzulesen ist statt daneben.
ABSTAENDE_S = [0.5, 1.0, 2.0, 4.0, 10.0, 30.0, 60.0]

# Fenster fuer die Spitzenmessung. 100 ms ist dieselbe Fensterlaenge wie in
# `docs/plans/2026-07-31-av-sync-und-uebertragungsspitzen.md` — die Zahlen sind
# damit gegen jene Reihe haltbar.
FENSTER_S = 0.1


def gepatchtes_ffmpeg() -> Path | None:
    """Pfad zum gepatchten FFmpeg aus `streaming/ffmpeg-patches/`, falls gebaut.

    **Zwei Fallen liegen hier hintereinander, beide am 2026-08-18 aufgelaufen.**

    Erstens: `PATH` allein genuegt nicht. Das gebaute `prefix/bin/ffmpeg` traegt
    keinen RPATH auf sein eigenes `../lib` — der Programmlader nimmt deshalb die
    Bibliothek der Distribution (`/usr/lib64/ffmpeg/libavcodec.so.62`, mit `ldd`
    nachgesehen), und die kennt `intra_refresh` nicht. Der Patch ist gebaut, das
    Programm liegt da, und trotzdem meldet ffmpeg „Unrecognized option". Wer nur
    den PATH setzt, sucht den Fehler im Bau statt im Programmlader. Es braucht
    zusaetzlich `LD_LIBRARY_PATH` (s. [`encode_lauf`]).

    Zweitens, und deshalb wird die Umgebung NICHT global gesetzt: **der gepatchte
    Bau hat kein libvmaf**, der der Distribution schon. Ein global gesetztes
    `LD_LIBRARY_PATH` zoege auch die Messung auf die gepatchte `libavfilter` —
    und dann scheitert sie an „No such filter: 'libvmaf'". Deshalb die Teilung:
    **kodiert wird mit dem gepatchten, gemessen mit dem der Distribution.** Das
    ist unbedenklich, weil alle Varianten eines Laufs denselben Encoder sehen
    und VMAF nur zwei fertige Dateien vergleicht.

    Fuer die Sidecar-Binaries stellt sich das nicht: `scripts/hq-bauen.sh` linkt
    sie mit `-Wl,-rpath` und `--disable-new-dtags` und prueft es nach. Nur das
    CLI-Programm faellt durch dieses Netz.
    """
    wurzel = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    prefix = wurzel / "pulse" / "ffmpeg-intra-refresh" / "prefix"
    return prefix if (prefix / "bin" / "ffmpeg").is_file() else None


def encode_lauf(cmd: list[str], was: str, prefix: Path | None) -> None:
    """Wie `vmaf_common.run_ffmpeg`, aber mit dem gepatchten FFmpeg — samt der
    Bibliothek, ohne die es wirkungslos waere (s. [`gepatchtes_ffmpeg`])."""
    umgebung = dict(os.environ)
    if prefix is not None:
        cmd = [str(prefix / "bin" / "ffmpeg"), *cmd[1:]]
        alt = umgebung.get("LD_LIBRARY_PATH", "")
        lib = str(prefix / "lib")
        umgebung["LD_LIBRARY_PATH"] = f"{lib}{os.pathsep}{alt}" if alt else lib
    r = subprocess.run(cmd, capture_output=True, text=True, env=umgebung)
    if r.returncode != 0:
        print(r.stderr[-1500:], file=sys.stderr)
        raise SystemExit(f"{was} fehlgeschlagen")


def varianten(fps: int, abstaende: list[float], codec: str,
              mit_intraref: bool) -> list[tuple[str, list[str]]]:
    """(Name, zusaetzliche Encoder-Optionen) je Abstand.

    `-g` steht in `encode_cmd` schon auf `fps*2`; weil unsere Angabe DAHINTER
    kommt, gewinnt sie (ffmpeg nimmt bei doppelter Option die letzte). Der
    Abstand wird in Bildern angegeben, genau wie im Sidecar
    (`keyframe_abstand_bilder`), damit hier nicht eine zweite Rundung entsteht.
    """
    liste: list[tuple[str, list[str]]] = []
    for s in abstaende:
        bilder = max(1, round(fps * s))
        liste.append((f"{s:g}s", ["-g", str(bilder)]))
    if mit_intraref:
        # Vergleichspunkt, kein Abstand: hier ist die Zahl die Umlaufdauer der
        # Auffrischung, nicht der Vollbild-Abstand.
        opt = "intra_refresh" if codec.endswith("_vaapi") else "intra-refresh"
        liste.append(("intraref-2s", [f"-{opt}", "1", "-g", str(fps * 2)]))
    return liste


def pakete_lesen(datei: Path) -> list[tuple[float, int, bool]]:
    """(pts_s, groesse_byte, ist_vollbild) je Paket, nach pts sortiert.

    Ueber PAKETE statt Bilder: ein Paket ist das, was den Muxer bzw. den
    Sendeweg verlaesst, und die Kennzeichnung `K` im Flag-Feld ist ueber die
    FFmpeg-Versionen stabil — anders als `key_frame`/`pict_type`, die je nach
    Version und Codec unterschiedlich gefuellt sind.
    """
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "packet=pts_time,size,flags", "-of", "csv=p=0", str(datei)],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        print(r.stderr[-1000:], file=sys.stderr)
        raise SystemExit("ffprobe fehlgeschlagen")
    aus: list[tuple[float, int, bool]] = []
    for zeile in r.stdout.splitlines():
        teile = zeile.split(",")
        if len(teile) < 3 or teile[0] in ("", "N/A"):
            continue
        try:
            aus.append((float(teile[0]), int(teile[1]), "K" in teile[2]))
        except ValueError:
            continue
    aus.sort(key=lambda p: p[0])
    return aus


def ohne_anlauf(pakete: list[tuple[float, int, bool]]) -> list[tuple[float, int, bool]]:
    """Alles bis einschliesslich des ERSTEN Vollbilds wegwerfen.

    **Ohne das misst die Spitzen-Spalte nichts.** Der Stromanfang traegt in
    JEDER Einstellung ein Vollbild — es ist der Einstiegspunkt, ohne den kein
    Zuschauer anfangen koennte. Beim ersten Lauf dieses Werkzeugs war das
    groesste 100-ms-Fenster deshalb bei 0,5 s, 2 s und 60 s Abstand auf die
    Stelle genau gleich (3045 kbit/s, Fensterbeginn t=0,000) — der Anlauf
    ueberdeckte den gesuchten Unterschied vollstaendig.

    Gesucht sind die WIEDERKEHRENDEN Spitzen. Bleibt danach keine mehr uebrig
    (langer Abstand, kurze Referenz), ist das kein Messfehler, sondern die
    Antwort: dieser Strom hat nach dem Einstieg keine Vollbild-Stoesse mehr.
    """
    for i, (_, _, ist_voll) in enumerate(pakete):
        if ist_voll:
            return pakete[i + 1:]
    return pakete


def spitzen(pakete: list[tuple[float, int, bool]], fenster_s: float) -> dict[str, float]:
    """Groesste und p99-Datenmenge in einem gleitenden Fenster, in kbit/s.

    Gleitend ab JEDEM Paket, nicht in festen Kacheln: eine Kachelgrenze kann
    genau durch ein Vollbild laufen und es auf zwei Fenster aufteilen — dann
    misst man die Spitze weg, die man sucht.
    """
    if not pakete:
        return {"spitze_max_kbps": 0.0, "spitze_p99_kbps": 0.0, "mittel_kbps": 0.0}
    werte: list[float] = []
    j = 0
    summe = 0
    for i, (t0, _, _) in enumerate(pakete):
        while j < len(pakete) and pakete[j][0] < t0 + fenster_s:
            summe += pakete[j][1]
            j += 1
        werte.append(summe * 8 / fenster_s / 1000)
        summe -= pakete[i][1]
    werte.sort()
    dauer = pakete[-1][0] - pakete[0][0]
    gesamt = sum(p[1] for p in pakete)
    return {
        "spitze_max_kbps": werte[-1],
        "spitze_p99_kbps": werte[int(len(werte) * 0.99) - 1 if len(werte) > 1 else 0],
        "mittel_kbps": (gesamt * 8 / dauer / 1000) if dauer > 0 else 0.0,
    }


def bildgewicht(pakete: list[tuple[float, int, bool]]) -> dict[str, float]:
    """Wie schwer ein Vollbild gegenueber einem normalen Bild wiegt."""
    voll = [p[1] for p in pakete if p[2]]
    rest = [p[1] for p in pakete if not p[2]]
    m_voll = sum(voll) / len(voll) if voll else 0.0
    m_rest = sum(rest) / len(rest) if rest else 0.0
    return {
        "vollbilder": float(len(voll)),
        "vollbild_kb": m_voll / 1000,
        "normalbild_kb": m_rest / 1000,
        "faktor": (m_voll / m_rest) if m_rest > 0 else 0.0,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", required=True, type=Path,
                    help="Rohmitschnitt des Encoder-Eingangs (PULSE_DUMP_RAW)")
    ap.add_argument("--kbps", type=int, default=4000)
    ap.add_argument("--fps", type=int, default=60)
    ap.add_argument("--frames", type=int, default=500)
    ap.add_argument("--codec", default="av1_vaapi",
                    help="av1_vaapi/h264_vaapi (AMD, Intel) oder av1_nvenc/h264_nvenc")
    ap.add_argument("--abstaende", default="",
                    help=f"Komma-Liste in Sekunden (Vorgabe: {ABSTAENDE_S})")
    ap.add_argument("--intraref", action="store_true",
                    help="Intra-Refresh als Vergleichspunkt mitfahren (braucht auf VAAPI "
                         "das gepatchte FFmpeg)")
    ap.add_argument("--json", type=Path, default=None, help="Messakte hierhin schreiben")
    args = ap.parse_args()

    prefix = gepatchtes_ffmpeg()
    if prefix is None and args.intraref:
        print("Hinweis: gepatchtes FFmpeg nicht gebaut — der Intra-Refresh-Vergleichspunkt "
              "wird auf VAAPI abgelehnt werden (scripts/hq-bauen.sh baut es).", file=sys.stderr)

    abstaende = ([float(v) for v in args.abstaende.split(",") if v.strip()]
                 if args.abstaende else list(ABSTAENDE_S))

    pix_fmt, w, h = read_header(args.ref.with_suffix(".pts"))
    print(f"Referenz {args.ref.name}: {pix_fmt} {w}x{h}, {args.frames} Bilder, "
          f"{args.kbps} kbps, {args.fps} fps, {args.codec}")
    echtzeit_s = args.frames / args.fps
    print(f"Laufzeit der Referenz: {echtzeit_s:.1f} s — Abstaende darueber koennen "
          f"kein zweites Vollbild mehr zeigen (die Zeile bleibt trotzdem lesbar: "
          f"sie ist dann der Fall 'ein Vollbild am Anfang, danach nichts').")
    print()
    print(f"{'Abstand':>11s} {'VMAF':>8s} {'PSNR':>7s} {'SSIM':>7s} "
          f"{'kbit/s':>8s} {'Spitze':>8s} {'p99':>8s} {'Vollb.':>7s} {'Faktor':>7s}")

    ergebnisse = []
    with tempfile.TemporaryDirectory() as td:
        for name, extra in varianten(args.fps, abstaende, args.codec, args.intraref):
            out = Path(td) / f"g{name}.mkv"
            cmd = encode_cmd(args.ref, pix_fmt, w, h, args.fps, args.kbps,
                             args.frames, out, post=extra, codec=args.codec)
            try:
                encode_lauf(cmd, f"Encode ({name})", prefix)
            except SystemExit as e:
                print(f"{name:>11s}   vom Encoder abgelehnt ({e})")
                continue
            # Auf die Referenzgroesse schneiden: `av1_vaapi` gibt bei 1080
            # dekodiert 1082 Zeilen heraus, und libvmaf verweigert dann den
            # Vergleich (Begruendung bei `measure_vmaf`). Bei passender
            # Groesse ist der Schnitt wirkungslos.
            m = measure_vmaf(out, args.ref, pix_fmt, w, h, args.fps, args.frames,
                             dist_crop=f"{w}:{h}:0:0")
            pk = pakete_lesen(out)
            # Spitzen ohne den Anlauf (s. `ohne_anlauf`) — die mittlere
            # Datenrate aber ueber ALLE Pakete: sie ist die Antwort auf „wieviel
            # geht ueber die Leitung", und da zaehlt das erste Vollbild mit.
            # (Die aus der Spitzenrechnung mitgelieferte mittlere Rate laesst es
            # weg und liegt deshalb rund ein Prozent zu niedrig.)
            sp = spitzen(ohne_anlauf(pk), FENSTER_S)
            sp["mittel_kbps"] = spitzen(pk, FENSTER_S)["mittel_kbps"]
            bg = bildgewicht(pk)
            print(f"{name:>11s} {m['vmaf']:8.3f} {m['psnr_y']:7.2f} {m['float_ssim']:7.4f} "
                  f"{sp['mittel_kbps']:8.0f} {sp['spitze_max_kbps']:8.0f} "
                  f"{sp['spitze_p99_kbps']:8.0f} {bg['vollbilder']:7.0f} {bg['faktor']:7.1f}")
            ergebnisse.append({"abstand": name, **{k: round(v, 4) for k, v in m.items()},
                               **{k: round(v, 2) for k, v in sp.items()},
                               **{k: round(v, 2) for k, v in bg.items()}})

    if args.json:
        args.json.write_text(json.dumps({
            "id": args.json.stem,
            "frage": "Wieviel Bildqualitaet bringt ein laengerer Vollbild-Abstand bei "
                     "fester Datenrate, und wieviel kleiner werden die Sendespitzen?",
            "warum_die_frage_offen_war": "Bis 2026-08-18 gab es dazu keine Zahl — gemessen "
                                          "waren nur die Extreme (allintra) und der Vergleich "
                                          "gegen Intra-Refresh.",
            "aufbau": f"vollbild-abstand.py, Referenz {args.ref.name} ({pix_fmt} {w}x{h}), "
                      f"{args.frames} Bilder, {args.fps} fps, {args.kbps} kbps, {args.codec}. "
                      f"Identische Bilder je Variante, nur -g verschieden.",
            "spitzen_sind_encoder_ausgang_nicht_leitung":
                "Gleitendes 100-ms-Fenster auf den Encoder-Paketen. Der WHIP-Pacer verteilt "
                "sie danach ueber den Bildabstand — das hier ist die Ursache, nicht die "
                "Wirkung beim Zuschauer.",
            "werte": ergebnisse,
        }, indent=2, ensure_ascii=False) + "\n")
        print(f"\nMessakte: {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
