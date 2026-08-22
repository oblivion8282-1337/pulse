#!/usr/bin/env python3
"""A/B der Paritaets-Regelung ueber die ECHTE Leitung — unbeaufsichtigt fahrbar.

**Die Luecke, die es schliesst.** Die FEC-Analyse (`docs/plans/2026-07-31-fec-
bandbreite-und-adaptivitaet.md` §6) nennt als entscheidenden Mangel, dass keine
Teststrecke existiert, die GLEICHZEITIG verliert und Umlaufzeit hat: lokal gibt
es Verlust ohne Laufzeit, fern Laufzeit ohne Verlust. Genau dazwischen
entscheidet sich aber, ob Paritaet ueberhaupt gebraucht wird — bei Umlaufzeit
nahe null holt NACK jedes Paket rechtzeitig nach, und die Paritaet hat nichts
zu reparieren.

Dieses Werkzeug legt beides zusammen: der Weg geht ueber den Laborserver
(60 ms Umlaufzeit, gemessen), und der Verlust wird dort GESETZT statt durch
Saettigung erzeugt. Die frueheren adaptiv-Laeufe hatten stattdessen selbst
ausgeloeste Downloads als Stoerung — daher stand in jeder dieser Messakten der
Vorbehalt, dass die Laeufe unterschiedlich stark gestoert und deshalb nicht
vergleichbar sind.

**Wo die Stoerung sitzt** — im Netz-Namensraum des MediaMTX-Containers, auf
dem Serverausgang, gefiltert auf den Medienport — und warum ausgerechnet
dort, samt Verhaeltnis zu `verluststrecke.py`: siehe `serverstoerung.py`.

**Zwei Zuschauer, `--zuschauer browser|player`.** Vorgabe ist ein headless
Chromium (`browser-whep.mjs`): kein Fenster, kein wacher Bildschirm, nachts
fahrbar, und der Fall, der fuer die Mehrheit der Nutzer zaehlt — Pulse ist
web-first. `--zuschauer player` faehrt stattdessen den nativen Player.

Die beiden messen NICHT dasselbe, und das ist beim Vergleichen wichtiger als
es aussieht:

* Den **Aufschlag** kann nur der Browser beziffern. Das `kbps` des Players
  misst den Medienstrom ohne Paritaet — 4084,9 gegen 3984,8 zwischen fest und
  geregelt, waehrend der wirkliche Unterschied rund 20 Prozent betraegt.
* **`fec_repariert` des Players ist KEIN Verlustmass.** Auf ungestoerter
  Leitung standen dort 632 Reparaturen bei null endgueltig verlorenen Paketen:
  ein bloss umsortiertes Paket sieht im Moment der Luecke wie ein Verlust aus
  und wird nachgebaut, obwohl es gleich darauf echt eintrifft. Belastbar ist
  `packets_lost`.
* **`standbild_sekunden`** heisst beim Browser „die Pixel haben sich nicht
  geaendert", beim Player nur „`frames_decoded` lief nicht weiter". Die
  Browser-Fassung ist die schaerfere.

Vergleichbar ueber beide hinweg sind also: endgueltig verlorene Pakete, Bilder,
und die Zaehler des Tors auf dem Server.

**Auf einer AMD-APU die Buendel-Laeufe mit `--kein-hwdec` fahren.** Mit
Hardware-Decode ist der Player dort im Buendelverlust gestorben. Der Kernel:
`ring vcn_unified_0 timeout, signaled seq=242587, emitted seq=242588` — GENAU
EIN Decodier-Auftrag ging hinein und kam nie zurueck. Kein Verschleiss, keine
Ueberlastung; die Decodierzeit des Players sprang in derselben Probe von
11,1 auf 132,0 ms Mittel, und das ist Wartezeit auf den haengenden Auftrag.
Die bekannte Grenze von `vcn_unified_0` ist fuer SENDEN UND DEKODIEREN
gleichzeitig beschrieben — hier hat nichts encodiert, der Sender war ffmpeg
von der Platte. Beide Software-Laeufe liefen durch, mit null
Decoder-Einfrierungen.

**Die Vorlage hat genau EIN Vollbild, am Anfang** (`fec-vorlage-20s.mkv`,
av1_vaapi, 1200 Bilder). **Bis zum 2026-08-21 kam diese Eigenschaft aus echtem
Intra-Refresh** (`-intra_refresh 1`, gebaut mit dem gepatchten FFmpeg aus dem
damaligen `streaming/ffmpeg-patches/`, Datei hiess `fec-intraref-20s.mkv`). Die
Betriebsart ist aus Pulse entfernt und die Patches mit ihr; dieselbe Vorlage
entsteht heute schlicht ueber einen Vollbild-Abstand, der laenger ist als der
Ausschnitt (`-g 9999` und dann 20 s herausschneiden — Rezept im `README.md`).
Fuer diesen Pruefstand aendert sich dadurch nichts: gebraucht wird nicht die
Betriebsart, sondern ein Strom ohne zweiten Einstiegspunkt. Er ist heute sogar
naeher am Produkt, das mit 60 s Vollbild-Abstand faehrt.

Dass sie in Schleife laeuft, ist eine bewusste Einschraenkung mit Grund. Ein
Zuschauer, der NACH dem einzigen Vollbild einsteigt, bekommt nie ein Bild — im
ersten Lauf hier reproduziert: 0 Bilder, 99 vergebliche Anforderungen (die
Messakte `browser-2026-07-31-intra-refresh.json` dazu ist am 2026-08-21 mit der
Betriebsart geloescht worden). Im
Produkt loest das der Rueckkanal des WHIP-Wegs, ueber den die Anforderung des
Zuschauers beim Sender ankommt; ein Sender, der eine Datei durchreicht, KANN
darauf nicht antworten. Der Schleifenpunkt alle 20 Sekunden steht deshalb
stellvertretend fuer genau diesen Rettungsweg. Folge fuer die Auswertung: ein
Standbild kann nie laenger als bis zum naechsten Schleifenpunkt dauern. Das
trifft alle Vergleichsarme gleich.

    export PULSE_FERN_PASS=… PULSE_FERN_TOKEN=…      # aus ~/mediamtx-labor/zugang.txt
    ./fec-adaptiv.py --profil verlust --secs 60 --label fest-10-2
    ./fec-adaptiv.py --profil verlust --secs 60 --label adaptiv \\
        --modus PULSE_FLEXFEC_ADAPTIV=1
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

import gemeinsam
import harness
import serverstoerung
from serverstoerung import (
    netem_setzen,
    netem_umschalten,
    netem_weg,
    netem_wirkung,
    stoerzyklus,
)

HERE = Path(__file__).parent

# `fern-harness.py` traegt einen Bindestrich und ist deshalb nicht importierbar.
# `gemeinsam.laden` gibt es genau dafuer — nicht selbst nachbauen.
_fh = gemeinsam.laden("fern-harness")

SSH = serverstoerung.SSH
SSH_OPTS = serverstoerung.SSH_OPTS


def server_modus(zusatz: list[str], image: str) -> str:
    """Laborserver in die gewuenschte Betriebsart neu starten.

    `image` steht VOR dem Skriptaufruf, nicht dahinter: `neustart.sh` liest es
    aus seiner eigenen Umgebung, waehrend alles hinter dem Namen als `-e` an
    den Container weitergereicht wird. Beides zu verwechseln startet still das
    alte Image mit der neuen Umgebung — und die neuen Schalter tun dann nichts,
    ohne dass etwas scheitert.
    """
    befehl = "~/mediamtx-labor/neustart.sh " + " ".join(zusatz)
    if image:
        befehl = f"PULSE_MEDIAMTX_IMAGE={shlex.quote(image)} " + befehl
    r = subprocess.run(["ssh", *SSH_OPTS, SSH, befehl],
                       capture_output=True, text=True, check=False)
    if r.returncode != 0:
        raise SystemExit(f"Serverumstellung fehlgeschlagen:\n{r.stderr}")
    return r.stdout.strip()


def start_push(quelle: str, path: str, token: str, log) -> subprocess.Popen:
    """RTMPS-Push der vorkodierten Vorlage, ohne Neukodierung.

    `-c copy` ist der Punkt: der Sender schickt in jedem Durchgang exakt
    dieselben Bytes. Ein echter Encoder reagiert auf Last und Bildinhalt und
    braechte drei Stoergroessen in ein A/B, das genau eine Groesse messen soll.
    """
    return subprocess.Popen(
        ["ffmpeg", "-hide_banner", "-loglevel", "warning",
         "-re", "-stream_loop", "-1", "-i", quelle, "-c", "copy",
         "-f", "flv", "-tls_verify", "0",
         _fh.push_url(path, token, "rtmps", 120)],
        stdout=log, stderr=log)


def standbild_sekunden(proben: list[dict]) -> int:
    """Sekunden, in denen sich das SICHTBARE Bild nicht geaendert hat.

    **Warum nicht `framesDecoded` genuegt.** Am 2026-07-31 lieferte der Player
    60 Bilder je Sekunde und zeigte trotzdem ein Standbild — der Decoder gab
    immer dasselbe Bild aus. Kein Zaehler meldete das, `freezeCount`
    eingeschlossen, denn formal kamen ja Bilder. Nur der Fingerabdruck der
    Pixel entscheidet. Fuer einen Strom ohne nahen Einstiegspunkt ist das DIE
    Kennzahl — bis zum 2026-08-21 stand hier „fuer einen Intra-Refresh-Strom",
    weil der sich nach Verlust gar nicht selbst heilte. Die Betriebsart ist
    entfallen; ein Vollbild-Strom heilt am naechsten Takt, und genau darum
    misst diese Zahl heute, wie lange dieser Takt sichtbar auf sich warten
    laesst (Vorgabe im Produkt: 60 s).
    """
    n = 0
    for vorher, jetzt in zip(proben, proben[1:], strict=False):
        a, b = vorher.get("bildAbdruck"), jetzt.get("bildAbdruck")
        if a is not None and a == b:
            n += 1
    return n


def auswerten(proben: list[dict], label: str, netem: tuple[int, int]) -> dict:
    # Die ersten zwei Sekunden sind Aufbau (ICE, erstes Vollbild) — weglassen,
    # wie im uebrigen Pruefstand.
    gut = proben[2:]
    if not gut:
        raise SystemExit("keine brauchbaren Proben")
    erste, letzte = gut[0], gut[-1]

    def spanne(name: str) -> int:
        return int(letzte.get(name) or 0) - int(erste.get(name) or 0)

    # `packetsReceived` ENTHAELT die Paritaetspakete. Nachgemessen am ersten
    # Lauf: 1534 von 9203, also exakt 2/12 — das ist der 10+2-Anteil am
    # GESAMTstrom, nicht der Aufschlag auf die Medien. Wer das verwechselt,
    # bekommt 16,7 statt 20 Prozent und haelte den Aufschlag fuer ein Sechstel
    # kleiner, als er ist.
    gesamt = spanne("packetsReceived")
    paritaet = spanne("fecPacketsReceived")
    medien = gesamt - paritaet
    gesendet, verworfen = netem
    return {
        "label": label,
        "proben": len(gut),
        "bilder_dekodiert": spanne("framesDecoded"),
        "standbild_sekunden": standbild_sekunden(gut),
        "medienpakete": medien,
        "paritaetspakete": paritaet,
        # DIE Zahl, um die es geht. 10+2 bedeutet nominal 20 Prozent; was
        # wirklich ankommt, steht hier.
        "aufschlag_prozent": round(100.0 * paritaet / medien, 2) if medien else None,
        "pakete_verloren": spanne("packetsLost"),
        "nack": spanne("nackCount"),
        "pli": spanne("pliCount"),
        "einfrierungen": spanne("freezeCount"),
        "einfrierdauer_s": round(float(letzte.get("totalFreezesDuration") or 0)
                                 - float(erste.get("totalFreezesDuration") or 0), 2),
        "netem_gesendet": gesendet,
        "netem_verworfen": verworfen,
        "netem_verlust_prozent": round(100.0 * verworfen / gesendet, 2) if gesendet else None,
        "decoder": letzte.get("decoderImplementation"),
        "codec": letzte.get("mimeType"),
    }


def player_proben(whep: str, args) -> list[dict]:
    """Denselben Lauf mit dem NATIVEN Player statt dem Browser.

    **Warum beide Zuschauer noetig sind.** Die Regelung sitzt im Server und ist
    dem Zuschauer gegenueber blind — er sieht schlicht keine Paritaet. Das ist
    das Argument dafuer, dass ein Browser-Ergebnis auch fuer den Player gilt;
    ein Beleg ist es nicht. Zwei Dinge unterscheiden sich nachweislich: der
    Player fordert seltener nach (20-ms-Sperrfrist, waehrend Chromium dieselbe
    Luecke 6- bis 8-mal anfordert), und sein FlexFEC-Empfaenger ist unser
    eigener Code statt libwebrtc.

    **Er misst dafuer etwas, das der Browser gar nicht hergibt:** wie viele
    Pakete die Paritaet WIRKLICH repariert hat (`fec_repariert`). Der Browser
    meldet nur, wieviel Paritaet ankam. Genau diese Zahl war es, die den ersten
    Anlauf am 2026-07-31 als wirkungslos entlarvt hat — sie stand auf null.
    """
    log = open(HERE / f"player-{args.label}.log", "w")
    spieler = harness.Player(log)
    proben: list[dict] = []
    try:
        res = spieler.call("open", url=whep, title=f"FEC {args.label}",
                           options={} if args.hwdec else {"hwdec": False})
        if not res.get("ok"):
            raise SystemExit(f"Player-open fehlgeschlagen: {res}")
        sid = res["session"]
        ende = time.monotonic() + args.secs
        while time.monotonic() < ende:
            time.sleep(1.0)
            s = spieler.call("stats", session=sid)
            if s.get("ok"):
                proben.append(s)
    finally:
        spieler.stop()
        log.close()

    return proben


def auswerten_player(proben: list[dict], label: str, netem: tuple[int, int]) -> dict:
    """Dasselbe Bild aus den Zahlen des nativen Players.

    Die Felder heissen anders als im Browser, und zwei Groessen gibt es nur
    hier beziehungsweise nur dort — deshalb eine eigene Auswertung statt einer
    Übersetzungstabelle, die vorgaebe, alles sei vergleichbar:

    * `fec_repariert` — was die Paritaet WIRKLICH geleistet hat. Der Browser
      meldet nur, wieviel Paritaet ankam.
    * `standbild_sekunden` ist hier „Sekunden, in denen `frames_decoded` nicht
      weiterlief". Der Browser vergleicht stattdessen die PIXEL. Das ist die
      schaerfere Messung — ein Decoder, der immer dasselbe Bild ausgibt, meldet
      volle Bildrate, und genau das ist am 2026-07-31 passiert. Die Zahl von
      hier ist also eine UNTERgrenze, nicht dasselbe.
    * Der Aufschlag steht hier nicht drin: der Player zaehlt die empfangene
      Paritaet nicht einzeln. Fuer ihn ist `kbps` das Mass — und die Zaehler
      des Tors auf dem Server sagen ohnehin genauer, was hinausging.
    """
    gut = proben[2:]
    if not gut:
        raise SystemExit("keine brauchbaren Proben")
    erste, letzte = gut[0], gut[-1]

    def spanne(name: str) -> int:
        return int(letzte.get(name) or 0) - int(erste.get(name) or 0)

    bilder = [int(s.get("frames_decoded") or 0) for s in gut]
    kbps = [float(s.get("kbps") or 0) for s in gut]
    gesendet, verworfen = netem

    return {
        "label": label,
        "proben": len(gut),
        "bilder_dekodiert": spanne("frames_decoded"),
        "standbild_sekunden": sum(1 for a, b in zip(bilder, bilder[1:], strict=False) if a == b),
        "kbps_mittel": round(sum(kbps) / len(kbps), 1) if kbps else None,
        "pakete_verloren": spanne("packets_lost"),
        "fec_repariert": spanne("fec_repariert"),
        "fec_unreparierbar": spanne("fec_unreparierbar"),
        "fec_zu_spaet": spanne("fec_zu_spaet"),
        "fec_mehrfach_loch": spanne("fec_mehrfach_loch"),
        "netem_gesendet": gesendet,
        "netem_verworfen": verworfen,
        "netem_verlust_prozent": round(100.0 * verworfen / gesendet, 2) if gesendet else None,
    }


def zuschauen(whep: str, args) -> tuple[int, int]:
    """Den Zuschauer unter der Stoerung laufen lassen; gibt die tc-Bilanz zurueck."""
    # Im Zyklusbetrieb steht die Warteschlange von Anfang an, faengt aber
    # ungestoert an — sonst begaenne jeder Lauf mitten in einer Stoerung, und
    # das Anlauffenster der Regelung waere nicht mehr vom Rest zu trennen.
    netem_setzen(args.profil)
    takt = None
    if args.zyklus:
        netem_umschalten("klar")
        an_s, aus_s = (float(x) for x in args.zyklus.split(","))
        takt = threading.Thread(
            target=stoerzyklus,
            args=(an_s, aus_s, args.profil, time.monotonic() + args.secs),
            daemon=True)
        takt.start()

    if args.zuschauer == "player":
        proben = player_proben(whep, args)
        (HERE / f"player-proben-{args.label}.json").write_text(
            json.dumps(proben, indent=1))
        print(f"[{args.label}] {len(proben)} Proben vom nativen Player")
    else:
        r = subprocess.run(
            ["node", str(HERE / "browser-whep.mjs"), "--url", whep,
             "--secs", str(int(args.secs)), "--label", args.label],
            capture_output=True, text=True, check=False)
        print(r.stdout.strip() or r.stderr.strip()[:400])
    if takt:
        takt.join(timeout=10)

    return netem_wirkung()


def lauf(args) -> dict:
    modus = server_modus(args.modus, args.image)
    for zeile in modus.splitlines():
        print(f"[{args.label}] {zeile}")
    path, pub, rd = _fh.mint_remote()
    whep = f"https://{_fh.HOST}/whep/{path}/whep?token={rd}"
    print(f"[{args.label}] Pfad {path}, Profil {args.profil}")

    push_log = open(HERE / f"push-{args.label}.log", "w")
    push = start_push(args.quelle, path, pub, push_log)
    # Der Server braucht laenger als die Schleife, bis der Pfad bereit ist.
    # Zu frueh geoeffnet antwortet MediaMTX `no stream is available`, und die
    # Messung sieht aus, als haette der Zuschauer versagt.
    time.sleep(8)
    if push.poll() is not None:
        raise SystemExit(f"Sender ist gestorben — siehe push-{args.label}.log")

    try:
        netem = zuschauen(whep, args)
    finally:
        netem_weg()
        push.send_signal(signal.SIGINT)
        try:
            push.wait(timeout=5)
        except subprocess.TimeoutExpired:
            push.kill()
        push_log.close()

    vorsatz = "player" if args.zuschauer == "player" else "browser"
    datei = HERE / f"{vorsatz}-proben-{args.label}.json"
    proben = json.loads(datei.read_text()) if datei.exists() else []
    ergebnis = (auswerten_player if args.zuschauer == "player" else auswerten)(
        proben, args.label, netem)
    ergebnis["zuschauer"] = args.zuschauer
    ergebnis["profil"] = args.profil
    ergebnis["modus"] = args.modus
    ergebnis["image"] = args.image or "(Vorgabe)"
    ergebnis["zyklus"] = args.zyklus or "durchgehend"
    return ergebnis


def main() -> int:
    ap = argparse.ArgumentParser()
    # Hiess bis zum 2026-08-21 `fec-intraref-20s.mkv` und war mit echtem
    # Intra-Refresh gebaut; die Betriebsart ist entfallen, die Vorlage entsteht
    # heute ueber einen ueberlangen Vollbild-Abstand (Rezept im `README.md`).
    # Gebraucht wird unveraendert: EIN Vollbild, ganz am Anfang.
    ap.add_argument("--quelle", default=str(HERE / "fec-vorlage-20s.mkv"))
    ap.add_argument("--profil", default="verlust", choices=tuple(serverstoerung.PROFILE))
    ap.add_argument("--secs", type=float, default=60)
    ap.add_argument("--label", default="fec")
    # Zusaetzliche Server-Umgebung, mehrfach angebbar:
    #   --modus PULSE_FLEXFEC_ADAPTIV=1 --modus PULSE_FLEXFEC_SCHWELLE_PROZENT=1
    ap.add_argument("--modus", action="append", default=[])
    # Leer = die Vorgabe aus `neustart.sh` (das ausgelieferte Image).
    ap.add_argument("--image", default="")
    # `--zyklus AN,AUS` in Sekunden: Verlust in Phasen statt durchgehend.
    #   --zyklus 15,30   15 s gestoert, 30 s ruhig, wiederholt
    ap.add_argument("--zyklus", default="")
    ap.add_argument("--zuschauer", default="browser", choices=("browser", "player"))
    # Auf einer APU teilen sich Encoder und Decoder eine Einheit; hier sendet
    # zwar nur ffmpeg von der Platte, aber der Schalter bleibt der Ausweg,
    # falls der Ring doch ueberlaeuft (`PULSE_PLAYER_HWDEC=0`).
    ap.add_argument("--hwdec", action="store_true", default=True)
    ap.add_argument("--kein-hwdec", dest="hwdec", action="store_false")
    args = ap.parse_args()

    if not os.path.exists(args.quelle):
        print(f"Vorlage fehlt: {args.quelle}", file=sys.stderr)
        return 1

    ergebnis = lauf(args)
    (HERE / f"fec-ergebnis-{args.label}.json").write_text(
        json.dumps(ergebnis, indent=1, ensure_ascii=False))
    print(json.dumps(ergebnis, indent=1, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
