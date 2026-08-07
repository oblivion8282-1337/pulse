#!/usr/bin/env python3
"""Kommt FlexFEC beim BROWSER-Zuschauer an — und repariert sie dort auch?

**Warum es das braucht.** Die Paritaet erzeugt der Server (MediaMTX-Fork,
`PULSE_FLEXFEC`) fuer JEDEN Zuschauer, und sie kostet jeden rund 20 Prozent
mehr Daten. Der native Player hat einen eigenen FlexFEC-Empfaenger; ueber
Chromium sagte das nichts. Am 2026-07-31 wurde dort bereits belegt, dass die
Antwort `a=ssrc-group:FEC-FR` traegt und Paritaetspakete ankommen — offen blieb
das Entscheidende: **repariert sie auch?** Anwesenheit ist kein Nutzen.

Dieses Skript faehrt EINEN Sender und schickt dieselben Zuschauer-Varianten
nacheinander dagegen, wahlweise mit gesetztem Paketverlust. FEC an/aus ist
KEIN Schalter hier — das ist eine Servereinstellung; das Skript wird zweimal
gefahren, dazwischen wird der Container neu erzeugt.

    ./fec-browser.py --label aus-klar   --zuschauer chromium,electron,nativ
    ./fec-browser.py --label aus-2pct   --verlust 2.0 --laeufe 3
    # PULSE_FLEXFEC auf "1" setzen, Container neu erzeugen
    ./fec-browser.py --label an-klar
    ./fec-browser.py --label an-2pct    --verlust 2.0 --laeufe 3

Der Verlust wird auf die Schleife gelegt und trifft NUR die Medienpakete von
MediaMTX (UDP von Port 8189) — der RTMPS-Push des Senders bleibt ungestoert,
sonst waere offen, welche Seite schwaechelt. Die Mechanik kommt aus
`netz-harness.py`; `tc` sagt hinterher, wieviele Pakete es wirklich waren.
Das ist die Bezugsgroesse, ohne die eine FEC-Zaehlung nichts aussagt.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

import harness

HIER = Path(__file__).resolve().parent

# Die Stoer-Mechanik NICHT nachbauen, sondern die erprobte aus `netz-harness.py`
# benutzen. Der Bindestrich im Dateinamen verbietet den normalen Import — daher
# der Umweg ueber importlib. Kopieren waere die schlechtere Wahl: dort steckt
# die Filter-Feinheit (IPv4 UND IPv6, `flower` statt `u32`), an der eine
# selbstgebaute Fassung still vorbeimessen wuerde.
def _netz_modul():
    import importlib.util
    spec = importlib.util.spec_from_file_location("netz_harness", HIER / "netz-harness.py")
    modul = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(modul)
    return modul


_netz = _netz_modul()
netem_setzen, netem_weg, netem_wirkung = (
    _netz.netem_setzen, _netz.netem_weg, _netz.netem_wirkung)

# (Name, zusaetzliche browser-whep-Argumente)
BROWSER_VARIANTEN = {
    # Headless ist hier richtig, nicht bequem: am 2026-08-03 wurde gemessen,
    # dass Chromium den AV1-WHEP-Strom in ALLEN fuenf Varianten in Software
    # dekodiert (`docs/2026-08-03-chromium-webrtc-decode-messung.md`) — ein
    # sichtbares Fenster aendert am Decoder also nichts und braechte nur
    # Compositor-Last in die Messung.
    "chromium": [],
    # EIGENES Datenverzeichnis, sonst startet die Fassung gar nicht: laeuft
    # nebenher der Dev-Electron (`dev-up.fish`), bricht der Start wortlos mit
    # Code 0 ab — Playwright meldet nur "Process failed to launch", und der
    # Lauf sieht wie ein Messfehler aus statt wie eine belegte Kollision.
    "electron": ["--electron", "--flags", "--user-data-dir=/tmp/pulse-electron-fecmess"],
}


def browser_lauf(variante: str, whep: str, secs: float, label: str) -> dict:
    """Ein Zuschauer-Lauf im Browser; liefert die Kennzahlen als dict."""
    voll = f"{label}-{variante}"
    cmd = ["node", str(HIER / "browser-whep.mjs"), "--url", whep,
           "--secs", str(int(secs)), "--label", voll,
           *BROWSER_VARIANTEN[variante]]
    fertig = subprocess.run(cmd, capture_output=True, text=True,
                            timeout=secs + 150, cwd=HIER)
    erg: dict = {"zuschauer": variante, "label": voll}

    # Die SDP-Antwort ist die halbe Frage: Chromium legt den FlexFEC-Empfang
    # NUR bei vorhandener SSRC-Gruppe an. `browser-whep.mjs` schreibt sie mit.
    sdp = HIER / f"sdp-{voll}.txt"
    if sdp.exists():
        text = sdp.read_text()
        antwort = text.split("--- ANSWER ---", 1)[-1]
        erg["antwort_flexfec_pt"] = "flexfec-03" in antwort
        erg["antwort_ssrc_gruppe"] = "ssrc-group:FEC-FR" in antwort

    if fertig.returncode != 0:
        erg["fehler"] = (fertig.stderr or fertig.stdout or "").strip()[-300:]
        return erg

    datei = HIER / f"browser-proben-{voll}.json"
    if not datei.exists():
        erg["fehler"] = "keine Probendatei"
        return erg
    proben = json.loads(datei.read_text())
    # Die ersten zwei Sekunden sind Aufbau (ICE, erstes Vollbild).
    gut = proben[2:]
    if len(gut) < 2:
        erg["fehler"] = "zu wenige Proben"
        return erg
    a, z = gut[0], gut[-1]

    def zuwachs(feld: str) -> int:
        return int((z.get(feld) or 0) - (a.get(feld) or 0))

    # Bildstabilitaet kommt aus dem ZUWACHS von framesDecoded je Sekunde, nicht
    # aus einem Endstand: ein Standbild meldet weiter Bilder, aber der Zuwachs
    # bricht ein. Sekunden unter der halben Sollrate sind der sichtbare Schaden.
    je_sek = [int((n.get("framesDecoded") or 0) - (v.get("framesDecoded") or 0))
              for v, n in zip(gut, gut[1:], strict=False)]
    erg.update({
        "sekunden": len(gut),
        "bilder": zuwachs("framesDecoded"),
        "bilder_je_sek_min": min(je_sek) if je_sek else None,
        "bilder_je_sek_median": sorted(je_sek)[len(je_sek) // 2] if je_sek else None,
        "sekunden_unter_30": sum(1 for x in je_sek if x < 30),
        "pakete": zuwachs("packetsReceived"),
        "verloren": zuwachs("packetsLost"),
        "fec_pakete": zuwachs("fecPacketsReceived"),
        "fec_verworfen": (z.get("fecPacketsDiscarded")
                          if z.get("fecPacketsDiscarded") is not None else None),
        "nack": zuwachs("nackCount"),
        "pli": zuwachs("pliCount"),
        "einfrieren": zuwachs("freezeCount"),
        "einfrier_sekunden": round(
            (z.get("totalFreezesDuration") or 0) - (a.get("totalFreezesDuration") or 0), 3),
        "decoder": z.get("decoderImplementation"),
        "codec": z.get("mimeType"),
    })
    return erg


def nativ_lauf(whep: str, secs: float, label: str) -> dict:
    """Derselbe Lauf im nativen Player — der Vergleichsfall."""
    voll = f"{label}-nativ"
    erg: dict = {"zuschauer": "nativ", "label": voll}
    with (HIER / f"player-{voll}.log").open("w") as log:
        spieler = harness.Player(log)
        proben: list[dict] = []
        try:
            res = spieler.call("open", url=whep, title=f"FEC {voll}")
            if not res.get("ok"):
                erg["fehler"] = f"open: {res}"
                return erg
            sid = res["session"]
            ende = time.monotonic() + secs
            while time.monotonic() < ende:
                time.sleep(1.0)
                s = spieler.call("stats", session=sid)
                if s.get("ok"):
                    proben.append(s)
        finally:
            spieler.stop()

    gut = proben[2:]
    if len(gut) < 2:
        erg["fehler"] = "zu wenige Proben"
        return erg
    (HIER / f"samples-{voll}.json").write_text(json.dumps(gut, indent=1))
    fps = [float(s.get("fps") or 0) for s in gut]
    erg.update({
        "sekunden": len(gut),
        "fps_median": round(sorted(fps)[len(fps) // 2], 1),
        "fps_min": round(min(fps), 1),
        "sekunden_unter_30": sum(1 for f in fps if f < 30),
        "verloren": int(gut[-1].get("packets_lost") or 0),
        # Feldnamen aus `session.rs`. `fec_repariert` ist die einzige Zahl, die
        # NUTZEN belegt: Paritaet, aus der ein fehlendes Paket zurueckgerechnet
        # wurde. Anwesenheit von Paritaet allein sagt darueber nichts.
        "fec_repariert": int(gut[-1].get("fec_repariert") or 0),
        "fec_unreparierbar": int(gut[-1].get("fec_unreparierbar") or 0),
        "fec_verworfen": int(gut[-1].get("fec_verworfen") or 0),
        "fec_zu_spaet": int(gut[-1].get("fec_zu_spaet") or 0),
    })
    return erg


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--label", required=True)
    ap.add_argument("--secs", type=float, default=20.0)
    ap.add_argument("--laeufe", type=int, default=1,
                    help="Wiederholungen je Zuschauer — Einzelmessungen bei "
                         "schwankenden Groessen beweisen nichts")
    ap.add_argument("--verlust", type=float, default=0.0, help="Prozent, netem")
    ap.add_argument("--buendel", action="store_true",
                    help="Verlust in Buendeln (Gilbert-Elliott) statt gleichverteilt")
    ap.add_argument("--zuschauer", default="chromium",
                    help="komma-getrennt aus chromium,electron,nativ")
    ap.add_argument("--quelle", default="fec-browser-av1-8.mkv")
    a = ap.parse_args()

    quelle = HIER / a.quelle
    if not quelle.exists():
        print(f"Vorlage fehlt: {quelle}", file=sys.stderr)
        return 2
    namen = [n.strip() for n in a.zuschauer.split(",") if n.strip()]
    unbekannt = [n for n in namen if n not in (*BROWSER_VARIANTEN, "nativ")]
    if unbekannt:
        print(f"unbekannt: {unbekannt}", file=sys.stderr)
        return 2
    harness.SOURCE = quelle

    stoerung: list[str] = []
    if a.verlust > 0:
        stoerung = (["loss", "gemodel", f"{a.verlust}%", "50%"] if a.buendel
                    else ["loss", f"{a.verlust}%"])

    ergebnisse: list[dict] = []
    log_pfad = HIER / f"fec-browser-{a.label}.log"
    with log_pfad.open("w") as log:
        path, pub, rd = harness.mint_tokens()
        whep = f"http://localhost:8889/{path}/whep?token={rd}"
        push = harness.start_push(path, pub, audio=True, log=log)
        try:
            if not harness.warte_auf_strom(path, push):
                return 1
            print(f"Sender laeuft ({quelle.name}), Verlust "
                  f"{a.verlust} %{' in Buendeln' if a.buendel else ''}\n")
            for lauf_nr in range(1, a.laeufe + 1):
                for name in namen:
                    marke = f"{a.label}-l{lauf_nr}"
                    netem_setzen(stoerung, nur_empfang=True)
                    try:
                        r = (nativ_lauf(whep, a.secs, marke) if name == "nativ"
                             else browser_lauf(name, whep, a.secs, marke))
                    finally:
                        gesendet, verworfen = netem_wirkung() if stoerung else (0, 0)
                        netem_weg()
                    r.update({"lauf": lauf_nr, "netem_gesehen": gesendet,
                              "netem_verworfen": verworfen,
                              "netem_prozent": round(100 * verworfen / gesendet, 3)
                              if gesendet else 0.0})
                    if stoerung and verworfen == 0:
                        r["WARNUNG"] = "Verlustprofil gesetzt, aber NULL verworfen"
                    ergebnisse.append(r)
                    print(f"  Lauf {lauf_nr} {name}: " +
                          (r["fehler"][:70] if "fehler" in r else
                           f"{r.get('bilder', r.get('fps_median'))} Bilder/fps, "
                           f"fec={r.get('fec_pakete', r.get('fec_repariert'))} "
                           f"verloren={r.get('verloren')} "
                           f"netem={r['netem_verworfen']}/{r['netem_gesehen']} "
                           f"({r['netem_prozent']} %)"))
        finally:
            netem_weg()
            push.terminate()
            try:
                push.wait(timeout=10)
            except subprocess.TimeoutExpired:
                push.kill()

    ziel = HIER / f"fec-browser-{a.label}.json"
    ziel.write_text(json.dumps(
        {"label": a.label, "quelle": quelle.name, "secs": a.secs,
         "verlust_gesetzt": a.verlust, "buendel": a.buendel,
         "ergebnisse": ergebnisse}, indent=1))
    print(f"\nRoh: {ziel.name} · Protokoll: {log_pfad.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
