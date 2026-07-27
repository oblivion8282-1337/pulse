#!/usr/bin/env bash
# Kappt die Cron-Logs in diesem Verzeichnis auf die letzten N Zeilen.
#
# **Warum nicht logrotate.** Das wäre der Lehrbuchweg, verlangt aber eine Datei
# unter /etc/logrotate.d und damit root — auf diesem Server will `sudo` ein
# Passwort, also läuft nichts davon unbeaufsichtigt aus einer Crontab. Dieses
# Skript kommt ohne aus.
#
# **Warum in-place statt umbenennen.** Die Logs werden per Cron-Redirect (`>>`)
# geschrieben, also mit O_APPEND. Würde man die Datei wegbewegen und neu
# anlegen, schriebe ein gerade laufender Job weiter in die ALTE Datei — die
# Zeilen wären unsichtbar, bis der nächste Lauf startet. Deshalb bleibt die
# Datei dieselbe (gleiche Inode) und wird nur neu befüllt: `cat > datei`
# schneidet ab und schreibt, ein O_APPEND-Schreiber hängt danach korrekt hinten
# an. `pulse-update.sh` läuft alle zwei Minuten — die Überschneidung ist real,
# nicht theoretisch.
#
# Verlust im schlimmsten Fall: eine einzelne Zeile, die genau während des
# Kappens geschrieben wird. Für Cron-Protokolle ist das in Ordnung; wer eine
# lückenlose Spur braucht, nimmt journald.
#
#   ./rotate-logs.sh [zeilen]     # Standard: 2000
set -euo pipefail

ZEILEN="${1:-2000}"
HIER="$(cd "$(dirname "$0")" && pwd)"

for datei in "$HIER"/*.log; do
    [ -f "$datei" ] || continue
    vorher=$(wc -l < "$datei")
    [ "$vorher" -le "$ZEILEN" ] && continue
    tmp="$(mktemp)"
    tail -n "$ZEILEN" "$datei" > "$tmp"
    cat "$tmp" > "$datei"      # gleiche Inode behalten (s. oben)
    rm -f "$tmp"
    echo "$(date -u +%FT%TZ) rotate-logs: $(basename "$datei") $vorher -> $ZEILEN Zeilen"
done
