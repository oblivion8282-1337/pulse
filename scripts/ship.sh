#!/usr/bin/env bash
# Landet den aktuellen Feature-Branch atomar + sicher auf main — über GitHub-PR.
#
# Warum nicht lokal `git merge`: Wenn main zwischenzeitlich gewandert ist (anderer
# Rechner hat gepusht), bricht ein Fast-Forward-Merge um, und ein ungeschützter
# Cleanup verwaist den Branch. Der PR-Flow rebased server-seitig auf main, wartet
# auf die Pflicht-Checks (mergt nie was Rotes) und löscht den Branch erst NACH
# erfolgreichem Merge.
#
# Voraussetzung (einmalig, schon gesetzt): Repo hat allow_auto_merge=true +
# delete_branch_on_merge=true. Merge nach main = Prod-Deploy → nur mit Freigabe.
set -euo pipefail

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" = "main" ]; then
  echo "Du bist auf main — es gibt keinen Feature-Branch zum Landen." >&2
  exit 1
fi

# ── Lokales Test-Gate (ersetzt den entfernten CI-Pflicht-Check) ─────────────
# Seit 2026-07-15 sind backend/frontend KEINE GitHub-Pflicht-Checks mehr → das
# verbindliche Test-Gate läuft HIER, lokal, BEVOR gepusht wird: rot = kein Push.
# Reine Doku-Änderungen (**.md / docs/ / .claude/) überspringen es (wie ci.yml).
# Notausgang für echte Ausnahmen: SKIP_TESTS=1 bash scripts/ship.sh
git fetch -q origin main 2>/dev/null || true
mergebase="$(git merge-base origin/main HEAD 2>/dev/null || true)"
changed="$(git diff --name-only "${mergebase:-HEAD~1}"..HEAD 2>/dev/null || true)"
code_changed=false
if [ -z "$changed" ]; then
  code_changed=true   # Änderungen nicht bestimmbar → sicherheitshalber testen
else
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    case "$f" in
      *.md | docs/* | .claude/*) : ;;   # inert → ignorieren
      *) code_changed=true ;;
    esac
  done <<< "$changed"
fi

if [ "${SKIP_TESTS:-}" = "1" ]; then
  echo "⚠  SKIP_TESTS=1 — Test-Gate übersprungen (auf eigene Verantwortung)."
elif [ "$code_changed" != true ]; then
  echo "→ Nur Doku/Config geändert — Test-Gate übersprungen."
else
  echo "→ Code-Änderung erkannt → lokales Test-Gate läuft (ersetzt den CI-Pflicht-Check)…"
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
  echo "  Backend-Tests (~4 min)…"
  # 127.0.0.1 statt localhost: unter Windows stallt localhost ~2 s pro neuer
  # Redis-Verbindung (IPv6-::1-Fallback) → Suite kriecht. IPv4 ist sofort; auf
  # Linux/CI ohnehin identisch.
  REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 \
    uv run --all-packages pytest -q --reruns 2 --only-rerun AssertionError --only-rerun RuntimeError \
    || { echo "✗ Backend-Tests ROT — Push abgebrochen. Erst grün ziehen." >&2; exit 1; }
  echo "  Frontend check + build…"
  ( cd web && pnpm check && pnpm build ) \
    || { echo "✗ Frontend check/build ROT — Push abgebrochen." >&2; exit 1; }
  # Node-Unit-Tests von web/ und desktop/ (zusammen <1 s). Sie liefen bis zum
  # 2026-08-17 in KEINEM Gate — weder hier noch in einem Workflow —, also nur,
  # wenn jemand von Hand daran dachte. Ein Test, den niemand ausführt, ist kein
  # Test; und ausgerechnet an dieser Grenze (Renderer gegen Sidecar/Player) ist
  # am selben Tag ein echter Fehler durchgerutscht.
  echo "  Node-Unit-Tests (web + desktop)…"
  ( cd web && pnpm test:unit ) \
    || { echo "✗ web-Unit-Tests ROT — Push abgebrochen." >&2; exit 1; }
  ( cd desktop && pnpm test:unit ) \
    || { echo "✗ desktop-Unit-Tests ROT — Push abgebrochen." >&2; exit 1; }

  # Die gemeinsamen Kisten (`streaming/pulse-*`) liefen in KEINEM Gate — weder
  # hier noch in ci.yml —, und `cargo test` in einem Programm führt die Tests
  # seiner Pfad-Abhängigkeiten nicht mit. Seit 2026-08-22 trägt
  # pulse-fernsteuerung die Sitzungs-Zustandsmaschine der Fernsteuerung; ihre
  # Tests sind die schärfsten im Repo und liefen bis dahin nirgends.
  #
  # Ohne FFmpeg-Schranke, weil diese Kisten abhängigkeitsfrei sind und in
  # Sekunden bauen. Zwei Ausnahmen: pulse-player trägt denselben Namensstamm
  # (`streaming/pulse-*`), hängt aber an der gepinnten FFmpeg und wird weiter
  # unten mit FFMPEG_DIR/LD_LIBRARY_PATH getestet — hier ausdrücklich
  # ausgenommen, sonst liefe es hier ein zweites Mal, diesmal ohne die
  # nötige Umgebung, und bräche den Bau eines unveränderten Crates. Und
  # pulse-whip: die zieht webrtc, tokio und anyhow (214 Kisten im
  # Abhängigkeitsbaum gegen 1 bei pulse-fernsteuerung), ist also weder
  # abhängigkeitsfrei noch schnell — und ihr `cargo test` löste webrtc von
  # crates.io auf, nicht über den gepatchten Zweig, den Player und die
  # Sidecars tatsächlich ausliefern; das Gate prüfte damit eine andere
  # Abhängigkeit als die ausgelieferte. pulse-whip bleibt deshalb aussen vor
  # und läuft weiterhin in KEINEM Gate — eine offene Rechnung, kein Versehen.
  for kiste in $(echo "$changed" | sed -n 's|^\(streaming/pulse-[a-z-]*\)/.*|\1|p' | sort -u); do
    [ "$kiste" = "streaming/pulse-player" ] && continue
    [ "$kiste" = "streaming/pulse-whip" ] && continue
    [ -f "$kiste/Cargo.toml" ] || continue
    # `${kiste}` mit Klammern, und das ist kein Schoenheitsfehler: macOS
    # liefert bis heute bash 3.2 aus, und die zaehlt das erste Byte des
    # folgenden UTF-8-Zeichens zum Variablennamen. `$kiste…` wird dort zu
    # `kiste\xe2` und stirbt unter `set -u` mit „unbound variable" — mitten im
    # Test-Gate, also genau dann, wenn jemand landen will.
    echo "  Cargo-Tests ${kiste}…"
    ( cd "$kiste" && cargo test -q ) \
      || { echo "✗ Cargo-Tests $kiste ROT — Push abgebrochen." >&2; exit 1; }
  done

  # Cargo-Tests der beiden Crates, die auf Linux WIRKLICH bauen: pulse-player
  # (415 Tests) und linux-hq-sidecar (101). Sie liefen bis zum 2026-08-19 in
  # keinem Gate — mit demselben Ergebnis wie bei den Node-Unit-Tests davor: im
  # Player lag ein roter Test monatelang unbemerkt, und ein roter Test meldet
  # keine Regression mehr. win-hq-sidecar bleibt draussen, das baut auf Linux
  # nicht; die mac-Kisten laufen weiter unten, aber nur auf macOS.
  #
  # Nur bei Änderung am jeweiligen Crate — ein Kaltbau kostet Minuten, und die
  # allermeisten Pushes fassen kein Rust an.
  #
  # **Warum FFMPEG_DIR und LD_LIBRARY_PATH:** beide Crates hängen an der
  # gepinnten FFmpeg n8.1. Ohne FFMPEG_DIR zieht `ffmpeg-next` die zu neue
  # System-FFmpeg und bricht an nicht abgedeckten Enum-Werten ab; ohne
  # LD_LIBRARY_PATH übersetzt es zwar, aber die Testbinaries finden
  # libavcodec.so.62 nicht und sterben mit Exit 127. Beides sieht wie ein
  # kaputter Test aus und ist keiner.
  ffmpeg_prefix="${PULSE_FFMPEG_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/pulse/ffmpeg/prefix}"
  # **Auf dem Mac liegt FFmpeg woanders**, und das ist im CLAUDE.md so
  # beschrieben: der Player baut dort über `PKG_CONFIG_PATH` auf
  # `~/src/ffmpeg-openssl`, nicht über den gepinnten Linux-Vorrat. Ohne diesen
  # Zweig meldete das Gate am 2026-08-23 „FFmpeg fehlt — Cargo-Tests
  # ÜBERSPRUNGEN" und liess die 385 Player-Tests aus, obwohl der Player auf
  # diesem Zweig geänderten Code trug und über den Windows-Installer und das
  # DMG ausgeliefert wird. Dieselbe Linux-Annahme wie bei den Sidecars eine
  # Ebene höher, nur leiser: sie warnt wenigstens, statt zu schweigen.
  mac_pkgconfig=""
  if [ ! -d "$ffmpeg_prefix/lib" ] && [ "$(uname -s)" = "Darwin" ]; then
    for kandidat in "${PULSE_FFMPEG_PKGCONFIG:-}" "$HOME/src/ffmpeg-openssl/lib/pkgconfig"; do
      [ -n "$kandidat" ] && [ -d "$kandidat" ] && { mac_pkgconfig="$kandidat"; break; }
    done
  fi
  rust_crates=""
  echo "$changed" | grep -q '^streaming/pulse-player/' && rust_crates="$rust_crates streaming/pulse-player"
  echo "$changed" | grep -q '^streaming/linux-hq-sidecar/' && rust_crates="$rust_crates streaming/linux-hq-sidecar"
  if [ -n "$rust_crates" ]; then
    if [ -n "$mac_pkgconfig" ]; then
      for crate in $rust_crates; do
        # Klammern aus demselben Grund wie oben (bash 3.2 auf macOS).
        echo "  Cargo-Tests ${crate} (macOS-FFmpeg)…"
        ( cd "$crate" && PKG_CONFIG_PATH="$mac_pkgconfig" cargo test -q ) \
          || { echo "✗ Cargo-Tests $crate ROT — Push abgebrochen." >&2; exit 1; }
      done
    elif [ ! -d "$ffmpeg_prefix/lib" ]; then
      echo "⚠  Rust-Crates geändert, aber die gepinnte FFmpeg fehlt ($ffmpeg_prefix)." >&2
      echo "   Cargo-Tests ÜBERSPRUNGEN — sie laufen also nicht. Bau sie mit" >&2
      echo "   scripts/hq-bauen.sh, oder setze PULSE_FFMPEG_DIR auf einen eigenen Bau." >&2
    else
      for crate in $rust_crates; do
        # Klammern aus demselben Grund wie oben (bash 3.2 auf macOS).
        echo "  Cargo-Tests ${crate}…"
        ( cd "$crate" && FFMPEG_DIR="$ffmpeg_prefix" LD_LIBRARY_PATH="$ffmpeg_prefix/lib" cargo test -q ) \
          || { echo "✗ Cargo-Tests $crate ROT — Push abgebrochen." >&2; exit 1; }
      done
    fi
  fi
  # --- Die macOS-Kisten, und nur auf macOS ---
  #
  # **Hier stand bis zum 2026-08-23 nichts**, mit der Begründung „die bauen
  # hier nicht (Windows-/macOS-Bibliotheken)". Für Windows stimmt das; für den
  # mac-Sidecar war es eine Linux-Annahme, die auf einem Mac schlicht falsch
  # ist — dort baut er in unter einer Sekunde. Ergebnis: 134 Tests des
  # mac-Sidecars und 43 des mac-Labors liefen in KEINEM Gate, weder lokal noch
  # in `mac-build.yml` (das nur `cargo build --release` fährt). Sie liefen,
  # wenn jemand daran dachte.
  #
  # Genau das Muster, das dieses Projekt schon zweimal bezahlt hat: ein nicht
  # ausgeführter Test sieht in der Ausgabe genauso aus wie ein grüner.
  #
  # Auf Linux wird gesagt, dass NICHT geprüft wurde — Schweigen läse sich wie
  # „geprüft".
  mac_crates=""
  echo "$changed" | grep -q '^streaming/mac-hq-sidecar/' && mac_crates="$mac_crates streaming/mac-hq-sidecar"
  echo "$changed" | grep -q '^streaming/mac-hq-labor/' && mac_crates="$mac_crates streaming/mac-hq-labor"
  if [ -n "$mac_crates" ]; then
    if [ "$(uname -s)" = "Darwin" ]; then
      for crate in $mac_crates; do
        # Klammern aus demselben Grund wie oben (bash 3.2 auf macOS).
        echo "  Cargo-Tests ${crate}…"
        ( cd "$crate" && cargo test -q ) \
          || { echo "✗ Cargo-Tests $crate ROT — Push abgebrochen." >&2; exit 1; }
      done
    else
      echo "⚠  macOS-Kisten geändert ($mac_crates), aber diese Maschine ist kein Mac." >&2
      echo "   Ihre Tests laufen hier NICHT — vor dem Landen auf einem Mac nachfahren." >&2
    fi
  fi

  echo "✓ Test-Gate grün."
fi
echo

# Branch sicher auf dem Remote haben.
git push -u origin "$branch"
head_sha="$(git rev-parse HEAD)"

# PR anlegen, falls für diesen Branch keiner OFFEN ist.
#
# Warum nicht `gh pr view "$branch"`: das findet auch längst GEMERGTE PRs
# desselben Branch-Namens. Wird ein Themen-Branch ein zweites Mal verwendet —
# hier der Normalfall, dieselbe Sache läuft über mehrere Runden —, sah das
# Skript den alten PR, legte keinen neuen an, und `gh pr merge` lief danach
# gegen den bereits gemergten. Das gibt keinen Fehler: die Erfolgsmeldung kam,
# der Branch lag aber unangetastet auf dem Server. Am 2026-08-06 genau so
# passiert (alter PR #270 statt eines neuen), und ohne Nachsehen hätte es
# ausgesehen wie gelandet.
pr="$(gh pr list --head "$branch" --state open --json number --jq '.[0].number // empty')"
if [ -z "$pr" ]; then
  gh pr create --base main --head "$branch" --fill >/dev/null
  pr="$(gh pr list --head "$branch" --state open --json number --jq '.[0].number // empty')"
fi
if [ -z "$pr" ]; then
  echo "✗ Kein offener PR für '$branch' — Anlegen fehlgeschlagen." >&2
  exit 1
fi

# Zeigt der PR auf den Stand, den das Test-Gate gerade geprüft hat? Sonst würde
# etwas anderes gemergt als das, was hier grün war (z.B. nach einem halb
# durchgelaufenen Push).
pr_sha="$(gh pr view "$pr" --json headRefOid --jq .headRefOid)"
if [ "$pr_sha" != "$head_sha" ]; then
  echo "✗ PR #$pr zeigt auf ${pr_sha:0:8}, lokal ist ${head_sha:0:8} — Push unvollständig?" >&2
  exit 1
fi

# Rebase-Merge, Branch-Delete nach Erfolg, Auto-Merge sobald die Checks grün sind.
# Über die NUMMER statt über den Branch-Namen — die ist eindeutig.
gh pr merge "$pr" --rebase --delete-branch --auto

# Nachprüfen statt behaupten: ohne das war die Erfolgsmeldung oben eine reine
# Vermutung, und genau daran ist es einmal vorbeigelaufen.
if [ "$(gh pr view "$pr" --json autoMergeRequest --jq '.autoMergeRequest != null')" != "true" ]; then
  echo "✗ Auto-Merge wurde für PR #$pr NICHT gesetzt — bitte von Hand prüfen." >&2
  exit 1
fi

echo
echo "✓ PR #$pr auf Auto-Merge gesetzt — landet auf main, sobald die Pflicht-Checks grün sind."
echo "  Status:  gh pr checks $pr --watch"
