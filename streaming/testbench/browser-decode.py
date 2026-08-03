#!/usr/bin/env python3
"""Dekodiert Chromium den HQ-Stream in Hardware? — am echten WHEP-Weg gemessen.

WARUM ES DAS BRAUCHT: Am 2026-07-26 wurde bereits gemessen, dass Chromium auf
dieser Maschine kein NVDEC benutzt — auch nicht mit VA-API-Schaltern,
`LIBVA_DRIVER_NAME=nvidia` und `--use-gl=egl` (Doku:
`docs/2026-07-26-chromium-10bit-messung.md` §3). Diese Messung lief aber am
`<video>`-Pfad mit lokalen Dateien, und WebRTC hat in Chromium eine **eigene**
Decoder-Kette. Genau das steht dort unter "Offen" — und genau das misst dieses
Skript: denselben Vergleich am echten WHEP-Stream, im Browser UND in der
Electron-Fassung der App.

DREI ACHSEN, WEIL KEINE EINZELNE TRAEGT:

1. `powerEfficientDecoder` — libwebrtcs eigene Ja/Nein-Auskunft.
2. `decoderImplementation` + Decode-Zeit je Bild — der Name allein luegt
   bekanntermassen (er meldet Hardware, waehrend der Decode in Software
   zurueckfaellt; deshalb existiert `VaapiIgnoreDriverChecks` ueberhaupt).
3. **NVDEC-Auslastung der Karte** — die einzige Achse ausserhalb des
   Messobjekts. Sie entscheidet im Zweifel.

Ohne die Kontrollmessung waere Achse 3 wertlos: "0 %" beweist nur dann
Software-Decode, wenn der Zaehler bei echtem Hardware-Decode auch anschlaegt.
Deshalb laeuft vorweg immer `ffmpeg -hwaccel cuda` ueber dieselbe Vorlage.

    ./browser-decode.py                     # alle Varianten, Vorgabe AV1 10 bit
    ./browser-decode.py --quelle synth8-h264.mkv --label h264
    ./browser-decode.py --nur basis,vaapi   # nur einzelne Varianten

Voraussetzungen wie beim uebrigen Pruefstand: MediaMTX, Redis auf 6380,
`mediamtx-auth-hook` auf 8005 (`scripts/dev-up.fish`). Fuer `--electron`
zusaetzlich ein gebautes `desktop/electron/dist` (`cd desktop && pnpm
run build:electron`).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

import harness
from gpuload import GpuLoad, available as gpu_verfuegbar

HIER = Path(__file__).resolve().parent

# Die VA-API-Schalter in der Fassung, die fuer Chromium 150 gilt. `VaapiVideoDecoder`
# aus aelteren Anleitungen ist WIRKUNGSLOS — seit Chromium 131 heisst das Feature
# `AcceleratedVideoDecodeLinuxGL`. Ein unbekannter Feature-Name wird still
# ignoriert, die Messung saehe also wie ein "Flags helfen nicht" aus, obwohl in
# Wahrheit gar nichts eingeschaltet war.
VAAPI_FEATURES = ",".join([
    "AcceleratedVideoDecodeLinuxGL",
    "AcceleratedVideoDecodeLinuxZeroCopyGL",
    # Ohne diesen meldet die GPU-Seite gern "hardware accelerated", waehrend der
    # Decode zur Laufzeit scheitert und still auf Software zurueckfaellt.
    "VaapiIgnoreDriverChecks",
    # Auf NVIDIA in Chromium ab Werk AUS und ausdruecklich als Testschalter
    # deklariert — ohne ihn ist der VA-API-Weg auf dieser Karte gar nicht erst
    # offen, und alles andere waere umsonst gesetzt.
    "VaapiOnNvidiaGPUs",
])
VAAPI_FLAGS = f"--enable-features={VAAPI_FEATURES},--ignore-gpu-blocklist"
VAAPI_ENV = ["--env", "LIBVA_DRIVER_NAME=nvidia"]

# (Name, zusaetzliche browser-whep-Argumente, Erklaerung fuers Protokoll)
VARIANTEN: dict[str, tuple[list[str], str]] = {
    "basis": ([], "Chromium unveraendert — der heutige Auslieferzustand"),
    "vaapi": (["--flags", VAAPI_FLAGS, *VAAPI_ENV],
              "mit VA-API-Schaltern und NVDEC-Treiber"),
    # Der GL-Unterbau war 2026-07-26 im <video>-Pfad die letzte Stellschraube,
    # die noch etwas haette aendern koennen. Sie aenderte nichts — hier steht
    # sie erneut zur Probe, weil der WebRTC-Pfad ein anderer ist.
    "vaapi-egl": (["--flags", f"{VAAPI_FLAGS},--use-gl=egl", *VAAPI_ENV],
                  "wie vaapi, zusaetzlich EGL statt der Vorgabe"),
    "electron": (["--electron"],
                 "die Electron-App wie ausgeliefert"),
    "electron-vaapi": (["--electron", "--flags", VAAPI_FLAGS, *VAAPI_ENV],
                       "die Electron-App mit denselben Schaltern"),
}


def nvdec_kontrolle(quelle: Path, log) -> float:
    """Belegt, dass der NVDEC-Zaehler ueberhaupt anschlaegt.

    Ein "0 %" im Messlauf ist nur dann ein Befund, wenn hier ein deutlicher
    Ausschlag steht. Sonst misst man ein kaputtes Messgeraet.
    """
    with GpuLoad(HIER / "gpu-kontrolle.log") as g:
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error",
             "-hwaccel", "cuda", "-hwaccel_output_format", "cuda",
             "-stream_loop", "2", "-i", str(quelle), "-f", "null", "-"],
            stdout=log, stderr=log, timeout=180,
        )
        time.sleep(1.0)
    return dec_spitze(g)


def dec_spitze(g: GpuLoad) -> float:
    """Hoechster NVDEC-Wert des Laufs (Index 2 = `dec` in `nvidia-smi dmon`).

    Die SPITZE, nicht der Mittelwert: An- und Abfahrt des Zuschauers liegen mit
    im Fenster und zoegen jeden Mittelwert gegen null, auch wenn waehrend der
    Wiedergabe sauber dekodiert wurde.
    """
    nutz = [s[2] for s in g.samples[2:]]
    return float(max(nutz)) if nutz else 0.0


def lauf(name: str, extra: list[str], whep: str, secs: float, label: str,
         sichtbar: bool, log) -> dict:
    """Eine Variante fahren; liefert die Kennzahlen als dict."""
    voll = f"{label}-{name}"
    cmd = ["node", str(HIER / "browser-whep.mjs"),
           "--url", whep, "--secs", str(secs), "--label", voll, *extra]
    # SICHTBAR ist Pflicht, nicht Geschmack: ein headless Chromium dekodiert
    # ueber die Software-Anbindung. Headless zu messen hiesse, das Ergebnis
    # "Software" schon in den Aufbau zu legen (s. browser-whep.mjs).
    if sichtbar and "--electron" not in extra:
        cmd.append("--sichtbar")

    with GpuLoad(HIER / f"gpu-{voll}.log") as g:
        fertig = subprocess.run(cmd, capture_output=True, text=True,
                                timeout=secs + 120, cwd=HIER)
    log.write(f"\n===== {voll} =====\n{fertig.stdout}\n{fertig.stderr}\n")
    log.flush()

    # Der GL-Treiber belegt, dass der Browser ueberhaupt an der Karte war —
    # ohne ihn koennte "Software" ein Artefakt des Aufbaus sein (s. gpuAuskunft
    # in browser-whep.mjs).
    gl = re.search(r"GL-Treiber: (.+)", fertig.stdout or "")
    ergebnis: dict = {"variante": name, "nvdec_spitze": dec_spitze(g),
                      "gl_treiber": gl.group(1).strip() if gl else None}
    if fertig.returncode != 0:
        ergebnis["fehler"] = (fertig.stderr or fertig.stdout or "").strip()[-300:]
        return ergebnis

    proben_datei = HIER / f"browser-proben-{voll}.json"
    if not proben_datei.exists():
        ergebnis["fehler"] = "keine Probendatei"
        return ergebnis
    proben = json.loads(proben_datei.read_text())
    gut = [p for p in proben if p.get("framesDecoded")]
    if len(gut) < 2:
        ergebnis["fehler"] = "zu wenige brauchbare Proben (kam Bild an?)"
        return ergebnis

    erste, letzte = gut[0], gut[-1]
    bilder = (letzte.get("framesDecoded") or 0) - (erste.get("framesDecoded") or 0)
    dt = (letzte.get("totalDecodeTime") or 0) - (erste.get("totalDecodeTime") or 0)
    ergebnis.update({
        "bilder": bilder,
        "sparsam": letzte.get("powerEfficientDecoder"),
        "decoder": letzte.get("decoderImplementation"),
        "codec": letzte.get("mimeType"),
        "aufloesung": f"{letzte.get('frameWidth')}x{letzte.get('frameHeight')}",
        "ms_je_bild": round(dt * 1000 / bilder, 2) if bilder else None,
    })
    return ergebnis


def urteil(r: dict, kontrolle: float) -> str:
    """Die drei Achsen zu einem Satz zusammenziehen — inklusive Widerspruch."""
    if "fehler" in r:
        return "nicht gemessen"
    hw_nvdec = r["nvdec_spitze"] >= max(5.0, kontrolle * 0.15)
    hw_sagt = r.get("sparsam") is True
    if hw_nvdec and hw_sagt:
        return "HARDWARE"
    if not hw_nvdec and not hw_sagt:
        return "Software"
    # Beide Seiten uneins — das ist genau der Fall, vor dem
    # `VaapiIgnoreDriverChecks` warnt. Nicht glaetten, sondern zeigen.
    if hw_sagt:
        return "WIDERSPRUCH: Selbstauskunft sagt Hardware, NVDEC ruht"
    return "WIDERSPRUCH: NVDEC laeuft, Selbstauskunft sagt Software"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--secs", type=float, default=20.0)
    ap.add_argument("--label", default="dec")
    ap.add_argument("--quelle", default="synth10.mkv",
                    help="Vorlage im testbench-Verzeichnis (Vorgabe: AV1 10 bit)")
    ap.add_argument("--nur", default="",
                    help=f"Teilmenge, komma-getrennt aus: {','.join(VARIANTEN)}")
    ap.add_argument("--headless", action="store_true",
                    help="ohne Fenster — misst dann garantiert Software, s. Doku")
    a = ap.parse_args()

    quelle = HIER / a.quelle
    if not quelle.exists():
        print(f"Vorlage fehlt: {quelle}", file=sys.stderr)
        return 2
    if not shutil.which("node"):
        print("node fehlt", file=sys.stderr)
        return 2
    namen = [n.strip() for n in a.nur.split(",") if n.strip()] or list(VARIANTEN)
    unbekannt = [n for n in namen if n not in VARIANTEN]
    if unbekannt:
        print(f"unbekannte Variante(n): {', '.join(unbekannt)}", file=sys.stderr)
        return 2

    os.environ["PULSE_HARNESS_SOURCE"] = str(quelle)
    harness.SOURCE = quelle

    log_pfad = HIER / f"decode-{a.label}.log"
    with log_pfad.open("w") as log:
        if not gpu_verfuegbar():
            print("WARNUNG: kein nvidia-smi — die entscheidende dritte Achse fehlt.",
                  file=sys.stderr)
            kontrolle = 0.0
        else:
            print("Kontrollmessung (ffmpeg -hwaccel cuda) …")
            kontrolle = nvdec_kontrolle(quelle, log)
            print(f"  NVDEC-Spitze bei echtem Hardware-Decode: {kontrolle:.0f} %")
            if kontrolle < 5:
                print("  ABBRUCH: Der Zaehler schlaegt nicht an. Ohne ihn waere jedes\n"
                      "  '0 %' unten bedeutungslos.", file=sys.stderr)
                return 1

        path, pub, rd = harness.mint_tokens()
        whep = f"http://localhost:8889/{path}/whep?token={rd}"
        push = harness.start_push(path, pub, audio=True, log=log)
        try:
            if not harness.warte_auf_strom(path, push):
                return 1
            print(f"Sender laeuft ({quelle.name}). Varianten: {', '.join(namen)}\n")
            ergebnisse = []
            for name in namen:
                extra, erklaerung = VARIANTEN[name]
                print(f"  {name} — {erklaerung} …")
                r = lauf(name, extra, whep, a.secs, a.label, not a.headless, log)
                r["erklaerung"] = erklaerung
                ergebnisse.append(r)
                if "fehler" in r:
                    print(f"    FEHLER: {r['fehler']}")
                else:
                    print(f"    NVDEC-Spitze {r['nvdec_spitze']:.0f} %, "
                          f"{r['ms_je_bild']} ms/Bild, {r['bilder']} Bilder")
        finally:
            push.terminate()
            try:
                push.wait(timeout=10)
            except subprocess.TimeoutExpired:
                push.kill()

    bericht(ergebnisse, kontrolle, quelle, a, log_pfad)
    return 0


def bericht(ergebnisse: list[dict], kontrolle: float, quelle: Path,
            a: argparse.Namespace, log_pfad: Path) -> None:
    print(f"\n{'=' * 78}\nHardware-Decode im WHEP-Weg — {quelle.name}, {a.secs:.0f}s je Variante")
    print(f"Kontrolle: echter Hardware-Decode treibt NVDEC auf {kontrolle:.0f} %\n")
    kopf = f"{'Variante':<16} {'NVDEC':>7} {'sparsam':>9} {'ms/Bild':>9}  {'Decoder':<22} Urteil"
    print(kopf)
    print("-" * 78)
    for r in ergebnisse:
        if "fehler" in r:
            print(f"{r['variante']:<16} {'—':>7} {'—':>9} {'—':>9}  "
                  f"{'—':<22} {r['fehler'][:40]}")
            continue
        print(f"{r['variante']:<16} {r['nvdec_spitze']:>6.0f}% "
              f"{str(r.get('sparsam')):>9} {str(r.get('ms_je_bild')):>9}  "
              f"{str(r.get('decoder'))[:22]:<22} {urteil(r, kontrolle)}")
    for r in ergebnisse:
        if r.get("gl_treiber"):
            print(f"  {r['variante']:<14} GL: {r['gl_treiber']}")
    codecs = {r.get("codec") for r in ergebnisse if r.get("codec")}
    if codecs:
        print(f"\nCodec laut Zuschauer: {', '.join(sorted(c for c in codecs if c))}")
    ziel = HIER / f"decode-{a.label}.json"
    ziel.write_text(json.dumps(
        {"quelle": quelle.name, "secs": a.secs, "kontrolle_nvdec": kontrolle,
         "ergebnisse": ergebnisse}, indent=1))
    print(f"\nRoh: {ziel.name} · Protokoll: {log_pfad.name} · "
          f"Proben: browser-proben-{a.label}-*.json")


if __name__ == "__main__":
    sys.exit(main())
