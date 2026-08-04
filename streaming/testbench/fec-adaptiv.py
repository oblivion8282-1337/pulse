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

**Verhaeltnis zu `verluststrecke.py`.** Das gibt es und es tut dasselbe — nur
am anderen Ende: es legt `netem` per ifb-Umleitung auf den EMPFANGSweg dieser
Maschine. Beides erzeugt beim Zuschauer denselben Verlust. Hier wird trotzdem
serverseitig gestoert, aus zwei Gruenden: der Uplink dieser Leitung liegt bei
10 Mbit, und ein Paket, das erst hierher uebertragen und dann verworfen wird,
hat die Leitung bereits belegt — die Ersparnis einer Paritaets-Regelung waere
damit gerade nicht messbar. Und `tc` ist auf dieser Maschine gar nicht
installiert, `verluststrecke.py` laeuft hier also nicht. Wer eine Maschine mit
`iproute-tc` hat und den Empfangsweg stoeren will, nimmt weiter jenes Werkzeug.

**Wo der Verlust sitzt und warum ausgerechnet dort.** Im Netz-Namensraum des
MediaMTX-Containers, auf dessen `eth0`-Ausgang, gefiltert auf UDP-Quellport
8189 (`webrtcLocalUDPAddress`). Drei Gruende:

* Am SERVERausgang, damit er den Empfangsweg trifft und nicht den Push — sonst
  misst man den eigenen Uplink (10 Mbit) statt den Sendeweg.
* IM Container, weil auf dieser Maschine fremde Dienste laufen (Supabase,
  Caddy, mehrere Anwendungen). Ein `tc` auf dem Host-Interface waere ein
  Eingriff in deren Betrieb; der Container hat sein eigenes veth.
* Auf den MEDIENport gefiltert, damit die RTMP-Quittungen an den Sender
  ungestoert bleiben. Wird auch der Rueckweg des Pushs verworfen, drosselt TCP
  den Sender, und die Messung zeigt einen Sender-Einbruch statt Empfangsverlust.

**Zuschauer ist ein headless Chromium** (`browser-whep.mjs`), nicht der native
Player: kein Fenster, kein wacher Bildschirm, nachts fahrbar. Und es ist der
Fall, der fuer die Mehrheit der Nutzer zaehlt — Pulse ist web-first.

**Die Vorlage ist echter Intra-Refresh** (`fec-intraref-20s.mkv`, av1_vaapi mit
`-intra_refresh 1`, gebaut mit dem gepatchten FFmpeg aus
`streaming/ffmpeg-patches/`): 1200 Bilder, genau EIN Vollbild, am Anfang.

Dass sie in Schleife laeuft, ist eine bewusste Einschraenkung mit Grund. Ein
Zuschauer, der NACH dem einzigen Vollbild einsteigt, bekommt nie ein Bild — im
ersten Lauf hier reproduziert: 0 Bilder, 99 vergebliche Anforderungen, genau
der Befund aus `browser-2026-07-31-intra-refresh.json`. Im Produkt loest das
Patch 0002, indem es die Anforderung des Zuschauers an den Sender weiterreicht;
ein Sender, der eine Datei durchreicht, KANN darauf nicht antworten. Der
Schleifenpunkt alle 20 Sekunden steht deshalb stellvertretend fuer genau diesen
Rettungsweg. Folge fuer die Auswertung: ein Standbild kann nie laenger als bis
zum naechsten Schleifenpunkt dauern. Das trifft alle Vergleichsarme gleich.

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

HERE = Path(__file__).parent

# `fern-harness.py` traegt einen Bindestrich und ist deshalb nicht importierbar.
# `gemeinsam.laden` gibt es genau dafuer — nicht selbst nachbauen.
_fh = gemeinsam.laden("fern-harness")

SSH = os.environ.get("PULSE_FERN_SSH", "michael@77.42.71.166")
CONTAINER = "mediamtx-labor"
WEBRTC_UDP_PORT = 8189

# `BatchMode=yes` ist hier keine Vorsichtsmassnahme, sondern eine Falle, die
# schon zugeschlagen hat: die Vorgabe `michael@77.42.71.166` findet den
# Schluessel nur, wenn er in `~/.ssh/config` an dieser ADRESSE haengt. Steht er
# dort unter einem Namen (`Host pulse-test`), fragt ssh nach einem Passwort —
# und da der Aufruf keine Konsole hat, wartet er stumm bis zum Zeitablauf. Der
# Lauf sieht dann aus, als haenge der Server. Mit BatchMode scheitert er
# sofort und sagt, woran.
#   export PULSE_FERN_SSH=pulse-test
SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15"]

# Die Stoerprofile. `gemodel` statt der Korrelations-Schreibweise ist kein
# Geschmack: `loss 5% 50%` wird vom Kern anstandslos angenommen und verwirft
# dann NICHTS (am 2026-07-29 eine ganze Buendelreihe so verloren). Deshalb
# zusaetzlich die Wirkungskontrolle in `netem_wirkung()`.
PROFILE: dict[str, list[str]] = {
    "klar": [],
    "verlust_leicht": ["loss", "0.5%"],
    "verlust": ["loss", "2%"],
    "verlust_stark": ["loss", "5%"],
    # p, r, 1-h, 1-k — Uebergang gut→schlecht, schlecht→gut, Verlust im
    # schlechten, Verlust im guten Zustand. Der Fall, an dem sich XOR-Paritaet
    # entscheidet: eine Gruppe loest genau EINE Unbekannte, ein Buendel trifft
    # dieselbe Gruppe mehrfach.
    "buendel": ["loss", "gemodel", "2%", "40%", "100%", "0%"],
}


def im_netns(*befehle: str) -> subprocess.CompletedProcess:
    """Ein `tc`-Befehl im Netz-Namensraum des MediaMTX-Containers.

    Das Image ist `FROM scratch` und hat keine Shell — deshalb ein
    Beistell-Container, der sich dessen Namensraum teilt. `--cap-add=NET_ADMIN`
    genuegt; Host-root wird nicht gebraucht.
    """
    # Mit `;` verbinden und EINMAL shell-quoten. Zeilenumbrueche taugen hier
    # nicht: ssh reicht den Befehl als eine Zeichenkette an die entfernte Shell,
    # die ihn erneut zerlegt — die Umbrueche gehen dabei verloren, und aus
    # `set -e` + `tc` wurde `set -etc` („illegal option -t"). `shlex.quote`
    # haelt das Skript ueber beide Zerlegungen hinweg zusammen.
    skript = "; ".join(befehle)
    return subprocess.run(
        ["ssh", *SSH_OPTS, SSH,
         f"docker run --rm --net=container:{CONTAINER} "
         f"--cap-add=NET_ADMIN pulse-tc:1 sh -c {shlex.quote(skript)}"],
        capture_output=True, text=True, check=False,
    )


def netem_setzen(profil: str) -> None:
    netem_weg()
    args = PROFILE[profil]
    if not args:
        return
    r = im_netns(
        "set -e",
        "tc qdisc add dev eth0 root handle 1: prio bands 3",
        f"tc qdisc add dev eth0 parent 1:3 handle 30: netem {' '.join(args)}",
        f"tc filter add dev eth0 protocol ip parent 1: prio 1 flower "
        f"ip_proto udp src_port {WEBRTC_UDP_PORT} flowid 1:3",
        f"tc filter add dev eth0 protocol ipv6 parent 1: prio 2 flower "
        f"ip_proto udp src_port {WEBRTC_UDP_PORT} flowid 1:3",
    )
    if r.returncode != 0:
        raise SystemExit(f"netem setzen fehlgeschlagen:\n{r.stderr}")


def netem_weg() -> None:
    im_netns("tc qdisc del dev eth0 root 2>/dev/null || true")


def netem_umschalten(profil: str) -> None:
    """Die Stoerung an- oder abschalten, OHNE die Warteschlange neu zu bauen.

    `tc qdisc change` taucht nur den netem-Knoten um; Wurzel, Klassen und
    Filter bleiben stehen. Ein `del`/`add` je Umschaltung wuerde stattdessen
    die Zaehler zuruecksetzen — und damit ausgerechnet die Wirkungskontrolle
    zerstoeren, die belegt, dass ueberhaupt etwas verworfen wurde.
    """
    args = PROFILE[profil] or ["loss", "0%"]
    im_netns(f"tc qdisc change dev eth0 parent 1:3 handle 30: netem {' '.join(args)}")


def stoerzyklus(an_s: float, aus_s: float, profil: str, ende: float) -> None:
    """Verlust in Phasen statt durchgehend — der Fall, um den es geht.

    Eine Leitung, die DAUERND verliert, laesst jede Regelung voll aufdrehen;
    dort kann eine Regelung per Konstruktion nichts sparen. Eine echte Leitung
    hat ruhige und gestoerte Abschnitte, und genau ihr Verhaeltnis entscheidet,
    was die Haltezeit im Mittel kostet.
    """
    while time.monotonic() < ende:
        netem_umschalten(profil)
        time.sleep(min(an_s, max(0.0, ende - time.monotonic())))
        if time.monotonic() >= ende:
            return
        netem_umschalten("klar")
        time.sleep(min(aus_s, max(0.0, ende - time.monotonic())))


def netem_wirkung() -> tuple[int, int]:
    """(gesendete, verworfene) Pakete der netem-Warteschlange.

    **Die einzige ehrliche Kontrolle, dass die Stoerung ueberhaupt gewirkt hat.**
    Ohne sie liest man einen ungestoerten Lauf als Ergebnis der Stoerung — und
    bei einer Schutzschicht sieht das aus wie „bringt nichts".

    Die Auswertung des `tc`-Textes ist dieselbe wie in
    `netz-harness.py::netem_wirkung` — SYNCHRON HALTEN. Geteilt wird sie nicht:
    dort laeuft `tc` lokal, hier in einem Beistell-Container auf dem Server.
    Gemeinsam ist nur das Format, und das aendert `tc` nicht.
    """
    r = im_netns("tc -s qdisc show dev eth0")
    zeilen = r.stdout.splitlines()
    for i, z in enumerate(zeilen):
        if "netem" not in z or i + 1 >= len(zeilen):
            continue
        stat = zeilen[i + 1].split()
        if "pkt" in stat and "(dropped" in stat:
            return (int(stat[stat.index("pkt") - 1]),
                    int(stat[stat.index("(dropped") + 1].rstrip(",")))
    return 0, 0


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
    Pixel entscheidet. Fuer einen Intra-Refresh-Strom ist das DIE Kennzahl:
    er heilt sich nach Verlust nicht selbst, das Bild bleibt einfach stehen.
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

    datei = HERE / f"browser-proben-{args.label}.json"
    proben = json.loads(datei.read_text()) if datei.exists() else []
    ergebnis = auswerten(proben, args.label, netem)
    ergebnis["profil"] = args.profil
    ergebnis["modus"] = args.modus
    ergebnis["image"] = args.image or "(Vorgabe)"
    ergebnis["zyklus"] = args.zyklus or "durchgehend"
    return ergebnis


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quelle", default=str(HERE / "fec-intraref-20s.mkv"))
    ap.add_argument("--profil", default="verlust", choices=tuple(PROFILE))
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
