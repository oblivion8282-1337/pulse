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


def _schneide_block(startmuster: str) -> str:
    """Schneidet einen sed-Aufruf (samt Vorspann) unveraendert aus dem echten Skript.

    Der provided-Zweig ist nach dem Fix zweizeilig (sed -i "...a\\ + Fortsetzungs-
    zeile), der behind-proxy-Zweig einzeilig — deshalb keine feste Zeilenzahl,
    sondern bis zur ersten Zeile lesen, die auf `"$TARGET"` endet.
    """
    zeilen = SKRIPT.read_text(encoding="utf-8").split("\n")
    start = next(i for i, z in enumerate(zeilen) if z.strip().startswith(startmuster))
    ende = start
    while not zeilen[ende].rstrip().endswith('"$TARGET"'):
        ende += 1
    return "\n".join(zeilen[start : ende + 1])


def _fahre_zweig(tmp_path: pathlib.Path, sed_aufruf: str, **umgebung: str) -> str:
    """Kopiert das echte Template und laesst einen echten sed-Aufruf darauf los."""
    ziel = tmp_path / "Caddyfile"
    shutil.copy(TEMPLATE, ziel)
    vorspann = "\n".join(f'{k}="{v}"' for k, v in umgebung.items())
    subprocess.run(
        ["bash", "-c", f'set -eu\nTARGET="{ziel}"\n{vorspann}\n{sed_aufruf}'],
        check=True, capture_output=True, text=True,
    )
    return ziel.read_text(encoding="utf-8")


def test_provided_traegt_die_tls_zeile_ein(tmp_path):
    sed_aufruf = _schneide_block("TLS_LINE=")
    inhalt = _fahre_zweig(
        tmp_path, sed_aufruf,
        PULSE_HOSTNAME="chat.firma.de",
        CERT="/data/certs/cert.pem", KEY="/data/certs/key.pem",
    )
    assert "tls /data/certs/cert.pem /data/certs/key.pem" in inhalt


def test_behind_proxy_schreibt_die_site_adresse_um(tmp_path):
    """Gegenprobe: der Schwesterzweig funktionierte und muss es bleiben."""
    sed_aufruf = _schneide_block('sed -i "s|{')
    inhalt = _fahre_zweig(tmp_path, sed_aufruf, PULSE_HOSTNAME="chat.firma.de", HTTP_PORT="8080")
    assert ":8080 {" in inhalt
