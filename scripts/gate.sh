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
#   PULSE_GATE_VOLL=1 bash scripts/gate.sh   # nichts überspringen
set -euo pipefail

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

echo "→ Test-Gate:"
echo "   Backend  : $backend_grund"
echo "   Web      : $web_grund"
echo "   Desktop  : $desktop_grund"

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

# ── Rust ────────────────────────────────────────────────────────────────────
# Die Cargo-Teile hängen an den GEÄNDERTEN Pfaden (nicht an Bereichs-Hashes):
# ein Kaltbau kostet Minuten, und die allermeisten Pushes fassen kein Rust an.
# Basis ist der Vergleich gegen origin/main — inklusive noch nicht committeter
# Arbeit, damit das Gate mitten in der Sitzung dasselbe prüft wie beim Landen.
mergebase="$(git merge-base origin/main HEAD 2>/dev/null || true)"
changed="$(git diff --name-only "${mergebase:-HEAD~1}" -- 2>/dev/null || true)"
bash "$(dirname "${BASH_SOURCE[0]}")/gate-rust.sh" "$changed"

echo "✓ Test-Gate grün."
