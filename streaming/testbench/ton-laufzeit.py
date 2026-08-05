#!/usr/bin/env python3
"""Tonlaufzeit: nativer Player gegen Chromium — vollautomatisch, ein Sender.

**Die Frage** (Betrieb, 2026-08-02): der Ton im nativen Player klingt „minimal
weiter weg vom Original" als in der Electron-App. Am Bild war es nicht zu
entscheiden, am Ton schon.

**Warum nicht `ton-auswertung.py`.** Das liest den Player-Mitschnitt, und der
stempelt die ANKUNFT der Pakete. Der Verdacht sitzt dahinter: zwischen Decode
und Geraet liegt ein Ring, der bei Unterlauf Stille auffuellt (`audio.rs`), und
eingefuegte Stille schiebt die Tonzeitachse dauerhaft nach hinten. Fuer
Chromium gibt es ausserdem gar keinen Mitschnitt. Gemessen wird deshalb, was
die Lautsprecher bekommen.

**Das Messprinzip: Phasenlage statt Anker.** Der Sender schickt einen Beep auf
jeder vollen Sekunde der Signalzeit. Jeder Zuschauer gibt ihn verzoegert aus,
und die Verzoegerung zeigt sich als Phasenlage im 1-Sekunden-Raster. Zwei
Abschnitte einer DURCHGEHENDEN Aufnahme — erst der Player, dann Chromium —
lassen sich damit vergleichen, ohne dass irgendeine Uhr zwischen ihnen geteilt
werden muesste. Alles, was beiden gemeinsam ist (Sendeweg, Aufnahmelatenz,
Rasterphase der Quelle), faellt in der Differenz heraus. Das ist der Grund fuer
EINEN Sender und EINE Aufnahme.

**Der Ton wird dreifach auf den Mess-Sink gezwungen** — `PULSE_SINK`, der
umgestellte Standard-Sink und ein nachtraegliches `move-sink-input`. Das ist
kein Guertel-und-Hosentraeger: `PULSE_SINK` allein lieferte am 2026-08-02 eine
durchgehend stumme Aufnahme, weil die Variable nur liest, wer ueber libpulse
geht — der Player nutzt cpal. Ein eigener Sink ist noetig, damit nicht
irgendein anderer Ton des Rechners in der Messung landet.

Vorher pruefen: `ton-vergleich.py --nulltest` (Fehler des Aufnahmewegs).

    ./ton-laufzeit.py --secs 45
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

from harness import HERE, PLAYER, Player, mint_tokens, warte_auf_strom

SINK = "pulse_ton_mess"
RASTER_MS = 1000.0
#: Aufbau (ICE, erster Einstiegspunkt, Puffer-Einschwingen) gehoert nicht in
#: die Zahl. Die ersten Beeps eines Abschnitts fallen deshalb weg.
#:
#: **6 s reichen fuer Chromium NICHT.** Laeuft es als erster Zuschauer am
#: frisch gestarteten Sender, schwankt seine Phasenlage danach noch um mehr als
#: 160 ms (2026-08-02, drei Gegenlaeufe); als zweiter, nach rund 40 s Sender,
#: liegt sie bei 0,0. Der Wert ist deshalb einstellbar — und wer ihn zu klein
#: waehlt, misst das Einschwingen statt der Laufzeit.
AUFBAU_S = int(os.environ.get("PULSE_TON_AUFBAU_S", "6"))


def _laden(name: str):
    pfad = HERE / name
    kurz = name.replace("-", "_")[:-3]
    spec = importlib.util.spec_from_file_location(kurz, pfad)
    modul = importlib.util.module_from_spec(spec)
    # Vor dem Ausfuehren registrieren: `@dataclass` schlaegt sonst fehl, weil
    # es sein eigenes Modul ueber `sys.modules[cls.__module__]` nachschlaegt
    # und dort noch nichts steht.
    sys.modules[kurz] = modul
    spec.loader.exec_module(modul)
    return modul


_tv = _laden("ton-vergleich.py")
_ts = _laden("tonsignal.py")


# ── Sender ──────────────────────────────────────────────────────────────────


def start_push_mit_beeps(path: str, token: str, beeps: Path, log) -> subprocess.Popen:
    """Video aus der Pruefstand-Vorlage, Ton aus der Beep-Datei.

    Der Ton MUSS als Opus gehen: ueber WHEP landet er unveraendert in einer
    WebRTC-Sitzung, und die traegt kein AAC. Video bleibt eine Kopie — es wird
    hier nicht gemessen und soll keine Encoder-Zeit kosten.
    """
    from harness import SOURCE

    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "warning",
        "-re", "-stream_loop", "-1", "-i", str(SOURCE),
        "-re", "-i", str(beeps),
        "-map", "0:v", "-map", "1:a",
        "-c:v", "copy", "-c:a", "libopus", "-b:a", "96k",
        "-f", "flv", "-tls_verify", "0",
        f"rtmps://localhost:1936/{path}?token={token}",
    ]
    return subprocess.Popen(cmd, stdout=log, stderr=log)


# ── Zuschauer ───────────────────────────────────────────────────────────────


def einsammeln(bekannt: set[int]) -> set[int]:
    """Neu hinzugekommene Tonstroeme auf den Mess-Sink holen.

    **`PULSE_SINK` allein genuegt nicht** (2026-08-02 gemessen: Aufnahme
    durchgehend stumm). Die Variable liest nur, wer ueber libpulse geht — der
    Player nutzt cpal und landet je nach Bau auf ALSA. Deshalb wird der
    Standard-Sink umgestellt UND nachtraeglich verschoben, was trotzdem
    woanders auftaucht. Weil immer nur EIN Zuschauer laeuft, ist die Zuordnung
    eindeutig; eine Namenserkennung braucht es nicht.
    """
    neu = set()
    for si in _tv.sink_inputs():
        if si["index"] not in bekannt:
            neu.add(si["index"])
            try:
                _tv.verschiebe(si["index"], SINK)
            except subprocess.CalledProcessError:
                pass
    return neu


def lauf_player(whep: str, sekunden: float, log) -> tuple[float, float]:
    """Nativer Player fuer `sekunden`. Liefert (start, ende) als Monotonzeit."""
    vorher = {si["index"] for si in _tv.sink_inputs()}
    p = Player(log, env_extra={"PULSE_SINK": SINK})
    try:
        res = p.call("open", url=whep, title="Tonlaufzeit Player", options={})
        if not res.get("ok"):
            raise RuntimeError(f"player open: {res}")
        start = time.monotonic()
        time.sleep(2.0)
        einsammeln(vorher)
        time.sleep(sekunden)
        return start, time.monotonic()
    finally:
        p.stop()


def lauf_browser(whep: str, sekunden: float, log) -> tuple[float, float]:
    """Chromium (derselbe, den Playwright fuer E2E nutzt) fuer `sekunden`.

    `--sichtbar` ist Pflicht und keine Bequemlichkeit: headless dekodiert ueber
    die Software-Anbindung, und ohne Fenster gibt Chromium keinen Ton aus.
    """
    umgebung = {**os.environ, "PULSE_SINK": SINK}
    vorher = {si["index"] for si in _tv.sink_inputs()}
    proc = subprocess.Popen(
        ["node", str(HERE / "browser-whep.mjs"), "--url", whep,
         "--secs", str(int(sekunden) + 8), "--ton", "--sichtbar", "--label", "tonlaufzeit"],
        stdout=log, stderr=log, env=umgebung,
    )
    try:
        # Chromium braucht bis zum ersten Ton laenger als der Player (Start,
        # Seite, ICE) — die Aufbauzeit wird unten ohnehin abgeschnitten.
        start = time.monotonic()
        time.sleep(6.0)
        einsammeln(vorher)
        time.sleep(sekunden)
        return start, time.monotonic()
    finally:
        proc.send_signal(signal.SIGINT)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


# ── Auswertung ──────────────────────────────────────────────────────────────


def phase_kreis(zeiten_ms: list[float]) -> tuple[float, float]:
    """Mittlere Phasenlage im 1-s-Raster und ihre Streuung, zirkulaer.

    Zirkulaer, weil die Phase bei 0 und bei 1000 dasselbe bedeutet: ein
    arithmetisches Mittel ueber 995 und 5 ms ergaebe 500 statt 0 — der Fehler,
    der eine Laufzeit von wenigen Millisekunden in eine halbe Sekunde
    verwandelt.
    """
    if not zeiten_ms:
        return math.nan, math.nan
    winkel = np.array([2 * math.pi * (t % RASTER_MS) / RASTER_MS for t in zeiten_ms])
    v = np.exp(1j * winkel).mean()
    mittel = (math.atan2(v.imag, v.real) % (2 * math.pi)) / (2 * math.pi) * RASTER_MS
    # Laenge des Summenvektors: 1 = alle gleich, 0 = gleichverteilt.
    streuung = math.sqrt(max(0.0, -2 * math.log(abs(v)))) / (2 * math.pi) * RASTER_MS
    return mittel, streuung


def differenz_kreis(a: float, b: float) -> float:
    """b - a im Raster, ins Intervall (-500, 500] gebracht."""
    d = (b - a) % RASTER_MS
    return d - RASTER_MS if d > RASTER_MS / 2 else d


def abschnitt(alle: list[float], t0: float, t1: float, aufnahme_start: float) -> list[float]:
    """Beeps, die zwischen t0 und t1 (Monotonzeit) aufgenommen wurden."""
    von = (t0 - aufnahme_start) * 1000 + AUFBAU_S * 1000
    bis = (t1 - aufnahme_start) * 1000
    return [t for t in alle if von <= t <= bis]


def berichten(name: str, beeps: list[float]) -> float:
    mittel, streuung = phase_kreis(beeps)
    print(f"  {name:<10} Beeps {len(beeps):>3}   Phase {mittel:7.1f} ms   Streuung {streuung:5.1f} ms")
    return mittel


# ── Ablauf ──────────────────────────────────────────────────────────────────


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--secs", type=float, default=45.0, help="Messdauer je Weg")
    ap.add_argument("--out", default=str(HERE / "ton-laufzeit.wav"))
    ap.add_argument("--tauschen", action="store_true",
                    help="erst Chromium, dann Player — Gegenprobe auf Reihenfolge-Effekte")
    args = ap.parse_args()

    if not PLAYER.exists():
        print(f"Player-Binary fehlt: {PLAYER}", file=sys.stderr)
        return 1

    beeps = HERE / "ton-laufzeit-signal.wav"
    gesamt = int(2 * args.secs + 4 * AUFBAU_S + 30)
    print(f"Signal erzeugen ({gesamt} s, Beep je Sekunde) …")
    _ts.erzeugen(gesamt, beeps)

    push_log = open(HERE / "push-tonlaufzeit.log", "w")
    player_log = open(HERE / "player-tonlaufzeit.log", "w")
    browser_log = open(HERE / "browser-tonlaufzeit.log", "w")
    modul = None
    vorheriger_sink = ""
    aufnahme = None
    push = None
    try:
        modul = _tv.null_sink_anlegen(SINK)
        time.sleep(0.5)
        vorheriger_sink = subprocess.run(
            ["pactl", "get-default-sink"], capture_output=True, text=True
        ).stdout.strip()
        subprocess.run(["pactl", "set-default-sink", SINK], check=False)

        path, pub, rd = mint_tokens()
        whep = f"http://localhost:8889/{path}/whep?token={rd}"
        print(f"Sender startet, Pfad {path}")
        push = start_push_mit_beeps(path, pub, beeps, push_log)
        if not warte_auf_strom(path, push):
            return 1

        print(f"Aufnahme laeuft ({SINK}.monitor) …")
        aufnahme_start = time.monotonic()
        aufnahme = subprocess.Popen(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
             "-f", "pulse", "-i", f"{SINK}.monitor",
             "-ac", "1", "-ar", str(_tv.RATE), str(args.out)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.PIPE,
        )
        time.sleep(1.0)

        # Reihenfolge umkehrbar, und das ist keine Bequemlichkeit: laufen beide
        # Wege immer in derselben Folge, kann alles, was sich WAEHREND der
        # Aufnahme einpegelt (Sender, MediaMTX, Geraetepuffer), als Unterschied
        # zwischen ihnen erscheinen. Erst der Gegenlauf trennt den Weg von
        # seinem Platz in der Reihe.
        if args.tauschen:
            print(f"Lauf 1: Chromium, {args.secs:.0f} s")
            b_von, b_bis = lauf_browser(whep, args.secs, browser_log)
            time.sleep(3.0)
            print(f"Lauf 2: nativer Player, {args.secs:.0f} s")
            p_von, p_bis = lauf_player(whep, args.secs, player_log)
        else:
            print(f"Lauf 1: nativer Player, {args.secs:.0f} s")
            p_von, p_bis = lauf_player(whep, args.secs, player_log)
            time.sleep(3.0)
            print(f"Lauf 2: Chromium, {args.secs:.0f} s")
            b_von, b_bis = lauf_browser(whep, args.secs, browser_log)
        time.sleep(1.0)
    finally:
        if aufnahme is not None:
            aufnahme.send_signal(signal.SIGINT)
            try:
                aufnahme.wait(timeout=10)
            except subprocess.TimeoutExpired:
                aufnahme.kill()
        if push is not None:
            push.send_signal(signal.SIGINT)
            try:
                push.wait(timeout=5)
            except subprocess.TimeoutExpired:
                push.kill()
        if vorheriger_sink:
            subprocess.run(["pactl", "set-default-sink", vorheriger_sink], check=False)
        if modul:
            subprocess.run(["pactl", "unload-module", modul], check=False)
        for f in (push_log, player_log, browser_log):
            f.close()

    signal_arr, _ = _tv.spuren_lesen_mono(Path(args.out))
    alle = _tv.einsaetze(*_tv.beep_energie(signal_arr))
    print(f"\nBeeps in der Aufnahme: {len(alle)}")

    p_beeps = abschnitt(alle, p_von, p_bis, aufnahme_start)
    b_beeps = abschnitt(alle, b_von, b_bis, aufnahme_start)
    print("\n=== Phasenlage im 1-Sekunden-Raster")
    p_phase = berichten("Player", p_beeps)
    b_phase = berichten("Chromium", b_beeps)

    if not p_beeps or not b_beeps:
        print("\nEin Abschnitt ist leer — gab dieser Weg wirklich Ton aus?")
        print(f"Logs: {player_log.name}, {browser_log.name}")
        return 1

    d = differenz_kreis(p_phase, b_phase)
    print(f"\n  Chromium gegen Player: {d:+.1f} ms")
    print("  (positiv = Chromium spaeter, negativ = Player spaeter)")
    print(f"\nMitschnitt: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
