#!/usr/bin/env bash
#
# Alte Windows-Installer aus ~/pulse/updates-win raeumen.
# ======================================================
#
# **Warum es das braucht.** Jeder `win-build` legt einen neuen NSIS-Installer
# ab (~144 MB) und nichts holt ihn je wieder weg. Am 2026-08-07 lagen dort 40
# Stueck mit zusammen 5,9 GB — jede je veroeffentlichte Version von 0.1.0 an.
# Das waechst bei aktuellem Tempo um rund 2,5 GB im Monat und hoert nie auf.
#
# **Was wirklich gebraucht wird.** `latest.yml` verweist auf GENAU EINE Datei;
# electron-updater holt sich nur die. Dazu `Pulse-Setup-latest.exe` fuer den
# Direktdownload von der Webseite. Alles andere ist Archiv.
#
# **Die Blockmaps bleiben ALLE liegen, und zwar mit Absicht.** Sie sind je rund
# 155 KB, zusammen also wenige Megabyte, und sie sind es, aus denen
# electron-updater eine differenzielle Aktualisierung rechnet. Sie zu loeschen
# spart nichts Nennenswertes und kann Bestandsclients zum vollen Download
# zwingen. Weg kommen nur die `.exe`.
#
# **Alte Installer sind KEIN Sicherheitsnetz fuer die Auto-Update-Kette.** Der
# Updater laeuft mit `allowDowngrade=false` (s. CLAUDE.md): eine kaputte
# Fassung laesst sich NICHT dadurch zuruecknehmen, dass man `latest.yml`
# zurueckstellt. Wer eine alte Version behalten will, will sie zum Aushelfen von
# Hand — und dafuer genuegen ein paar, nicht vierzig.
#
# **Die Schutzliste steht vor jedem Loeschen** (dasselbe Muster wie
# `registry-prune.py`): erst wird eingesammelt, was bleiben MUSS, danach wird
# nur angefasst, was darin nicht vorkommt. Fehlt `latest.yml` oder laesst sie
# sich nicht lesen, bricht das Skript ab, statt zu raten — ohne sie ist nicht
# bekannt, welche Fassung die ausgelieferte ist.
#
# Trockenlauf (Vorgabe, aendert nichts):
#     ./updates-prune.sh
# Scharf:
#     ./updates-prune.sh --apply
# Mehr oder weniger aufheben:
#     ./updates-prune.sh --behalte 10 --apply

set -euo pipefail

VERZ="${PULSE_UPDATES_DIR:-$HOME/pulse/updates-win}"
BEHALTE=5
APPLY=false

while [ $# -gt 0 ]; do
  case "$1" in
    --apply)   APPLY=true; shift ;;
    --behalte) BEHALTE="${2:?--behalte braucht eine Zahl}"; shift 2 ;;
    --verz)    VERZ="${2:?--verz braucht einen Pfad}"; shift 2 ;;
    *) echo "unbekannter Schalter: $1" >&2; exit 2 ;;
  esac
done

[ -d "$VERZ" ] || { echo "Verzeichnis fehlt: $VERZ" >&2; exit 1; }
cd "$VERZ"

# --- Schutzliste -------------------------------------------------------------
# Ohne latest.yml ist unbekannt, welche Fassung ausgeliefert wird. Dann lieber
# gar nichts tun: ein geloeschter Installer, auf den latest.yml zeigt, macht das
# Auto-Update fuer ALLE Bestandsclients kaputt.
[ -f latest.yml ] || { echo "latest.yml fehlt in $VERZ — Abbruch, es wird nicht geraten." >&2; exit 1; }

AUSGELIEFERT="$(sed -n 's/^path:[[:space:]]*//p' latest.yml | tr -d '\r' | head -1)"
[ -n "$AUSGELIEFERT" ] || { echo "latest.yml nennt kein 'path:' — Abbruch." >&2; exit 1; }

# Die jüngsten N nach Versionsnummer, plus die ausgelieferte, plus der feste
# Direktdownload-Name.
mapfile -t JUENGSTE < <(ls -1 Pulse-Setup-*.exe 2>/dev/null \
  | grep -E 'Pulse-Setup-[0-9]+\.[0-9]+\.[0-9]+\.exe$' \
  | sort -V | tail -n "$BEHALTE")

behalten() {
  local f="$1"
  [ "$f" = "$AUSGELIEFERT" ] && return 0
  [ "$f" = "Pulse-Setup-latest.exe" ] && return 0
  local j
  for j in "${JUENGSTE[@]+"${JUENGSTE[@]}"}"; do [ "$f" = "$j" ] && return 0; done
  return 1
}

# --- Kandidaten --------------------------------------------------------------
WEG=()
FREI=0
for f in Pulse-Setup-*.exe; do
  [ -e "$f" ] || continue
  if behalten "$f"; then continue; fi
  WEG+=("$f")
  FREI=$(( FREI + $(stat -c%s "$f") ))
done

echo "Verzeichnis        : $VERZ"
echo "Ausgeliefert       : $AUSGELIEFERT (laut latest.yml)"
echo "Aufgehoben         : die juengsten $BEHALTE + ausgelieferte + Pulse-Setup-latest.exe"
echo "Blockmaps          : bleiben unangetastet ($(ls -1 ./*.blockmap 2>/dev/null | wc -l) Stueck)"
echo "Installer gesamt   : $(ls -1 Pulse-Setup-*.exe 2>/dev/null | wc -l)"
echo "Davon zu loeschen  : ${#WEG[@]}  ($(numfmt --to=iec "$FREI" 2>/dev/null || echo "$FREI B"))"
echo

if [ "${#WEG[@]}" -eq 0 ]; then
  echo "Nichts zu tun."
  exit 0
fi

printf '  %s\n' "${WEG[@]}"
echo

if [ "$APPLY" != true ]; then
  echo "TROCKENLAUF — nichts geloescht. Mit --apply scharf schalten."
  exit 0
fi

for f in "${WEG[@]}"; do rm -f -- "$f"; done
echo "Geloescht: ${#WEG[@]} Installer, $(numfmt --to=iec "$FREI" 2>/dev/null || echo "$FREI B") frei."
echo "Verbleibend: $(du -sh "$VERZ" | cut -f1)"
