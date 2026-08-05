#!/usr/bin/env python3
"""Ton-Laufzeit am AUSGANG: nativer Player gegen Electron, an einem Durchlauf.

Die Frage kam aus dem Betrieb (2026-08-02): der Ton im Player klingt „minimal
weiter weg vom Original" als in der Electron-App. Am Bild war es nicht zu
entscheiden, am Ton schon — das Ohr loest Zeitversatz besser auf.

**Warum `ton-auswertung.py` das nicht beantwortet.** Jenes Werkzeug liest den
Player-Mitschnitt, und der stempelt die ANKUNFT der Pakete
(`session.rs` reicht `started.elapsed()` weiter). Der Verdacht sitzt aber
dahinter: zwischen Decode und Geraet liegt ein Ring, der bei Unterlauf Stille
auffuellt (`audio.rs`), und eingefuegte Stille schiebt die Tonzeitachse
dauerhaft nach hinten — nichts holt sie wieder ein. Was vor dem Ring gemessen
wird, kann das nicht zeigen. Zudem gibt es fuer Chromium gar keinen
Mitschnitt. Also wird hier gemessen, was wirklich herauskommt.

**Aufbau.** Beide Zuschauer laufen GLEICHZEITIG am selben Stream und geben Ton
aus. Jeder wird auf einen eigenen Null-Sink umgehaengt; ein ffmpeg nimmt beide
Monitore in EINE zweikanalige Datei auf, womit die Zeitachse per Konstruktion
gemeinsam ist. Der 3-kHz-Beep aus `tonsignal.py` steht damit zweimal drin —
einmal je Weg. Die Differenz der Einsatzzeitpunkte ist die gesuchte Zahl, und
sie braucht keinen Anker: sie ist eine Differenz zweier Wege im selben
Mitschnitt. Mit `--start` (dem `*.start.json` von `tonsignal.py`) kommt
zusaetzlich die absolute Laufzeit je Weg heraus, dann aber mit der
Wiedergabelatenz von `pw-play` als Messgrenze.

**Erst den Nulltest, dann die Messung.** `--nulltest` nimmt zweimal DIESELBE
Quelle auf. Die wahre Differenz ist dann null, und was herauskommt, ist der
Fehler des Verfahrens. Ohne diesen Schritt ist jede Zahl unter etwa 10 ms
wertlos — an genau dieser Stelle sind am 2026-07-27 und 2026-07-28 schon zwei
Aussagen gestorben (`rueckname-2026-07-28-browser-drift.json`).

    ./ton-vergleich.py --nulltest --secs 20
    ./ton-vergleich.py --secs 90 [--start tonsignal-ton.start.json]
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np

RATE = 48000
BEEP_HZ = 3000.0
BEEP_MS = 40
#: Mindestabstand zweier Einsaetze. Die Beeps stehen 1 s auseinander, die
#: gesuchten Unterschiede liegen bei Millisekunden — 500 ms trennt sicher,
#: ohne je zwei echte Beeps zu verschmelzen.
MIN_ABSTAND_MS = 500
#: Aufloesung der Einsatzsuche. Feiner als die Beep-Flanke lohnt nicht.
HOP_MS = 1
FENSTER_MS = 5

SINK_A = "pulse_mess_player"
SINK_B = "pulse_mess_electron"


# ── PipeWire-Verdrahtung ────────────────────────────────────────────────────


def pactl(*args: str) -> str:
    return subprocess.run(
        ["pactl", *args], capture_output=True, text=True, check=True
    ).stdout


def null_sink_anlegen(name: str) -> str:
    """Legt einen Null-Sink an und liefert die Modul-ID zum spaeteren Abraeumen."""
    modul = pactl(
        "load-module",
        "module-null-sink",
        f"sink_name={name}",
        f"sink_properties=device.description={name}",
    ).strip()
    return modul


def sink_inputs() -> list[dict]:
    roh = pactl("-f", "json", "list", "sink-inputs")
    return json.loads(roh)


def beschreibung(si: dict) -> str:
    p = si.get("properties", {})
    return " ".join(
        filter(
            None,
            [
                p.get("application.name", ""),
                p.get("media.name", ""),
                p.get("application.process.binary", ""),
            ],
        )
    ).strip()


def finde_input(muster: list[str]) -> dict | None:
    """Erster Sink-Input, dessen Beschreibung eines der Muster enthaelt."""
    for si in sink_inputs():
        text = beschreibung(si).lower()
        if any(m.lower() in text for m in muster):
            return si
    return None


def naechster_input(index: int) -> dict | None:
    """Sink-Input mit dieser Nummer, falls es ihn (noch) gibt."""
    return next((si for si in sink_inputs() if si["index"] == index), None)


def verschiebe(si_index: int, sink: str) -> None:
    pactl("move-sink-input", str(si_index), sink)


# ── Aufnahme ────────────────────────────────────────────────────────────────


def aufnehmen(quelle_a: str, quelle_b: str, sekunden: int, ziel: Path) -> None:
    """Beide Quellen in EINE zweikanalige Datei.

    Ein einziger ffmpeg statt zweier `parec`: nur so tragen beide Spuren
    dieselbe Zeitachse. Zwei Prozesse starten nie im selben Augenblick, und der
    Unterschied waere genau in der Groessenordnung dessen, was gesucht wird.
    """
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "pulse", "-i", quelle_a,
        "-f", "pulse", "-i", quelle_b,
        "-filter_complex", "[0:a][1:a]amerge=inputs=2[a]",
        "-map", "[a]", "-ac", "2", "-ar", str(RATE),
        "-t", str(sekunden), str(ziel),
    ]
    subprocess.run(cmd, check=True)


# ── Auswertung ──────────────────────────────────────────────────────────────


def spuren_lesen(pfad: Path) -> tuple[np.ndarray, np.ndarray]:
    with wave.open(str(pfad), "rb") as w:
        if w.getnchannels() != 2:
            raise SystemExit(f"{pfad}: zwei Kanaele erwartet, {w.getnchannels()} gefunden")
        roh = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
        rate = w.getframerate()
    if rate != RATE:
        raise SystemExit(f"{pfad}: {rate} Hz statt {RATE}")
    paare = roh.reshape(-1, 2).astype(np.float32) / 32768.0
    return paare[:, 0], paare[:, 1]


def spuren_lesen_mono(pfad: Path) -> tuple[np.ndarray, None]:
    """Einkanalige Aufnahme lesen — fuer Messungen, die die Wege NACHEINANDER
    aufnehmen (`ton-laufzeit.py`) statt nebeneinander."""
    with wave.open(str(pfad), "rb") as w:
        kanaele = w.getnchannels()
        roh = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
        rate = w.getframerate()
    if rate != RATE:
        raise SystemExit(f"{pfad}: {rate} Hz statt {RATE}")
    werte = roh.astype(np.float32) / 32768.0
    if kanaele > 1:
        werte = werte.reshape(-1, kanaele).mean(axis=1)
    return werte, None


def beep_energie(signal: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Energie bei [`BEEP_HZ`] je Fenster — Goertzel, kein volles Spektrum.

    Der Dauertraeger (440 Hz) liegt weit genug entfernt, dass ein einzelner
    Bin genuegt; das spart ein FFT ueber Millionen Samples.
    """
    fenster = int(RATE * FENSTER_MS / 1000)
    hop = int(RATE * HOP_MS / 1000)
    n = max(0, (len(signal) - fenster) // hop + 1)
    if n == 0:
        return np.zeros(0), np.zeros(0)
    idx = np.arange(n) * hop
    stuecke = np.lib.stride_tricks.sliding_window_view(signal, fenster)[::hop][:n]
    t = np.arange(fenster) / RATE
    ref = np.exp(-2j * np.pi * BEEP_HZ * t)
    energie = np.abs(stuecke @ ref) / fenster
    return idx / RATE * 1000.0, energie


def einsaetze(zeiten_ms: np.ndarray, energie: np.ndarray) -> list[float]:
    """Einsatzzeitpunkte der Beeps in ms.

    Schwelle relativ zum Lauf selbst (halbe Spitze), damit unterschiedliche
    Lautstaerken der beiden Wege das Ergebnis nicht verschieben — gesucht ist
    der Zeitpunkt, nicht der Pegel.
    """
    if len(energie) == 0 or energie.max() <= 0:
        return []
    schwelle = energie.max() * 0.5
    ueber = energie >= schwelle
    treffer: list[float] = []
    letzter = -1e9
    for i, ist in enumerate(ueber):
        if ist and zeiten_ms[i] - letzter >= MIN_ABSTAND_MS:
            treffer.append(float(zeiten_ms[i]))
            letzter = zeiten_ms[i]
    return treffer


@dataclass
class Ergebnis:
    paare: list[tuple[float, float]]

    @property
    def differenzen(self) -> np.ndarray:
        return np.array([b - a for a, b in self.paare])


def paaren(a: list[float], b: list[float]) -> Ergebnis:
    """Beeps beider Spuren einander zuordnen.

    Zu jedem Einsatz in A der naechstgelegene in B — die Wege liegen
    Millisekunden auseinander, die Beeps aber eine Sekunde. Eine Verwechslung
    ist damit ausgeschlossen, solange die Differenz unter 500 ms bleibt; sonst
    faellt das Paar heraus und wird gemeldet.
    """
    paare: list[tuple[float, float]] = []
    verloren = 0
    for ta in a:
        if not b:
            break
        tb = min(b, key=lambda x: abs(x - ta))
        if abs(tb - ta) > MIN_ABSTAND_MS:
            verloren += 1
            continue
        paare.append((ta, tb))
    if verloren:
        print(f"  Hinweis: {verloren} Einsaetze ohne Gegenstueck (uebersprungen)")
    return Ergebnis(paare)


def berichten(titel: str, erg: Ergebnis, anker_ms: int | None, a: list[float]) -> None:
    print(f"\n=== {titel}")
    if not erg.paare:
        print("  keine Beep-Paare gefunden — lief der Ton auf beiden Wegen?")
        return
    d = erg.differenzen
    print(f"  Beep-Paare:              {len(d)}")
    print(f"  Differenz Median:        {np.median(d):+.1f} ms")
    print(f"  Differenz Mittel:        {d.mean():+.1f} ms")
    print(f"  Spanne:                  {d.min():+.1f} .. {d.max():+.1f} ms")
    print(f"  Streuung (Standardabw.): {d.std():.1f} ms")
    print("  Vorzeichen: positiv = Kanal 2 (Electron) kommt SPAETER als Kanal 1 (Player)")
    if anker_ms is not None:
        print(f"  (absolute Laufzeit gegen den Sendeanker: erste Marke Kanal 1 bei {a[0]:.0f} ms)")


# ── Ablauf ──────────────────────────────────────────────────────────────────


def messen(args) -> int:
    ziel = Path(args.out)
    module: list[str] = []
    try:
        if args.nulltest:
            # **Zweimal dieselbe Quelle aufzunehmen genuegt NICHT.** Das lieferte
            # am 2026-08-02 auf Anhieb 0,0 ms bei null Streuung — und bewies
            # nichts, weil ffmpeg denselben Strom zweimal identisch bedient. Der
            # Weg, der geprueft werden muss, ist der echte: EIN Signal, ZWEI
            # getrennte Sinks, zwei Monitore, zwei Eingaenge. `pw-link` verdrahtet
            # dafuer Ports direkt im Graphen — sample-genau und ohne Zwischenpuffer,
            # anders als ein Loopback-Modul, das selbst Latenz einbraechte.
            quelle = args.quelle or "pulse_mess_stumm"
            print(f"Nulltest: '{quelle}' auf zwei getrennte Sinks, {args.secs} s")
            print("Die wahre Differenz ist null — was herauskommt, ist der Fehler des Verfahrens.")
            module.append(null_sink_anlegen(SINK_A))
            module.append(null_sink_anlegen(SINK_B))
            time.sleep(0.5)
            verdrahtet = 0
            for kanal in ("FL", "FR"):
                for sink in (SINK_A, SINK_B):
                    r = subprocess.run(
                        ["pw-link", f"{quelle}:monitor_{kanal}", f"{sink}:playback_{kanal}"],
                        capture_output=True,
                    )
                    verdrahtet += r.returncode == 0
            if verdrahtet == 0:
                print(f"Keine Verbindung von '{quelle}' — laeuft `tonsignal.py`?")
                return 2
            time.sleep(0.5)
            aufnehmen(f"{SINK_A}.monitor", f"{SINK_B}.monitor", args.secs, ziel)
        else:
            print("Null-Sinks anlegen …")
            module.append(null_sink_anlegen(SINK_A))
            module.append(null_sink_anlegen(SINK_B))
            time.sleep(0.5)

            # **Keine Rateautomatik bei Electron.** Beim Messen laufen ZWEI
            # Electron-Instanzen (die sendende und die zuschauende), und beide
            # melden sich als `Pulse`/`electron`. Eine Automatik traefe die
            # falsche, ohne dass es auffiele — eine Messung, die nicht
            # scheitert, sondern taeuscht. Der Player ist dagegen eindeutig.
            player = (
                naechster_input(args.player_index)
                if args.player_index is not None
                else finde_input(["pulse-player"])
            )
            electron = naechster_input(args.electron_index) if args.electron_index is not None else None
            if player is None or electron is None:
                if player is None:
                    print("\nKein Tonstrom des nativen Players gefunden.")
                if electron is None:
                    print("\n--electron-index fehlt (welche der Instanzen schaut zu?).")
                print("\nLaufende Tonstroeme:")
                for si in sink_inputs():
                    print(f"  [{si['index']}] {beschreibung(si)}")
                print("\nBeide Zuschauer muessen denselben Stream MIT TON wiedergeben.")
                print("Aufruf dann z.B.:  --electron-index 1339 [--player-index N]")
                return 2

            print(f"  Player   -> {SINK_A}: [{player['index']}] {beschreibung(player)}")
            print(f"  Electron -> {SINK_B}: [{electron['index']}] {beschreibung(electron)}")
            verschiebe(player["index"], SINK_A)
            verschiebe(electron["index"], SINK_B)
            time.sleep(0.5)
            print(f"Aufnahme {args.secs} s …")
            aufnehmen(f"{SINK_A}.monitor", f"{SINK_B}.monitor", args.secs, ziel)
    finally:
        for m in module:
            subprocess.run(["pactl", "unload-module", m], check=False)

    links, rechts = spuren_lesen(ziel)
    a = einsaetze(*beep_energie(links))
    b = einsaetze(*beep_energie(rechts))
    print(f"\nEinsaetze: Kanal 1 = {len(a)}, Kanal 2 = {len(b)}")
    anker = None
    if args.start:
        anker = json.loads(Path(args.start).read_text())["start_wall_ms"]
    berichten("Nulltest" if args.nulltest else "Player (Kanal 1) gegen Electron (Kanal 2)",
              paaren(a, b), anker, a)
    print(f"\nMitschnitt: {ziel}")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--secs", type=int, default=90, help="Aufnahmedauer (Vorgabe 90)")
    p.add_argument("--out", default="ton-vergleich.wav")
    p.add_argument("--start", help="tonsignal-*.start.json fuer die absolute Laufzeit")
    p.add_argument("--nulltest", action="store_true", help="Fehler des Verfahrens messen")
    p.add_argument("--quelle", help="Sink fuer den Nulltest (Vorgabe: pulse_mess_stumm)")
    p.add_argument("--player-index", type=int, help="Sink-Input des nativen Players")
    p.add_argument(
        "--electron-index",
        type=int,
        help="Sink-Input der ZUSCHAUENDEN Electron-Instanz (beide heissen gleich)",
    )
    args = p.parse_args()
    if args.secs < 10:
        print("Unter 10 s sind es zu wenige Beeps fuer einen Median.", file=sys.stderr)
        return 2
    return messen(args)


if __name__ == "__main__":
    raise SystemExit(main())
