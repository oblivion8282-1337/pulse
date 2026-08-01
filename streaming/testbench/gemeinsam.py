"""Bausteine, die sich die Ansicht-Werkzeuge teilen.

``ansehen.py``, ``verzoegerung.py`` und ``zeigen.py`` werfen alle denselben
Sender auf dieselbe Weise an und muessen alle dieselben Skripte nachladen, deren
Name einen Bindestrich traegt. Beides steht deshalb hier EINMAL — sonst gibt es
drei Fassungen davon, wie ein Sender gestartet wird, und sie laufen
auseinander, sobald sich am Aufruf etwas aendert.

Absichtlich NICHT hier: die Argumente der drei. Sie sehen nur aehnlich aus —
die Voreinstellungen fuer die Bitrate unterscheiden sich, ``zeigen.py`` kennt
kein SRT und hat eine eigene Option. Ein gemeinsamer Parser mit einem Schalter
je Abweichung waere schwerer zu lesen als drei kurze Bloecke.

Kein Programm, nur ein Modul: die drei Werkzeuge bleiben einzeln aufrufbar.
"""

from __future__ import annotations

import atexit
import importlib.util
import os
import shutil
import signal
import subprocess
import sys
from pathlib import Path

from harness import CID, HERE

# Der Idle-Manager dieser Maschine. `systemd-inhibit` greift hier INS LEERE:
# in `logind.conf` ist `IdleAction` gar nicht gesetzt (Vorgabe `ignore`), es
# gibt also nichts zu hemmen — das Abschalten kommt von der Shell.
# Nachgeprüft 2026-07-31. Auf einer anderen Maschine (swayidle, hypridle,
# GNOME) gehört hier deren Gegenstück hin; fehlt das Werkzeug, passiert
# schlicht nichts.
_IDLE_BEFEHL = ("dms", "ipc", "call", "inhibit")
_idle_gehemmt = False


def zustand_pruefen(streng: bool = True) -> list[str]:
    """Ist die Maschine ueberhaupt in einem Zustand, in dem gemessen werden darf?

    **Warum das vor jedem Lauf steht.** Am 2026-08-01 haben sechs vergessene
    `mpv`-Prozesse (aus `bewegtbild.py`, das SIGTERM nicht abfing) anderthalb
    Stunden lang jede Messung verdorben: `gpu_busy_percent` stand auf 99, die
    Hardware-Dekodierung fiel von 159 auf 30 Bilder je Sekunde, und der
    Messlauf sah aus, als koenne die Karte kein H.264. Aus dieser einen
    Verunreinigung sind ZWEI falsche Befunde entstanden, beide plausibel
    erzaehlt, beide committet, beide spaeter zu korrigieren.

    Der Pruefstand liefert Zahlen, egal was die Maschine sonst tut — er warnt
    nur nicht. Genau das holt diese Funktion nach.

    Geprueft wird, was heute wirklich schiefging, nicht was schiefgehen
    koennte:

    * **Fremde Video-Prozesse** (mpv, ffmpeg, ein zweiter Sender oder Player).
      Das ist der harte Fall — er verfaelscht Encode- wie Decode-Messungen.
    * **GPU-Grundlast** ueber einer Schwelle, auch ohne erkennbaren
      Verursacher. Faengt den Fall, in dem der Schuldige anders heisst.
    * **Liegengebliebene `tc`-Regeln** aus einem abgebrochenen Verlust-Lauf.
      Eine vergessene Stoerstrecke ist dieselbe Art Fehler: sie wirkt, ohne
      im Protokoll zu stehen.

    `streng=True` bricht ab, `False` meldet nur. Rueckgabe ist die Liste der
    Befunde — leer heisst sauber.
    """
    befunde: list[str] = []

    # 1. VERWAISTE mpv. Nicht "irgendein mpv": ein Bewegtbild, das zu diesem
    #    Lauf gehoert, ist erwuenscht und hat einen lebenden `bewegtbild.py`
    #    als Elternprozess. Genau der fehlt im Schadensfall — das Python stirbt
    #    an SIGTERM, die mpv laufen als Waisen weiter. Ein Waechter, der auch
    #    das richtige Bewegtbild anmeckert, wird nach dem zweiten Mal
    #    abgeschaltet; deshalb die Unterscheidung statt eines Pauschalverbots.
    for pid in subprocess.run(["pgrep", "-x", "mpv"],
                              capture_output=True, text=True).stdout.split():
        try:
            eltern = int((Path("/proc") / pid / "stat").read_text().split(") ", 1)[1].split()[1])
            elternname = (Path("/proc") / str(eltern) / "cmdline").read_bytes().decode(
                "utf-8", "replace")
        except (OSError, IndexError, ValueError):
            continue
        if "bewegtbild" not in elternname:
            befunde.append(f"verwaiste mpv (PID {pid}, Elternprozess {eltern}) — "
                           f"sie dekodiert weiter und verfaelscht jede Messung")

    # 2. GPU-Grundlast — aber NUR ohne laufendes Bewegtbild. Mit ihm sind 80
    #    Prozent der Normalfall (es dekodiert auf jedem Schirm), die Zahl sagt
    #    dann nichts. Ohne es bedeutet eine hohe Grundlast, dass etwas rechnet,
    #    das hier niemand bestellt hat — der Fall, den die Waisen-Pruefung oben
    #    nicht faengt, weil der Verursacher anders heisst.
    #
    #    Nur AMD/Intel liefern diese Datei; auf NVIDIA fehlt sie und die
    #    Pruefung entfaellt still (dort haette `nvidia-smi` die Zahl).
    bewegtbild_laeuft = bool(subprocess.run(
        ["pgrep", "-f", "bewegtbild.py"], capture_output=True, text=True).stdout.strip())
    for karte in ([] if bewegtbild_laeuft
                  else sorted(Path("/sys/class/drm").glob("card*/device/gpu_busy_percent"))):
        try:
            last = int(karte.read_text().strip())
        except (OSError, ValueError):
            continue
        if last > 40:
            befunde.append(f"GPU-Grundlast {last} % ({karte.parents[1].name}) — "
                           f"da rechnet etwas mit")
        break

    # 3. Liegengebliebene Stoerstrecke. `tc` liegt in /usr/sbin und ist im PATH
    #    eines normalen Nutzers oft nicht — fehlt es, entfaellt die Pruefung
    #    still. Ein Waechter, der den Lauf umbringt, weil er selbst nicht
    #    laufen kann, waere schlimmer als gar keiner.
    tc = shutil.which("tc") or "/usr/sbin/tc"
    try:
        r = subprocess.run([tc, "qdisc", "show"], capture_output=True, text=True)
        if "netem" in r.stdout:
            befunde.append("eine netem-Regel liegt noch an (verluststrecke.py --aus)")
    except OSError:
        pass

    if befunde:
        for b in befunde:
            print(f"[zustand] {b}", file=sys.stderr)
        if streng:
            print("[zustand] Messung abgebrochen. Wer trotzdem messen will: "
                  "PULSE_ZUSTAND_EGAL=1", file=sys.stderr)
            raise SystemExit(2)
    return befunde


def bildschirm_wachhalten() -> None:
    """Bildschirmabschaltung für die Dauer des Laufs unterbinden.

    **Warum das eine Messgröße ist:** Ein dunkler Schirm liefert keine Bilder —
    der Compositor sendet nur bei Damage. Der Sender wiederholt dann brav sein
    letztes Bild, die Aufnahme meldet `duplicates == frames`, und die Messung
    sieht aus wie ein Aussetzer des Senders. Beim Zeitmuster (`--e2e`) ist es
    schlimmer: ein Bildschirmschoner verdeckt die Balken, der Player liest
    nichts zurück, und „ohne Muster" steigt still.

    Hebt sich selbst wieder auf — auch bei Strg-C und bei einem Abbruch, wie
    es `zeigen.py` mit den `tc`-Regeln hält.
    """
    global _idle_gehemmt
    if _idle_gehemmt or not shutil.which(_IDLE_BEFEHL[0]):
        return
    if subprocess.run([*_IDLE_BEFEHL, "enable"], capture_output=True).returncode != 0:
        return
    _idle_gehemmt = True
    atexit.register(bildschirm_freigeben)
    for sig in (signal.SIGINT, signal.SIGTERM):
        vorher = signal.getsignal(sig)
        def _weiter(s, rahmen, _vorher=vorher):
            bildschirm_freigeben()
            if callable(_vorher):
                _vorher(s, rahmen)
            else:
                raise KeyboardInterrupt
        signal.signal(sig, _weiter)


def bildschirm_freigeben() -> None:
    global _idle_gehemmt
    if _idle_gehemmt:
        _idle_gehemmt = False
        subprocess.run([*_IDLE_BEFEHL, "disable"], capture_output=True)


def laden(datei: str):
    """Modul mit Bindestrich im Namen laden.

    ``fern-harness.py``, ``netz-harness.py`` und ``real-harness.py`` sind als
    Programme benannt, nicht als Module — ein ``import`` waere ein
    Syntaxfehler. Die Bausteine daraus hier nachzubauen waere schlimmer: dann
    gaebe es zwei Fassungen davon, wie ein Sender gestartet und eine Stoerung
    gesetzt wird, und sie wuerden auseinanderlaufen.
    """
    spec = importlib.util.spec_from_file_location(datei.replace("-", "_"), HERE / f"{datei}.py")
    modul = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(modul)
    return modul


def sender_starten(sender, args, token: str, push_url: str, warte_s: float = 90.0) -> bool:
    """Den Sender anwerfen und warten, bis er WIRKLICH sendet.

    Die Antwort auf ``start`` sagt nur, dass der Worker-Faden angeworfen wurde
    (``stream_controller.rs::start`` spawnt und gibt sofort zurueck) — Portal,
    Encoder und Push kommen alle erst danach. Wer hier nach ``res["ok"]``
    zurueckkehrt, misst im Zweifel einen Sender, der nie ein Bild encodiert
    hat, und schreibt „0,0 Luecken/s" in die Messdatei. Genau das ist am
    2026-07-28 der ganzen H.264-Bildratenleiter passiert.

    Deshalb ist ``live`` die Bedingung. ``warte_s`` gross setzen, wenn der
    Portal-Dialog aufgehen soll (er blockt, bis der Nutzer klickt).

    Der Fehlerfall wird gemeldet statt geworfen, damit die Aufrufer ihre
    Aufraeum-Kette (``finally``) unveraendert behalten — dort haengt bei
    ``zeigen.py`` das Abraeumen der ``tc``-Regel dran.
    """
    # Welches Binary hier laeuft, ist keine Nebensache: der ausgelieferte
    # Sidecar kann AV1 nicht ueber WHIP muxen und weicht STILL auf H.264 8 bit
    # aus. Am 2026-07-30 lief so eine ganze Sitzung als H.264, waehrend
    # Aufruf und Ausgabe „av1 10 bit" sagten. Deshalb steht die Herkunft in
    # jedem Lauf, und der stille Fall wird zur lauten Warnung.
    if os.environ.get("PULSE_ZUSTAND_EGAL") != "1":
        zustand_pruefen()
    bildschirm_wachhalten()
    binaer = laden("real-harness").SIDECAR
    print(f"Sender-Binary: {binaer}")
    if "whip" in push_url and binaer.name != "pulse-hq-labor":
        print("WARNUNG: WHIP-Ziel, aber nicht der Messstand (streaming/hq-labor) — "
              "der ausgelieferte Sidecar faellt dabei still auf H.264 8 bit zurueck. "
              "Bauen: cd streaming/hq-labor && cargo build --release",
              file=sys.stderr)

    overrides = {"codec": args.codec, "fps": args.fps,
                 "bitrate_kbps": args.kbps, "bit_depth": args.bits}
    # Nur die Werkzeuge, die den Schalter haben, schicken ihn mit — und ein
    # leerer Wert bleibt draussen: der Sidecar liest Unbekanntes als `Native`
    # (`ResolutionRequest::parse`), meldet das aber nicht als Fehler.
    if getattr(args, "aufloesung", None):
        overrides["resolution"] = args.aufloesung

    res = sender.call(
        "start",
        channel={"id": CID, "token": token, "push_url": push_url},
        capture="portal",
        audio={"mode": args.audio},
        overrides=overrides,
    )
    if not res.get("ok"):
        print(f"Sender-Start fehlgeschlagen: {res}", file=sys.stderr)
        return False
    zustand = sender.warte_auf_zustand({"live", "error", "stopped"}, timeout=warte_s)
    if zustand is None:
        print(f"Sender meldete binnen {warte_s:.0f} s keinen Zustand — "
              f"steht der Portal-Dialog offen?", file=sys.stderr)
        return False
    if zustand.get("state") != "live":
        grund = [e.get("message") for e in sender.ereignisse if e.get("ev") == "error"]
        print(f"Sender ging nicht auf Sendung (state={zustand.get('state')})"
              + (f": {grund[-1]}" if grund else ""), file=sys.stderr)
        return False
    return True
