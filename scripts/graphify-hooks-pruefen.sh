#!/usr/bin/env bash
# Prueft und repariert die graphify-git-Hooks. Auf JEDER Maschine einmal laufen
# lassen — `.git/hooks` liegt ausserhalb der Versionsverwaltung und wandert
# deshalb NICHT mit einem `git pull` mit.
#
#   bash scripts/graphify-hooks-pruefen.sh            # nur pruefen
#   bash scripts/graphify-hooks-pruefen.sh --richten   # auch reparieren
#
# ── Warum es das gibt ───────────────────────────────────────────────────────
#
# Am 2026-08-07 stand am Ende von `post-commit`, `post-checkout` und
# `post-merge` ein von Hand angehaengter Block (`# pulse-graphify-sync-*`):
#
#     nohup sh -c "
#         cd graphify-out || exit 0
#         git add -A
#         git commit -m 'graph sync: <zeit>' --quiet
#         git push --quiet
#     " &
#
# Gemeint war das Sync-Repository, das in `graphify-out/` liegt. Getroffen hat
# es das Pulse-Repository — **git setzt beim Ausfuehren eines Hooks immer
# `GIT_DIR` auf das aufrufende Repository.** Das `cd` wechselt das Verzeichnis,
# nicht das Repository: die Befehle liefen also gegen Pulse, mit `graphify-out`
# als vermeintlichem Wurzelverzeichnis. `git add -A` nahm dessen Inhalt fuer den
# ganzen Baum, und der Commit landete auf dem gerade ausgecheckten Zweig — mit
# allem uebrigen als geloescht. Auf `feat/mobile-chatfirst-redesign` waren das
# 1737 Dateien und 277570 Zeilen, und der Block pusht das auch noch.
#
# Dreimal passiert an einem Tag, einmal davon bis nach GitHub. Bemerkt wurde es
# nur, weil ein Agent nach seinem Commit nachgesehen hat, was wirklich drinsteht.
#
# **Der Schaden war jedes Mal vollstaendig umkehrbar** (die Dateien liegen auf
# der Platte, die Vorgeschichte ist unversehrt) — aber ein Merge eines solchen
# Zweigs nach `main` haette den Baum geleert.
#
# ── Was hier repariert wird ─────────────────────────────────────────────────
#
# 1. Die git-Umgebung wird vor dem Unterprozess geloescht (`env -u GIT_DIR …`).
#    Das ist die Ursache.
# 2. `[ -d .git ] || exit 0` als zweite Sicherung: es wird nur committet, wenn
#    `graphify-out` wirklich ein eigenes Repository ist. Fehlt es — etwa in
#    einer frischen Arbeitskopie —, passiert gar nichts, statt in den
#    Elternbaum zu schreiben.
#
# Punkt 2 allein wuerde reichen, Punkt 1 allein auch. Beide, weil der Fehler
# still war und teuer: keine Fehlermeldung, kein Abbruch, nur ein Commit, der
# aussieht wie jeder andere.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
HOOKS="$(git rev-parse --git-common-dir)/hooks"
RICHTEN=false
[ "${1:-}" = "--richten" ] && RICHTEN=true

# Die Zeile, an der die kaputte Fassung zu erkennen ist. Bewusst am `cd`
# festgemacht und nicht am Kommentar-Marker: der Marker koennte fehlen, der
# Befehl nicht.
MUSTER='cd graphify-out || exit 0'
HEILUNG='env -u GIT_DIR'

betroffen=()
for h in post-commit post-checkout post-merge; do
  datei="$HOOKS/$h"
  [ -f "$datei" ] || continue
  grep -qF "$MUSTER" "$datei" || continue          # Block gar nicht vorhanden
  grep -qF "$HEILUNG" "$datei" && continue         # schon repariert
  betroffen+=("$h")
done

if [ ${#betroffen[@]} -eq 0 ]; then
  echo "OK — kein Hook schreibt ins falsche Repository."
else
  echo "BETROFFEN: ${betroffen[*]}"
  echo "  Diese Hooks committen in das AUFRUFENDE Repository statt in graphify-out."
  if ! $RICHTEN; then
    echo "  Zum Reparieren: bash scripts/graphify-hooks-pruefen.sh --richten"
  else
    for h in "${betroffen[@]}"; do
      datei="$HOOKS/$h"
      cp "$datei" "$datei.bak"
      python3 - "$datei" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); t = p.read_text()
alt = 'nohup sh -c "\n    cd graphify-out || exit 0'
neu = ('# GIT_DIR/GIT_WORK_TREE MUESSEN WEG — git setzt sie beim Hook-Aufruf auf\n'
       '# das AUFRUFENDE Repository, und ein blosses `cd` wechselt nur das\n'
       '# Verzeichnis. Begruendung: scripts/graphify-hooks-pruefen.sh\n'
       'nohup env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_OBJECT_DIRECTORY \\\n'
       '  -u GIT_NAMESPACE -u GIT_PREFIX sh -c "\n'
       '    cd graphify-out || exit 0\n'
       '    [ -d .git ] || exit 0   # nur im EIGENEN Repo committen')
if alt not in t:
    sys.exit(f"Muster nicht gefunden — {p.name} von Hand pruefen")
p.write_text(t.replace(alt, neu))
PY
      sh -n "$datei"
      echo "  $h repariert (Sicherung: $h.bak)"
    done
  fi
fi

# ── Nachsehen, ob schon Schaden entstanden ist ──────────────────────────────
#
# Unabhaengig davon, ob die Hooks repariert wurden: ein solcher Commit kann
# laengst in einem Zweig liegen. Er faellt sonst erst beim Merge auf.
echo
treffer="$(git log --all --oneline --grep='graph sync' 2>/dev/null || true)"
if [ -z "$treffer" ]; then
  echo "OK — kein 'graph sync'-Commit in der Historie."
  exit 0
fi

echo "ACHTUNG — 'graph sync'-Commits gefunden:"
printf '%s\n' "$treffer" | while read -r sha _; do
  # Ein leerender Commit hat einen fast leeren Verzeichnisbaum. Die Zahl der
  # Dateien ist das ehrlichere Mass als die Zeilenzahl im Diff.
  anz="$(git ls-tree -r "$sha" --name-only | wc -l)"
  zweige="$(git branch -a --contains "$sha" 2>/dev/null | tr -d ' *' | paste -sd, -)"
  if [ "$anz" -lt 50 ]; then
    echo "  $sha LEERT DEN BAUM ($anz Dateien) — in: ${zweige:-?}"
    echo "     Reparatur: git bundle create /tmp/sicherung.bundle <zweig>"
    echo "                git reset --mixed $sha^     (NICHT --hard)"
    echo "                git push --force-with-lease"
  else
    echo "  $sha unauffaellig ($anz Dateien) — in: ${zweige:-?}"
  fi
done
exit 1
