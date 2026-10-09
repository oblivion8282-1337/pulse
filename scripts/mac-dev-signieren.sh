#!/usr/bin/env bash
# Dev-Signatur für macOS: Electron und den HQ-Sidecar mit einer STABILEN
# Identität signieren, damit die Bildschirmaufnahme-Erlaubnis hält.
#
# ── Das Problem, das es löst ─────────────────────────────────────────────────
# Im Dev-Betrieb sind beide Binärdateien nur **adhoc** signiert
# (`Signature=adhoc`, `TeamIdentifier=not set`). macOS kann eine
# TCC-Erlaubnis dann an keine Identität binden und bindet sie an den
# INHALTS-HASH. Folge: die Erlaubnis sieht erteilt aus, und das System beendet
# die Aufnahme trotzdem — Sekunden nach dem Start, mitten im Betrieb, oder
# nach dem nächsten `cargo build`. Im Sidecar-Log steht dann:
#
#   [capture] Bild-Aufnahme von macOS beendet: Stream wurde vom System gestoppt
#
# Das sieht wie ein Fehler in Pulse aus und ist keiner. Am 2026-10-08 hat es
# eine Sitzung lang Fehlersuche gekostet, am 2026-10-09 wieder.
#
# ── Warum ein Skript und kein Handgriff ──────────────────────────────────────
# Der Sidecar wird bei jedem `cargo build --release` neu geschrieben und ist
# danach wieder adhoc. Eine Anleitung im Kopf vergisst man; ein Skript nicht.
# Nach jedem Sidecar-Bau also erneut laufen lassen.
#
# ── Was es NICHT ist ─────────────────────────────────────────────────────────
# Keine Auslieferungs-Signatur. `electron-builder` signiert und notarisiert den
# Release-Bau selbst (`mac-build.yml`); hier geht es allein um das
# `node_modules`-Electron und das Cargo-Zielverzeichnis auf DIESER Maschine.
# Beides wird bei einem `pnpm install` bzw. `cargo clean` wieder adhoc.
set -euo pipefail
cd "$(dirname "$0")/.."

ELECTRON="node_modules/.pnpm/electron@43.0.0/node_modules/electron/dist/Electron.app"
SIDECAR="streaming/mac-hq-sidecar/target/release/pulse-mac-hq-sidecar"
BUNDLE_ID="com.github.Electron"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Nur für macOS." >&2
  exit 1
fi

# ── Welche Identität, und warum NICHT die „bessere" ──────────────────────────
# Gebraucht wird hier nur eines: eine STABILE Identität, damit TCC die
# Erlaubnis an sie binden kann statt an einen Inhalts-Hash. Das leistet
# „Apple Development" genauso wie „Developer ID Application".
#
# Bevorzugt wird deshalb bewusst die Identität aus dem ANMELDE-Schlüsselbund.
# Grund (gefunden am 2026-10-09): auf dieser Maschine liegt das
# Developer-ID-Zertifikat in einem eigenen `pulse-build.keychain-db`, der im
# Suchpfad VOR dem Anmelde-Schlüsselbund steht, gesperrt ist und ein eigenes
# Passwort hat — nicht das Anmeldepasswort. Ein Skript, das „Developer ID"
# bevorzugt, greift dorthin und scheitert mit `errSecInternalComponent`; das
# sieht nach einem Zertifikatsproblem aus und ist ein Schlüsselbund-Problem.
#
# „Developer ID" gehört zur AUSLIEFERUNG, und die macht `electron-builder` in
# `mac-build.yml` — nicht dieses Skript. Überschreibbar mit
# PULSE_SIGN_IDENTITY, wenn man es doch will (dann muss der Schlüsselbund mit
# dem Zertifikat entsperrt sein).
LOGIN_KC="$HOME/Library/Keychains/login.keychain-db"
ID="${PULSE_SIGN_IDENTITY:-}"
if [ -z "$ID" ]; then
  ID=$(security find-identity -v -p codesigning "$LOGIN_KC" 2>/dev/null |
    sed -n 's/.*"\([^"]*\)".*/\1/p' | head -1 || true)
fi
if [ -z "$ID" ]; then
  echo "✗ Keine Signatur-Identität im Anmelde-Schlüsselbund gefunden." >&2
  echo "  Nachsehen: security find-identity -v -p codesigning \"$LOGIN_KC\"" >&2
  echo "  Oder eine andere vorgeben: PULSE_SIGN_IDENTITY=\"…\" $0" >&2
  exit 1
fi
echo "Identität: $ID"
echo "  (aus dem Anmelde-Schlüsselbund — Begründung im Skriptkopf)"

zeichne() {
  local ziel="$1"
  [ -e "$ziel" ] || { echo "  ⚠ fehlt, übersprungen: $ziel"; return 0; }
  # `--deep` ist für Auslieferungs-Signaturen abgeraten (es übergeht die
  # Entitlements der Unter-Bundles). Hier ist es richtig: ein Dev-Electron hat
  # keine eigenen Entitlements, und die Alternative wäre, Apples
  # Helper-Struktur von Hand nachzubauen — mehr Stellen, die bei jedem
  # Electron-Update brechen.
  codesign --force --deep --sign "$ID" --timestamp=none "$ziel" >/dev/null 2>&1 ||
    codesign --force --deep --sign "$ID" "$ziel"
  echo "  ✓ $ziel"
}

echo "── Signieren ──"
zeichne "$SIDECAR"
zeichne "$ELECTRON"

echo "── Prüfen ──"
for ziel in "$SIDECAR" "$ELECTRON"; do
  [ -e "$ziel" ] || continue
  printf '  %-72s ' "$(basename "$ziel")"
  codesign -dv --verbose=2 "$ziel" 2>&1 | grep -q "TeamIdentifier=not set" &&
    echo "✗ weiter ohne Team" || echo "✓ Team gesetzt"
done

cat <<HINWEIS

── Noch EIN Handgriff, und zwar von Hand ───────────────────────────────────
Die Signatur ist eine neue Identität. Die alte Erlaubnis gilt dafür nicht, und
macOS fragt nicht von selbst neu — die App glaubt, sie hätte sie.

  1) tccutil reset ScreenCapture $BUNDLE_ID
  2) Dev-App neu starten (pnpm dev:remote)
  3) Beim ersten Übertragen die Bildschirmaufnahme erlauben

Hält es danach, war es die Signatur. Hält es NICHT, steht die Ursache woanders
und das Sidecar-Log sagt es (Suche nach „vom System gestoppt").
HINWEIS
