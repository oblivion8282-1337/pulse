#!/usr/bin/env bash
# Das verbindliche Test-Gate — herausgelöst aus ship.sh, damit es auch MITTEN
# in der Arbeit läuft und sein Ergebnis für das spätere Landen zählt.
#
# Warum es das als eigenes Skript gibt
# ------------------------------------
# Das Gate lief bisher ausschliesslich in ship.sh, also erst beim Landen. Wer
# während der Arbeit pytest von Hand fuhr, fuhr es beim Landen ein zweites Mal
# — am 2026-08-26 waren das sieben Minuten für einen Stand, dessen Backend seit
# dem ersten Lauf keine Zeile geändert hatte.
#
# Zwei Mechaniken sparen das ein, beide exakt statt heuristisch:
#
#   1. **Stempel.** Ein grüner Lauf schreibt den Baum-Hash der geprüften
#      Bereiche nach `.git/`. Ist der Hash beim nächsten Lauf identisch, ist
#      derselbe Inhalt schon bewiesen. Nur DIESES Skript stempelt, und nur nach
#      echtem Grün — ein von Hand gesetzter Stempel wäre genau die Behauptung,
#      gegen die das Gate gebaut ist.
#
#   2. **Vergleich mit origin/main.** Git kennt Teilbaum-Hashes: ist der Hash
#      von `services/` + `shared/` + `uv.lock` derselbe wie auf origin/main,
#      hat dieser Zweig das Backend NACHWEISLICH nicht angefasst. Kein Raten
#      über Dateinamen-Muster, sondern der Inhalt selbst.
#
# Der Preis von (2), ausdrücklich: ist origin/main selbst rot, fällt das beim
# Landen einer reinen Frontend-Änderung nicht mehr auf. Das ist fremde
# Breakage, für die dieses Gate nie zuständig war — es sichert die eigene
# Änderung ab. Wer den vollen Lauf erzwingen will: `PULSE_GATE_VOLL=1`.
#
# Aufruf:
#   bash scripts/gate.sh              # prüfen, bei Grün stempeln
#   bash scripts/gate.sh --trocken    # nur sagen, was liefe und warum
#   bash scripts/gate.sh --maschine   # Voraussetzungen dieser Maschine prüfen
#   PULSE_GATE_VOLL=1 bash scripts/gate.sh   # nichts überspringen
#   PULSE_GATE_JOBS=1 bash scripts/gate.sh   # seriell (kein redis-server nötig)
set -euo pipefail

# ── Voraussetzungen dieser Maschine ─────────────────────────────────────────
# Das Gate reist über das Repo mit, die Werkzeuge nicht. Ohne diesen Modus
# merkt eine frisch aufgesetzte Maschine erst beim ersten Landen, dass ihr
# etwas fehlt — und dann mitten in einem Lauf, den sie eigentlich abschliessen
# wollte.
if [ "${1:-}" = "--maschine" ]; then
  fehlt=0
  pruefe() {  # pruefe <name> <pflicht|optional> <wofuer>
    if command -v "$1" >/dev/null 2>&1; then
      printf '  ✓ %-14s %s\n' "$1" "$3"
    elif [ "$2" = pflicht ]; then
      printf '  ✗ %-14s FEHLT — %s\n' "$1" "$3"; fehlt=1
    else
      printf '  ○ %-14s fehlt (optional) — %s\n' "$1" "$3"
    fi
  }
  echo "Werkzeuge:"
  pruefe git    pflicht  "Baum-Hashes, Vergleich mit origin/main"
  pruefe uv     pflicht  "Backend-Tests"
  pruefe pnpm   pflicht  "Frontend-Prüfungen"
  pruefe docker pflicht  "Test-Infra (Redis/Postgres)"
  pruefe redis-server optional "eigener Redis je Worker im Parallellauf"
  pruefe cargo  optional "Rust-Kisten (nur bei Änderung daran)"
  # wasm-pack liegt unter ~/.cargo/bin, das nicht in jedem PATH steht — dieselbe
  # Erweiterung wie in gate-rust.sh/bauen-wasm.sh, sonst meldet diese Prüfung
  # "fehlt" auf einer Maschine, auf der es installiert ist.
  if PATH="$HOME/.cargo/bin:$PATH" command -v wasm-pack >/dev/null 2>&1; then
    printf '  ✓ %-14s %s\n' "wasm-pack" "WASM-Bau des Krypto-Kerns (krypto/pulse-krypto)"
  else
    printf '  ○ %-14s fehlt (optional) — %s\n' "wasm-pack" "WASM-Bau des Krypto-Kerns (krypto/pulse-krypto)"
  fi
  if PATH="$HOME/.cargo/bin:$PATH" rustup target list --installed 2>/dev/null \
      | grep -qx wasm32-unknown-unknown; then
    printf '  ✓ %-14s %s\n' "wasm32-target" "Compile-Ziel für den Krypto-Kern"
  else
    printf '  ○ %-14s fehlt (optional) — %s\n' "wasm32-target" "Compile-Ziel für den Krypto-Kern"
  fi
  if ! PATH="$HOME/.cargo/bin:$PATH" command -v wasm-pack >/dev/null 2>&1 \
      || ! PATH="$HOME/.cargo/bin:$PATH" rustup target list --installed 2>/dev/null \
          | grep -qx wasm32-unknown-unknown; then
    echo "     → ohne beides überspringt gate-rust.sh den WASM-Bau still, und"
    echo "       die drei WASM-Grenz-Tests in \`pnpm test:unit\` laufen dann nicht:"
    echo "       cargo install wasm-pack && rustup target add wasm32-unknown-unknown"
  fi
  if ! command -v redis-server >/dev/null 2>&1; then
    echo "     → ohne redis-server läuft das Gate SERIELL (~6x langsamer):"
    case "$(uname -s)" in
      Darwin) echo "       brew install redis" ;;
      Linux)  echo "       sudo pacman -S redis   /   sudo apt install redis-server" ;;
      *)      echo "       (Binary redis-server im PATH nötig; unter Windows: WSL)" ;;
    esac
    echo "       Der Dienst muss NICHT laufen — die Tests starten eigene Prozesse."
    echo "       (Grund: Redis-Pubsub ist server-global; eine eigene DB je"
    echo "        Worker reicht NICHT, s. Wurzel-conftest.py)"
  fi
  echo "Landen (scripts/ship.sh):"
  if [ "$(git config --get pulse.adminmerge || echo false)" = "true" ]; then
    printf '  ✓ %-14s %s\n' "adminmerge" "Admin-Merge aktiv — PRs landen ohne Fremd-Review"
  else
    printf '  ○ %-14s %s\n' "adminmerge" "aus: main verlangt einen Review, den eigenen PR kann"
    echo "                    man nicht selbst genehmigen → ship.sh bliebe auf BLOCKED."
    echo "                    Als Eigentümer: git config --local pulse.adminmerge true"
  fi
  echo "Git-Identität (sonst blockt der CLA-Bot jeden PR):"
  mail="$(git config user.email || true)"
  erwartet="249562202+oblivion8282-1337@users.noreply.github.com"
  if [ "$mail" = "$erwartet" ]; then
    printf '  ✓ user.email    %s\n' "$mail"
  else
    printf '  ✗ user.email    ist "%s", erwartet "%s"\n' "${mail:-<leer>}" "$erwartet"; fehlt=1
  fi
  echo "Cargo-Tests brauchen zusätzlich die gepinnte FFmpeg:"
  ffm=""
  for k in "${PULSE_FFMPEG_DIR:-}" \
           "${XDG_CACHE_HOME:-$HOME/.cache}/pulse/ffmpeg/prefix" \
           "$(git rev-parse --show-toplevel)/streaming/pulse-player/ffmpeg-dist/n8.1-lgpl-shared"; do
    [ -n "$k" ] && [ -d "$k/lib" ] && { ffm="$k"; break; }
  done
  if [ -n "$ffm" ]; then
    printf '  ✓ FFmpeg        %s\n' "$ffm"
  elif [ "$(uname -s)" = "Darwin" ] && [ -d "$HOME/src/ffmpeg-openssl/lib/pkgconfig" ]; then
    printf '  ✓ FFmpeg        macOS-Pfad ~/src/ffmpeg-openssl\n'
  else
    printf '  ○ FFmpeg        fehlt — Cargo-Tests werden übersprungen (scripts/hq-bauen.sh)\n'
  fi
  [ "$fehlt" = 0 ] && echo "✓ Diese Maschine kann das Gate fahren." || {
    echo "✗ Es fehlt etwas Pflichtiges (s. oben)." >&2; exit 1; }
  exit 0
fi

trocken=false
[ "${1:-}" = "--trocken" ] && trocken=true

gitdir="$(git rev-parse --git-dir)"
stempel="$gitdir/.pulse-gate-stamp"

# ── Baum-Hashes je Bereich ──────────────────────────────────────────────────
# Der Baum kommt aus einem WEGWERF-Index: `git write-tree` verlangt einen Index,
# der zum Arbeitsverzeichnis passt, und der echte Index gehört dem Nutzer — ihn
# hier zu verändern wäre ein Übergriff (ein halb gestagter Stand wäre danach
# still weg).
wegwerf_index="$(mktemp -u "${TMPDIR:-/tmp}/pulse-gate-index.XXXXXX")"
trap 'rm -f "$wegwerf_index"' EXIT
GIT_INDEX_FILE="$wegwerf_index" git read-tree HEAD
GIT_INDEX_FILE="$wegwerf_index" git add -A
baum="$(GIT_INDEX_FILE="$wegwerf_index" git write-tree)"

# Hash eines Bereichs = Hash über die Teilbaum-/Blob-Hashes seiner Pfade.
# Fehlt ein Pfad, steht `-` dafür — so unterscheidet sich „Datei gelöscht" von
# „Datei unverändert".
bereich_hash() {
  local wurzel="$1"; shift
  local p
  for p in "$@"; do
    git rev-parse "$wurzel:$p" 2>/dev/null || echo "-"
  done | git hash-object --stdin
}

BEREICH_backend="services shared plugins uv.lock pyproject.toml conftest.py"
BEREICH_web="web plugins pnpm-lock.yaml package.json"
BEREICH_desktop="desktop pnpm-lock.yaml package.json"
# Der Auslieferer auf dem VPS läuft per Cron und meldet sich nur, wenn er etwas
# tut — ein Fehler darin sieht aus wie „es passiert nichts". Seine
# Entscheidungslogik hat deshalb einen eigenen Prüfstand.
BEREICH_infra="infra/prod"

haupt_baum=""
git rev-parse -q --verify origin/main >/dev/null 2>&1 &&
  haupt_baum="$(git rev-parse "origin/main^{tree}")"

gestempelt() {  # gestempelt <bereich> → gespeicherter Hash oder leer
  [ -f "$stempel" ] || return 0
  awk -v b="$1" '$1==b {print $2}' "$stempel" | tail -1
}

# Gibt "ja <Grund>" oder "nein <Grund>" aus.
noetig() {
  local bereich="$1"; shift
  local jetzt
  jetzt="$(bereich_hash "$baum" "$@")"
  if [ "${PULSE_GATE_VOLL:-}" = "1" ]; then
    echo "ja (PULSE_GATE_VOLL=1)"; return
  fi
  if [ -n "$haupt_baum" ] && [ "$jetzt" = "$(bereich_hash "$haupt_baum" "$@")" ]; then
    echo "nein (unverändert gegenüber origin/main)"; return
  fi
  if [ "$jetzt" = "$(gestempelt "$bereich")" ]; then
    echo "nein (dieser Stand lief hier schon grün)"; return
  fi
  echo "ja (geändert)"
}

# shellcheck disable=SC2086  # Pfadlisten sollen wortweise zerfallen
backend_grund="$(noetig backend $BEREICH_backend)"
web_grund="$(noetig web $BEREICH_web)"
desktop_grund="$(noetig desktop $BEREICH_desktop)"
# shellcheck disable=SC2086
infra_grund="$(noetig infra $BEREICH_infra)"

echo "→ Test-Gate:"
echo "   Backend  : $backend_grund"
echo "   Web      : $web_grund"
echo "   Desktop  : $desktop_grund"
echo "   Infra    : $infra_grund"

if [ "$trocken" = true ]; then
  exit 0
fi

stempeln() {  # stempeln <bereich> <pfade…> — NUR nach echtem Grün aufrufen
  local bereich="$1"; shift
  local neu
  neu="$(bereich_hash "$baum" "$@")"
  local tmp="$stempel.tmp"
  { [ -f "$stempel" ] && grep -v "^$bereich " "$stempel" || true; } > "$tmp"
  printf '%s %s\n' "$bereich" "$neu" >> "$tmp"
  mv "$tmp" "$stempel"
}

# ── Backend ─────────────────────────────────────────────────────────────────
if [ "${backend_grund#ja}" != "$backend_grund" ]; then
  # Test-Infra sicherstellen: Redis (:6380) muss laufen; best-effort hochfahren.
  if ! (exec 3<>/dev/tcp/127.0.0.1/6380) 2>/dev/null; then
    echo "  Test-Infra (Redis/Postgres) nicht erreichbar — fahre sie hoch…"
    docker compose up -d redis postgres >/dev/null 2>&1 || true
    for _ in $(seq 1 30); do (exec 3<>/dev/tcp/127.0.0.1/6380) 2>/dev/null && break; sleep 1; done
  fi
  if ! (exec 3<>/dev/tcp/127.0.0.1/6380) 2>/dev/null; then
    echo "✗ Test-Infra (Redis :6380) nicht erreichbar. Starte den Dev-Stack: scripts/dev-up.fish" >&2
    exit 1
  fi
  # Parallel, wenn die Maschine es hergibt. Jeder Worker bekommt eine eigene
  # Redis-DB (Wurzel-`conftest.py`) — ohne das sehen sich die Worker über die
  # echten Schluessel und Pubsub-Kanaele gegenseitig, und das sieht aus wie ein
  # flackernder Test. `PULSE_GATE_JOBS=1` schaltet zurueck auf seriell.
  jobs="${PULSE_GATE_JOBS:-$( { nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2; } )}"
  [ "$jobs" -gt 8 ] && jobs=8
  # **Ohne `redis-server` NICHT parallel starten.** Der Wurzel-`conftest.py`
  # ist fail-closed: fehlt das Binary, wirft jeder Worker — das Gate wäre auf
  # so einer Maschine also nicht langsam, sondern ROT, und die Meldung stünde
  # 2308-mal untereinander. Fail-closed ist im conftest richtig (wer `-n`
  # ausdrücklich verlangt, soll keine vermischten Läufe bekommen); WER DEN
  # LAUF AUSWÄHLT, muss aber vorher nachsehen. Hier läuft es seriell weiter,
  # und es steht eine Zeile da, warum.
  if [ "$jobs" -gt 1 ] && ! command -v redis-server >/dev/null 2>&1; then
    echo "  Hinweis: kein redis-server im PATH → serieller Lauf (~6x langsamer)."
    case "$(uname -s)" in
      Darwin) echo "           Für den Parallellauf: brew install redis" ;;
      Linux)  echo "           Für den Parallellauf: sudo pacman -S redis  /  sudo apt install redis-server" ;;
      *)      echo "           Für den Parallellauf wird das Binary redis-server im PATH gebraucht." ;;
    esac
    echo "           (Der Dienst muss NICHT laufen — die Tests starten eigene Prozesse.)"
    jobs=1
  fi
  parallel=""
  [ "$jobs" -gt 1 ] && parallel="-n $jobs"
  echo "  Backend-Tests (${jobs} Prozesse)…"
  # 127.0.0.1 statt localhost: unter Windows stallt localhost ~2 s pro neuer
  # Redis-Verbindung (IPv6-::1-Fallback) → Suite kriecht. IPv4 ist sofort; auf
  # Linux/CI ohnehin identisch.
  # shellcheck disable=SC2086
  REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 \
    uv run --all-packages pytest -q $parallel --reruns 2 --only-rerun AssertionError --only-rerun RuntimeError \
    || { echo "✗ Backend-Tests ROT — abgebrochen. Erst grün ziehen." >&2; exit 1; }
  # shellcheck disable=SC2086
  stempeln backend $BEREICH_backend
fi

# ── Rust ────────────────────────────────────────────────────────────────────
# Die Cargo-Teile hängen an den GEÄNDERTEN Pfaden (nicht an Bereichs-Hashes):
# ein Kaltbau kostet Minuten, und die allermeisten Pushes fassen kein Rust an.
# Basis ist der Vergleich gegen origin/main — inklusive noch nicht committeter
# Arbeit, damit das Gate mitten in der Sitzung dasselbe prüft wie beim Landen.
#
# **Steht VOR dem Web-Teil, und das ist keine Geschmacksfrage:** gate-rust.sh
# baut das WASM-Paket des Krypto-Kerns, und `pnpm test:unit` braucht es. Stünde
# der Rust-Teil wie ursprünglich am Ende, würden die drei WASM-Grenz-Tests im
# ERSTEN Lauf auf einer frischen Maschine übersprungen und erst im zweiten
# greifen — ein Gate, das beim ersten Mal weniger prüft als beim zweiten.
mergebase="$(git merge-base origin/main HEAD 2>/dev/null || true)"
changed="$(git diff --name-only "${mergebase:-HEAD~1}" -- 2>/dev/null || true)"
bash "$(dirname "${BASH_SOURCE[0]}")/gate-rust.sh" "$changed"

# ── Web ─────────────────────────────────────────────────────────────────────
if [ "${web_grund#ja}" != "$web_grund" ]; then
  echo "  Frontend check + build…"
  ( cd web && pnpm check && pnpm build ) \
    || { echo "✗ Frontend check/build ROT — abgebrochen." >&2; exit 1; }
  # Node-Unit-Tests von web/. Sie liefen bis zum 2026-08-17 in KEINEM Gate —
  # ein Test, den niemand ausführt, ist kein Test.
  echo "  Node-Unit-Tests (web)…"
  ( cd web && pnpm test:unit ) \
    || { echo "✗ web-Unit-Tests ROT — abgebrochen." >&2; exit 1; }
  # shellcheck disable=SC2086
  stempeln web $BEREICH_web
fi

# ── Desktop ─────────────────────────────────────────────────────────────────
if [ "${desktop_grund#ja}" != "$desktop_grund" ]; then
  echo "  Node-Unit-Tests (desktop)…"
  ( cd desktop && pnpm test:unit ) \
    || { echo "✗ desktop-Unit-Tests ROT — abgebrochen." >&2; exit 1; }
  # shellcheck disable=SC2086
  stempeln desktop $BEREICH_desktop
fi

# ── Infra (Auslieferer) ─────────────────────────────────────────────────────
if [ "${infra_grund#ja}" != "$infra_grund" ]; then
  echo "  Auslieferer-Fälle (infra/prod)…"
  bash infra/prod/tests/pulse-update-faelle.sh \
    || { echo "✗ pulse-update-Fälle ROT — abgebrochen." >&2; exit 1; }
  # shellcheck disable=SC2086
  stempeln infra $BEREICH_infra
fi

echo "✓ Test-Gate grün."
