#!/usr/bin/env python3
"""Gesetzter Paketverlust am AUSGANG des Laborservers, chirurgisch begrenzt.

**Verhaeltnis zu `verluststrecke.py`.** Das tut dasselbe am anderen Ende: es
legt `netem` per ifb-Umleitung auf den Empfangsweg der eigenen Maschine. Beides
erzeugt beim Zuschauer denselben Verlust. Diese Fassung stoert serverseitig,
aus zwei Gruenden — der Uplink der Laborleitung liegt bei 10 Mbit, und ein
Paket, das erst herueberkommt und dann verworfen wird, hat die Leitung bereits
belegt (die Ersparnis einer Paritaets-Regelung waere damit gerade nicht
messbar); und `tc` ist auf der AMD-Maschine gar nicht installiert. Wer eine
Maschine mit `iproute-tc` hat und den Empfangsweg stoeren will, nimmt weiter
jenes Werkzeug.

**Wo die Stoerung sitzt und warum ausgerechnet dort.** Im Netz-Namensraum des
MediaMTX-Containers, auf dessen `eth0`-Ausgang, gefiltert auf UDP-Quellport
8189 (`webrtcLocalUDPAddress`). Drei Gruende:

* Am SERVERausgang, damit sie den Empfangsweg trifft und nicht den Push — sonst
  misst man den eigenen Uplink statt den Sendeweg.
* IM Container, weil auf jener Maschine fremde Dienste laufen (Supabase, Caddy,
  mehrere Anwendungen). Ein `tc` auf dem Host-Interface waere ein Eingriff in
  deren Betrieb; der Container hat sein eigenes veth.
* Auf den MEDIENport gefiltert, damit die RTMP-Quittungen an den Sender
  ungestoert bleiben. Wird auch der Rueckweg des Pushs verworfen, drosselt TCP
  den Sender, und die Messung zeigt einen Sender-Einbruch statt Empfangsverlust.

Kein Programm, nur ein Modul — Aufrufer ist `fec-adaptiv.py`.
"""

from __future__ import annotations

import os
import shlex
import subprocess
import time

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

# Beistell-Image mit `iproute2`. Das MediaMTX-Image ist `FROM scratch` und hat
# weder Shell noch `tc` — gestoert wird deshalb aus einem Container, der sich
# nur dessen Netz-Namensraum teilt.
HELFER = "pulse-tc:1"
_helfer_geprueft = False


def helfer_sicherstellen() -> None:
    """Das Beistell-Image anlegen, falls es auf dem Server fehlt.

    **Warum das hier steht und nicht in einer Anleitung.** Das Image entstand
    am 2026-08-04 von Hand auf dem Laborserver und war danach die einzige
    ungeschriebene Voraussetzung dieses Werkzeugs: auf einem frischen Server —
    oder von einem anderen Rechner aus, der ihn neu aufsetzt — waere jeder Lauf
    mit „Unable to find image" gescheitert, ohne dass irgendwo steht, woher es
    kommt. Zwei Zeilen Selbstheilung sind besser als ein Satz in einer Datei,
    die niemand liest.
    """
    global _helfer_geprueft
    if _helfer_geprueft:
        return
    vorhanden = subprocess.run(
        ["ssh", *SSH_OPTS, SSH, f"docker image inspect {HELFER} >/dev/null 2>&1"],
        capture_output=True, text=True, check=False)
    if vorhanden.returncode != 0:
        print(f"[stoerstrecke] {HELFER} fehlt auf dem Server — wird angelegt")
        bau = subprocess.run(
            ["ssh", *SSH_OPTS, SSH,
             f"printf 'FROM alpine:3.20\\nRUN apk add --no-cache iproute2\\n' "
             f"| docker build -q -t {HELFER} -"],
            capture_output=True, text=True, check=False)
        if bau.returncode != 0:
            raise SystemExit(f"{HELFER} liess sich nicht bauen:\n{bau.stderr}")
    _helfer_geprueft = True


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
    helfer_sicherstellen()
    skript = "; ".join(befehle)
    return subprocess.run(
        ["ssh", *SSH_OPTS, SSH,
         f"docker run --rm --net=container:{CONTAINER} "
         f"--cap-add=NET_ADMIN {HELFER} sh -c {shlex.quote(skript)}"],
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


