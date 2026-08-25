"""Der provided-Modus fuegte das Zertifikat nie ein — still, mit Exit 0.

Ein Backslash zu viel: bash loeste `\\$PULSE_HOSTNAME` zum WERT auf, gesucht
wurde also der aufgeloeste Hostname, waehrend im Template Caddys eigener
Platzhalter steht. Das Skript meldete trotzdem "Verwende bereitgestelltes Cert",
und `pulse-doctor` prueft an dieser Stelle die Dateien auf der Platte statt der
Caddy-Konfiguration — also genau das, was der Fehler trennt.

Die sed-Aufrufe werden unveraendert aus 09-init-caddy.sh geschnitten statt hier
per Hand nachgebaut: die Backslash-Verschachtelung ist genau die Stelle, an der
der Fehler entstanden ist, und ein zweites Abtippen im Test haette dieselbe
Falle noch einmal aufreissen koennen. Damit prueft der Test immer die Zeile,
die tatsaechlich im Skript steht.
"""

from __future__ import annotations

import pathlib
import shutil
import subprocess

S6 = pathlib.Path(__file__).resolve().parents[1] / "s6"
TEMPLATE = S6 / "etc/caddy/Caddyfile.template"
SKRIPT = S6 / "etc/s6-overlay/scripts/09-init-caddy.sh"


def _schneide_block(startmuster: str, *, inkl_pruefung: bool = False) -> str:
    """Schneidet einen sed-Aufruf (samt Vorspann) unveraendert aus dem echten Skript.

    Der provided-Zweig ist nach dem Fix zweizeilig (sed -i "...a\\ + Fortsetzungs-
    zeile), der behind-proxy-Zweig einzeilig — deshalb keine feste Zeilenzahl,
    sondern bis zur ersten Zeile lesen, die auf `"$TARGET"` endet.

    `inkl_pruefung=True` haengt den direkt anschliessenden `if ! grep ...; then
    ... exit 1; fi`-Block mit an. Der ist der eigentliche Waechter gegen einen
    stillen sed-Fehlschlag (der urspruengliche Bug: sed traf nicht, Exit 0,
    niemand merkte es) — ohne ihn wuerde ein Test nur den Erfolgsfall pruefen
    und genau die Bauart wiederholen, die diesen Fehler erst ermoeglicht hat.
    Default False, weil die Gegenprobe (behind-proxy-Vorbild) den Block schon
    vor diesem Task hatte und nicht jeder Aufrufer ihn braucht.
    """
    zeilen = SKRIPT.read_text(encoding="utf-8").split("\n")
    start = next(i for i, z in enumerate(zeilen) if z.strip().startswith(startmuster))
    ende = start
    while not zeilen[ende].rstrip().endswith('"$TARGET"'):
        ende += 1
    if inkl_pruefung:
        assert zeilen[ende + 1].strip().startswith("if "), "kein if direkt nach dem sed-Aufruf?"
        while zeilen[ende].strip() != "fi":
            ende += 1
    return "\n".join(zeilen[start : ende + 1])


def _fahre_zweig_roh(
    tmp_path: pathlib.Path, sed_aufruf: str, *, vorlage: pathlib.Path = TEMPLATE, **umgebung: str
) -> tuple[subprocess.CompletedProcess, pathlib.Path]:
    """Kopiert ein Template und laesst einen echten sed-Aufruf (+ Nachkontrolle) darauf los.

    Ohne `check=True` — der Aufrufer entscheidet selbst, ob Exit 0 oder 1
    erwartet wird (die Nachkontrolle bricht bei Misserfolg absichtlich mit
    Exit 1 ab).
    """
    ziel = tmp_path / "Caddyfile"
    shutil.copy(vorlage, ziel)
    vorspann = "\n".join(f'{k}="{v}"' for k, v in umgebung.items())
    ergebnis = subprocess.run(
        ["bash", "-c", f'set -eu\nTARGET="{ziel}"\n{vorspann}\n{sed_aufruf}'],
        capture_output=True, text=True,
    )
    return ergebnis, ziel


def _fahre_zweig(tmp_path: pathlib.Path, sed_aufruf: str, **umgebung: str) -> str:
    """Wie `_fahre_zweig_roh`, erwartet aber Erfolg und gibt den Dateiinhalt zurueck."""
    ergebnis, ziel = _fahre_zweig_roh(tmp_path, sed_aufruf, **umgebung)
    assert ergebnis.returncode == 0, ergebnis.stderr
    return ziel.read_text(encoding="utf-8")


def test_provided_traegt_die_tls_zeile_ein(tmp_path):
    sed_aufruf = _schneide_block("TLS_LINE=", inkl_pruefung=True)
    inhalt = _fahre_zweig(
        tmp_path, sed_aufruf,
        PULSE_HOSTNAME="chat.firma.de",
        CERT="/data/certs/cert.pem", KEY="/data/certs/key.pem",
    )
    assert "tls /data/certs/cert.pem /data/certs/key.pem" in inhalt


def test_provided_nachkontrolle_faengt_stillen_sed_fehlschlag(tmp_path):
    """Der Waechter selbst: trifft der sed-Ausdruck nicht, muss die Nachkontrolle
    abbrechen — nicht mit Exit 0 weiterlaufen wie vor dem Fix.

    Das Template wird dafuer absichtlich kaputt gemacht (Platzhalter umbenannt),
    damit der Site-Block, den sed sucht, nicht mehr existiert — unabhaengig vom
    konkreten Escaping-Bug, der diesen Task ausgeloest hat. Gegenprobe im
    selben Test: am intakten Template bleibt der Waechter still (Exit 0, Zeile
    drin) — er darf den Erfolgsfall nicht faelschlich mit abwuergen.
    """
    kaputt = tmp_path / "kaputtes-template"
    kaputt.write_text(
        TEMPLATE.read_text(encoding="utf-8").replace("{$PULSE_HOSTNAME} {", "{$ANDERER_NAME} {"),
        encoding="utf-8",
    )
    sed_aufruf = _schneide_block("TLS_LINE=", inkl_pruefung=True)
    umgebung = dict(
        PULSE_HOSTNAME="chat.firma.de",
        CERT="/data/certs/cert.pem", KEY="/data/certs/key.pem",
    )

    fehlschlag_verzeichnis = tmp_path / "fehlschlag"
    fehlschlag_verzeichnis.mkdir()
    fehlschlag, _ = _fahre_zweig_roh(fehlschlag_verzeichnis, sed_aufruf, vorlage=kaputt, **umgebung)
    assert fehlschlag.returncode == 1
    assert "FEHLER" in fehlschlag.stderr

    erfolg_verzeichnis = tmp_path / "erfolg"
    erfolg_verzeichnis.mkdir()
    erfolg, ziel = _fahre_zweig_roh(erfolg_verzeichnis, sed_aufruf, **umgebung)
    assert erfolg.returncode == 0, erfolg.stderr
    assert "tls /data/certs/cert.pem /data/certs/key.pem" in ziel.read_text(encoding="utf-8")


def test_behind_proxy_schreibt_die_site_adresse_um(tmp_path):
    """Gegenprobe: der Schwesterzweig funktionierte und muss es bleiben."""
    sed_aufruf = _schneide_block('sed -i "s|{')
    inhalt = _fahre_zweig(tmp_path, sed_aufruf, PULSE_HOSTNAME="chat.firma.de", HTTP_PORT="8080")
    assert ":8080 {" in inhalt
