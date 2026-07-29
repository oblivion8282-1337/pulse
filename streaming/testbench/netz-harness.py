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
    # 0,2 % ist der Bereich, in dem echte Leitungen liegen — die Teststrecke zum
    # Hetzner-Server verlor 6-7 Pakete je 30-Sekunden-Lauf, also rund 0,05 %.
    # Ein Profil dafuer zu haben ist wichtig, weil sich die Wirkung der
    # Vollbild-Anforderung genau hier entscheidet: bei 0,2 % traegt sie, bei
    # 1 % halbiert sie nur noch (verlust-2026-07-28-vollbild-auf-zuruf.json).
    "verlust_leicht": ["loss", "0.2%"],
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
    # BUENDELVERLUST (Gilbert-Elliott). Der Fall, den gleichmaessiger Verlust
    # nicht abbildet und der ueber die Wirkung der Paritaet entscheidet: FlexFEC
    # verteilt interleaved, eine Gruppe ueberlebt genau EIN fehlendes Paket.
    # Liegen die Verluste in Klumpen, treffen sie dieselbe Gruppe mehrfach.
    # Die vier Werte sind p, r, 1-h, 1-k — Uebergang gut→schlecht, schlecht→gut,
    # Verlust im schlechten, Verlust im guten Zustand.
    #
    # ACHTUNG, hier steht eine Falle: `loss 5% 50%` (die KORRELATIONS-Schreibweise)
    # verwirft GAR NICHTS — 200 Pings, 0 % Verlust, waehrend `loss 5%` sauber 4 %
    # verwirft. Am 2026-07-29 hat eine erste Buendelreihe darueber 60 fps und null
    # Verluste in beiden Betriebsarten gemeldet und sah nach "Buendel sind
    # unproblematisch" aus. Deshalb `gemodel` und deshalb die Wirkungskontrolle
    # in `lauf()`, die die tatsaechlich verworfenen Pakete aus `tc` ausliest.
    "buendel": ["loss", "gemodel", "2%", "40%", "100%", "0%"],
    # Buendelverlust MIT Laufzeit. Ohne die ist die Frage nach der Paritaet
    # lokal gar nicht zu stellen: ueber die Schleife betraegt die Umlaufzeit
    # ~0, NACK holt jedes verlorene Paket sofort nach, und die Paritaet hat
    # nichts mehr zu reparieren. Am 2026-07-29 gemessen — bei reinem `buendel`
    # sind 20+4, 10+2 und GAR KEINE Paritaet ununterscheidbar (142 fps, null
    # Sekunden schwarz in allen neun Laeufen). Erst die 26,7 ms je Richtung
    # (halbe gemessene Umlaufzeit zum Hetzner-Testserver) machen NACK so
    # traege, dass sich Vorwaertskorrektur ueberhaupt auszahlen kann.
    "buendel_fern": ["delay", "26.7ms", "loss", "gemodel", "2%", "40%", "100%", "0%"],
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


def netem_wirkung() -> tuple[int, int]:
    """(gesendete, verworfene) Pakete der netem-Warteschlange.

    **Die einzige ehrliche Kontrolle, dass die Stoerung ueberhaupt wirkt.** Eine
    `netem`-Angabe, die der Kern annimmt, muss nichts tun: `loss 5% 50%` wird
    anstandslos gesetzt und verwirft dann null Pakete (2026-07-29). Wer das nicht
    merkt, liest den ungestoerten Lauf als Ergebnis der Stoerung — und bei einer
    Schutzschicht wie der Paritaet sieht das aus wie "bringt nichts".
    Gegen `ping` zu pruefen taugt hier nicht: mit `--nur-empfang` haengt die
    Stoerung an einem Filter auf den Medien-Port, ICMP laeuft daran vorbei.
    Die Zaehler von `tc` messen dagegen genau den Verkehr, um den es geht.
    """
    r = subprocess.run(["tc", "-s", "qdisc", "show", "dev", "lo"],
                       capture_output=True, text=True, check=False)
    # Der netem-Block ist der einzige, der uns interessiert; seine Statistik
    # steht in der Zeile nach seiner Kennung.
    zeilen = r.stdout.splitlines()
    for i, z in enumerate(zeilen):
        if "netem" not in z or i + 1 >= len(zeilen):
            continue
        stat = zeilen[i + 1].split()
        # Format: `Sent <bytes> bytes <pkts> pkt (dropped <n>, overlimits ...)`.
        # Gezaehlt werden PAKETE, nicht Bytes — die verworfenen sind ebenfalls
        # Pakete, und ein Anteil aus Bytes durch Pakete waere eine Fantasiezahl.
        if "pkt" in stat and "(dropped" in stat:
            gesendet = int(stat[stat.index("pkt") - 1])
            verworfen = int(stat[stat.index("(dropped") + 1].rstrip(","))
            return gesendet, verworfen
    return 0, 0


def netem_weg() -> None:
    subprocess.run(["sudo", "tc", "qdisc", "del", "dev", "lo", "root"],
                   stderr=subprocess.DEVNULL, check=False)


def lauf(profil: str, secs: float, label: str, nur_empfang: bool,
         echt: bool = False, weitere: list[str] | None = None,
         tag_zusatz: str = "", hwdec: str = "auto") -> dict | None:
    """Ein Prueflauf unter einem Stoerprofil.

    `echt` schaltet vom Referenzsender (Datei) auf den echten Sidecar mit
    Zeitmuster um. Das ist noetig, sobald die ENDE-ZU-ENDE-Latenz die Frage ist:
    eine konstante Laufzeit verschiebt weder Ankunftsabstaende noch die Zeit vom
    Netz bis zum Schirm — mit dem Referenzsender ist sie schlicht unsichtbar.
    Kostet dafuer einen wachen Bildschirm und den Portal-Zugriff.

    `weitere` reicht Sender-Einstellungen an `real-harness.py` durch (Codec,
    Bittiefe, Transportweg). Nur mit `--echt` sinnvoll: der Referenzsender
    spielt eine feste Datei ab und kennt nichts davon.
    """
    # Der Zusatz gehoert in den Namen, nicht nur in die Ausgabe: ohne ihn
    # schreiben zwei Durchgaenge mit verschiedenen Sender-Einstellungen ihre
    # Protokolle uebereinander, und hinterher fehlt genau das Log, in dem die
    # Antwort steht. Am 2026-07-28 einmal passiert.
    tag = "-".join(t for t in ("netz", tag_zusatz, label) if t)
    if echt:
        befehl = [str(HERE / "mit-bildschirm.sh"), sys.executable,
                  str(HERE / "real-harness.py"), "--secs", str(secs),
                  "--fps", "60", "--kbps", "4000", "--e2e", "--label", tag,
                  *(weitere or [])]
    else:
        befehl = [sys.executable, str(HERE / "harness.py"),
                  "--secs", str(secs), "--label", tag, "--hwdec", hwdec]
    netem_setzen(PROFILE[profil], nur_empfang)
    gesendet = verworfen = 0
    gescheitert = False
    try:
        r = subprocess.run(befehl, capture_output=True, text=True, timeout=secs + 240)
        if r.returncode != 0:
            print(f"  [{profil}] Prueflauf fehlgeschlagen:\n{r.stderr[-500:]}", file=sys.stderr)
            gescheitert = True
    finally:
        # VOR dem Abraeumen ablesen — mit der Warteschlange verschwinden auch
        # ihre Zaehler.
        if PROFILE[profil]:
            gesendet, verworfen = netem_wirkung()
        netem_weg()

    # Die Wirkung IMMER melden, auch nach einem Fehlschlag: gerade dann ist die
    # erste Frage, ob die Stoerung ueberhaupt anlag oder ob etwas anderes
    # schiefging.
    if PROFILE[profil]:
        anteil = 100.0 * verworfen / gesendet if gesendet else 0.0
        print(f"  [{profil}] Stoerung wirkte auf {gesendet} Pakete, "
              f"{verworfen} verworfen ({anteil:.2f} %)")
        if "loss" in PROFILE[profil] and verworfen == 0:
            print(f"  [{profil}] WARNUNG: Verlustprofil, aber NULL verworfene Pakete — "
                  f"die Messung zeigt den ungestoerten Fall", file=sys.stderr)

    if gescheitert:
        return None

    pfad = HERE / f"samples-{tag}.json"
    if not pfad.exists():
        return None
    proben = json.loads(pfad.read_text())
    ergebnis = auswerten(profil, proben)
    ergebnis["netem_gesendet"] = gesendet
    ergebnis["netem_verworfen"] = verworfen
    return ergebnis


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
    ap.add_argument("--proto", choices=["rtmps", "srt", "whip"],
                    help="Transportweg des Senders (nur mit --echt)")
    ap.add_argument("--codec", help="av1 oder h264 (nur mit --echt)")
    ap.add_argument("--bits", help="8 oder 10 (nur mit --echt)")
    ap.add_argument("--keyframe-on-gap", action="store_true",
                    help="Vollbild bei jeder gemeldeten Luecke anfordern (nur mit --echt)")
    # Unter Buendelverlust stirbt der Player reproduzierbar mit SIGSEGV in
    # libnvcuvid (2026-07-29, drei von drei Laeufen, Backtrace ueber
    # avcodec_send_packet). `sw` weicht dem aus und macht Messreihen unter
    # Verlust ueberhaupt erst moeglich — die Abstuerze sind ein eigener Faden.
    ap.add_argument("--hwdec", choices=("auto", "hw", "sw"), default="auto",
                    help="Decoder erzwingen (nur ohne --echt)")
    args = ap.parse_args()

    # Dieselben drei Werte gehen zweimal weg: als Schalter an den Sender und als
    # Namenszusatz ins Protokoll.
    weitere: list[str] = []
    teile: list[str] = []
    for name in ("proto", "codec", "bits"):
        wert = getattr(args, name)
        if wert:
            weitere += [f"--{name}", wert]
            teile.append(wert)
    if args.keyframe_on_gap:
        weitere.append("--keyframe-on-gap")
        # MUSS in den Namen: der Vergleich mit und ohne diesen Schalter ist
        # genau der, um den es dabei geht — ohne Unterscheidung im Namen
        # ueberschreibt der zweite Durchgang die Protokolle des ersten.
        teile.append("kfgap")
    tag_zusatz = "-".join(teile)
    if weitere and not args.echt:
        ap.error("Sender-Einstellungen wirken nur mit --echt")

    profile = sorted(PROFILE) if args.alle else [args.profil]
    # Handler, damit ein Abbruch per Strg-C die Schleife nicht mit gesetzter
    # Stoerung zuruecklaesst.
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: (netem_weg(), sys.exit(130)))

    ergebnisse = []
    try:
        for profil in profile:
            for i in range(args.wdh):
                e = lauf(profil, args.secs, f"{profil}-{i + 1}", args.nur_empfang,
                         echt=args.echt, weitere=weitere, tag_zusatz=tag_zusatz,
                         hwdec=args.hwdec)
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
