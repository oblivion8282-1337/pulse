#!/usr/bin/env python3
"""Player unter kontrollierten Netzbedingungen — Verzoegerung, Verlust, Umsortierung.

**Warum das noetig ist.** Bis zum 2026-07-27 war der Player nur auf der lokalen
Schleife geprueft. Dort gibt es per Konstruktion keine Laufzeit, keine Schwankung
und keinen Verlust — der Aufbau kann also gar nicht zeigen, wie sich der Player
bei echten Nutzern verhaelt. Der erste Lauf ueber eine echte Leitung ergab
prompt 143 statt 16,3 ms und einen Abbruch in drei Laeufen.

Dieses Werkzeug legt die Stoerung kuenstlich auf die Schleife (`tc netem`) und
faehrt denselben Prueflauf. Zwei Fragen auf einmal:

1. **Haelt der Player durch?** Kein Schwarzbild, kein Absturz, Erholung nach der
   Stoerung. Das ist die Frage nach der Robustheit.
2. **Wo entstehen die 100 unerklaerten Millisekunden?** Ueber die echte Leitung
   sind 143 ms gemessen, erwartbar waeren 43 (16,3 lokale Kette + 26,7 Laufzeit).
   Faehrt man dieselbe Kette lokal MIT aufgezwungener Laufzeit und sie bleibt bei
   43, sitzt die Ursache auf dem Server. Springt sie auf 143, ist unsere eigene
   Kette laufzeitempfindlich — und dann hier loesbar.

**Nutzt den Referenzsender** (`harness.py`, vorkodierte Datei), nicht den echten
Sidecar: kein Bildschirm, kein Portal-Dialog, und der Sender ist bekannt
gleichmaessig. Damit ist alles, was die Messung zeigt, Empfangsweg und nicht
Aufnahme.

**Braucht root** (`sudo tc`). Die Stoerung wird in `finally` UND per Signal-
Handler wieder abgeraeumt; bleibt sie doch einmal stehen, hilft
`sudo tc qdisc del dev lo root`.

    ./netz-harness.py --profil verzoegerung --secs 20
    ./netz-harness.py --alle --secs 20
"""

from __future__ import annotations

import argparse
import json
import signal
import statistics as st
import subprocess
import sys

from harness import HERE

# Die Stoerprofile. `delay 26.7ms` ist die halbe gemessene Umlaufzeit zum
# Hetzner-Testserver (53,3 ms) — also genau die Laufzeit, die eine echte
# Strecke beisteuert. `lo` traegt beide Richtungen, deshalb wuerde ein
# beidseitiger Aufschlag doppelt zaehlen; netem auf `lo` wirkt aber ohnehin auf
# jedes Paket einmal beim Senden.
PROFILE: dict[str, list[str]] = {
    "klar": [],
    "verzoegerung": ["delay", "26.7ms"],
    "verlust": ["loss", "1%"],
    "verlust_stark": ["loss", "5%"],
    "umsortierung": ["delay", "5ms", "reorder", "25%", "50%"],
    # ACHTUNG, kein realistisches Modell: `netem`-Schwankung wuerfelt fuer JEDES
    # Paket eine eigene Verzoegerung. Bei 2000 Paketen je Sekunde liegen
    # benachbarte Pakete 0,5 ms auseinander, eine Streuung von 5 ms vertauscht
    # sie also fast durchgehend. Am 2026-07-28 gemessen: 2569-2802 "verlorene"
    # Pakete in 20 s, obwohl gar kein Verlust eingestellt war — das ist
    # Umsortierung, die der Jitter-Puffer als zu spaet verwirft. Echte Strecken
    # vertauschen nicht annaehernd so. Nur als Extremfall lesen, nicht als
    # "so ist das Internet".
    "schwankung": ["delay", "26.7ms", "5ms", "distribution", "normal"],
    "echte_leitung": ["delay", "26.7ms", "3ms", "distribution", "normal", "loss", "0.2%"],
}


# Aus welchem Port MediaMTX seine Medien schickt (`webrtcLocalUDPAddress`).
# Nur Pakete von hier bekommen die Stoerung, wenn `nur_empfang` gilt.
#
# Nicht offensichtlich, am 2026-07-28 nachgemessen: MediaMTX protokolliert die
# WHEP-Sitzung als `[::1]:...`, der MEDIENFLUSS laeuft aber ueber IPv4
# (127.0.0.1). Signalisierung und Medien nehmen also verschiedene Familien —
# dieselbe Falle wie bei `split-latency.py`. Der IPv4-Filter allein greift
# deshalb; der IPv6-Filter bleibt trotzdem stehen, damit ein anderer Aufbau
# nicht stillschweigend ungestoert misst. Er braucht eine EIGENE Prioritaet,
# sonst lehnt der Kern ihn mit "Protocol mismatch" ab.
WEBRTC_UDP_PORT = 8189


def netem_setzen(args: list[str], nur_empfang: bool) -> None:
    """Legt die Stoerung auf `lo` — wahlweise auf alles oder nur den Empfangsweg.

    **Warum die Unterscheidung noetig ist.** `netem` an der Wurzel von `lo`
    trifft JEDE Verbindung ueber die Schleife, also auch den RTMP-Push des
    Senders. Am 2026-07-28 gemessen: mit 26,7 ms an der Wurzel meldete ffmpeg
    `lag of 5.489s` und die Bildrate fiel von 144 auf 98 — nur war dann offen,
    ob der Player oder der Sender schwaechelte. Fuer die Frage "wo entstehen die
    100 unerklaerten Millisekunden?" ist so eine Messung wertlos.

    Deshalb der gefilterte Weg: eine `prio`-Warteschlange, in deren dritte Klasse
    nur die Medienpakete von MediaMTX zum Player wandern. Der Push bleibt
    ungestoert, gemessen wird ausschliesslich der Empfangsweg.

    IPv6 ist dabei nicht optional: MediaMTX loggt die WHEP-Sitzungen als
    `[::1]:...`, der Medienfluss laeuft also ueber die IPv6-Schleife. Ein reiner
    IPv4-Filter greift ins Leere — genau die Falle, die schon `split-latency.py`
    einmal gestellt hat.

    Gefiltert wird mit `flower` statt `u32`: dessen IPv6-Selektor fuer den
    Next-Header laesst sich nicht so schreiben wie der IPv4-Gegenpart (`match ip6
    protocol 17` wird abgelehnt), waehrend `flower ip_proto udp src_port ...` fuer
    beide Familien gleich aussieht und lesbar bleibt.
    """
    netem_weg()
    if not args:
        return
    if not nur_empfang:
        subprocess.run(["sudo", "tc", "qdisc", "add", "dev", "lo", "root", "netem", *args],
                       check=True)
        return

    subprocess.run(["sudo", "tc", "qdisc", "add", "dev", "lo", "root", "handle", "1:",
                    "prio", "bands", "3"], check=True)
    subprocess.run(["sudo", "tc", "qdisc", "add", "dev", "lo", "parent", "1:3",
                    "handle", "30:", "netem", *args], check=True)
    for prio, proto in ((1, "ip"), (2, "ipv6")):
        subprocess.run(["sudo", "tc", "filter", "add", "dev", "lo", "protocol", proto,
                        "parent", "1:", "prio", str(prio), "flower",
                        "ip_proto", "udp", "src_port", str(WEBRTC_UDP_PORT),
                        "flowid", "1:3"], check=True)


def netem_weg() -> None:
    subprocess.run(["sudo", "tc", "qdisc", "del", "dev", "lo", "root"],
                   stderr=subprocess.DEVNULL, check=False)


def lauf(profil: str, secs: float, label: str, nur_empfang: bool,
         echt: bool = False) -> dict | None:
    """Ein Prueflauf unter einem Stoerprofil.

    `echt` schaltet vom Referenzsender (Datei) auf den echten Sidecar mit
    Zeitmuster um. Das ist noetig, sobald die ENDE-ZU-ENDE-Latenz die Frage ist:
    eine konstante Laufzeit verschiebt weder Ankunftsabstaende noch die Zeit vom
    Netz bis zum Schirm — mit dem Referenzsender ist sie schlicht unsichtbar.
    Kostet dafuer einen wachen Bildschirm und den Portal-Zugriff.
    """
    tag = f"netz-{label}"
    if echt:
        befehl = [str(HERE / "mit-bildschirm.sh"), sys.executable,
                  str(HERE / "real-harness.py"), "--secs", str(secs),
                  "--fps", "60", "--kbps", "4000", "--e2e", "--label", tag]
    else:
        befehl = [sys.executable, str(HERE / "harness.py"),
                  "--secs", str(secs), "--label", tag]
    netem_setzen(PROFILE[profil], nur_empfang)
    try:
        r = subprocess.run(befehl, capture_output=True, text=True, timeout=secs + 240)
        if r.returncode != 0:
            print(f"  [{profil}] Prueflauf fehlgeschlagen:\n{r.stderr[-500:]}", file=sys.stderr)
            return None
    finally:
        netem_weg()

    pfad = HERE / f"samples-{tag}.json"
    if not pfad.exists():
        return None
    proben = json.loads(pfad.read_text())
    return auswerten(profil, proben)


def auswerten(profil: str, proben: list[dict]) -> dict:
    """Verdichtet die Ein-Sekunden-Proben zu den Groessen, die hier zaehlen.

    Die erste Probe faellt weg: da laeuft der Sender noch an, und ein
    Anlaufwert wuerde jeden Vergleich verzerren.
    """
    p = proben[1:] or proben

    def med(feld: str, teiler: float = 1.0) -> float:
        werte = [s[feld] / teiler for s in p if s.get(feld) is not None]
        return round(st.median(werte), 2) if werte else 0.0

    fps = [s.get("fps", 0) for s in p]
    return {
        "profil": profil,
        "proben": len(p),
        "fps_median": med("fps"),
        "stillstaende": sum(1 for f in fps if f == 0),
        "decode_ms": med("decode_avg_us", 1000),
        "glass_ms": med("glass_avg_us", 1000),
        "ankunft_max_ms": med("arrival_gap_max_us", 1000),
        "verloren": max((s.get("packets_lost", 0) for s in p), default=0),
        "umsortiert": max((s.get("packets_reordered", 0) for s in p), default=0),
        "bilder_verworfen": max((s.get("frames_dropped", 0) for s in p), default=0),
        "e2e_ms": med("e2e_avg_us", 1000),
        "e2e_misses": sum(s.get("e2e_misses", 0) for s in p),
        "zustand": p[-1].get("state", "?"),
        "bilder_gesamt": max((s.get("frames_decoded", 0) for s in p), default=0),
    }


def bewerten(e: dict) -> list[str]:
    """Abnahmekriterien. Leere Liste = bestanden."""
    maengel = []
    if e["bilder_gesamt"] == 0:
        maengel.append("KEIN BILD")
    if e["zustand"] not in ("playing", "Playing"):
        maengel.append(f"Zustand {e['zustand']}")
    # Ein Stillstand von mehr als einem Fuenftel der Laufzeit ist kein
    # Verschlucken mehr, sondern ein Ausfall.
    if e["stillstaende"] > max(1, e["proben"] // 5):
        maengel.append(f"{e['stillstaende']} Sekunden ohne Bild")
    return maengel


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profil", choices=sorted(PROFILE), default="klar")
    ap.add_argument("--alle", action="store_true", help="alle Profile nacheinander")
    ap.add_argument("--secs", type=float, default=20.0)
    ap.add_argument("--wdh", type=int, default=1, help="Wiederholungen je Profil")
    ap.add_argument("--nur-empfang", action="store_true",
                    help="Stoerung nur auf den Weg MediaMTX -> Player, Push bleibt sauber")
    ap.add_argument("--echt", action="store_true",
                    help="echter Sidecar + Zeitmuster statt Referenzsender (misst Ende zu Ende)")
    args = ap.parse_args()

    profile = sorted(PROFILE) if args.alle else [args.profil]
    # Handler, damit ein Abbruch per Strg-C die Schleife nicht mit gesetzter
    # Stoerung zuruecklaesst.
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: (netem_weg(), sys.exit(130)))

    ergebnisse = []
    try:
        for profil in profile:
            for i in range(args.wdh):
                e = lauf(profil, args.secs, f"{profil}-{i + 1}", args.nur_empfang, args.echt)
                if e is None:
                    print(f"{profil}-{i + 1}: kein Ergebnis")
                    continue
                maengel = bewerten(e)
                e["maengel"] = maengel
                ergebnisse.append(e)
                status = "ok" if not maengel else "MANGEL: " + ", ".join(maengel)
                print(f"{profil:14s} #{i + 1}  fps {e['fps_median']:6.1f}  "
                      f"decode {e['decode_ms']:5.2f} ms  glass {e['glass_ms']:6.2f} ms  "
                      f"e2e {e['e2e_ms']:7.2f} ms  verloren {e['verloren']:3d}  "
                      f"Stillstaende {e['stillstaende']}  {status}")
    finally:
        netem_weg()

    (HERE / "netz-ergebnisse.json").write_text(json.dumps(ergebnisse, indent=1))
    schlecht = [e for e in ergebnisse if e["maengel"]]
    print(f"\n{len(ergebnisse) - len(schlecht)} von {len(ergebnisse)} Laeufen ohne Mangel")
    return 1 if schlecht else 0


if __name__ == "__main__":
    raise SystemExit(main())
