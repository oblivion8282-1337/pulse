#!/usr/bin/env bash
# Überträgt `infra/prod/` auf den Produktivserver — ohne die Dateien zu
# löschen, die dort NUR dort existieren.
#
# **Warum es dieses Skript gibt.** Am 2026-08-07 wurde von Hand
# `rsync -az --delete infra/prod/ → Server` ausgeführt. `.env`, `secrets/`
# und `certs/` sind gitignored, lagen also nicht in der Quelle — `--delete`
# hat sie auf dem Server als „überzählig" entfernt. Die Container liefen
# weiter (sie hatten alles im Speicher), aber der private JWT-Schlüssel war
# unrettbar weg: kein Snapshot, kein Backup, keine Kopie. Alle Sitzungen und
# alle Geräte-Zertifikate mussten neu ausgestellt werden.
#
# Zwei Dinge hätten es verhindert, und beide stecken jetzt hier drin: eine
# Ausschlussliste und ein Trockenlauf, den man BESTÄTIGEN muss. Der Trockenlauf
# war damals sogar da — nur danach ausgeführt.
#
#   bash scripts/deploy-infra.sh              # fragt vor dem Übertragen
#   bash scripts/deploy-infra.sh --ja         # ohne Rückfrage (für Automatik)
#   bash scripts/deploy-infra.sh --nur-pruefen
#
# Danach greift die Änderung erst mit `docker compose up -d` auf dem Server;
# das macht dieses Skript bewusst NICHT — ein Neustart der Produktion ist eine
# eigene Entscheidung.

set -euo pipefail

ZIEL="${PULSE_DEPLOY_ZIEL:-michael@159.195.150.54}"
PFAD="${PULSE_DEPLOY_PFAD:-~/pulse/infra/}"
QUELLE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/infra/"

# Was auf dem Server lebt und NIE aus dem Repo überschrieben oder gelöscht
# werden darf. Jeder Eintrag hat einen Grund — beim Erweitern bitte einen
# dazuschreiben, sonst weiß der Nächste nicht, ob er ihn streichen darf.
AUSNAHMEN=(
  ".env"          # Zugangsdaten, nur auf dem Server
  "secrets/"      # JWT-Schlüsselpaar — das hier verloren zu geben kostet
                  # jedem Nutzer seine Sitzung und jedem Gerät sein Zertifikat
  "certs/"        # MediaMTX-TLS, self-signed auf dem Host erzeugt
  "*.log"         # Laufzeitprotokolle
  "pulse-update.log"
)

ausschluss_argumente=()
for a in "${AUSNAHMEN[@]}"; do ausschluss_argumente+=(--exclude "$a"); done

nur_pruefen=false
ohne_rueckfrage=false
for arg in "$@"; do
  case "$arg" in
    --nur-pruefen) nur_pruefen=true ;;
    --ja)          ohne_rueckfrage=true ;;
    *) echo "unbekannte Option: $arg" >&2; exit 64 ;;
  esac
done

echo "Ziel:   $ZIEL:$PFAD"
echo "Quelle: $QUELLE"
echo "Ausgenommen: ${AUSNAHMEN[*]}"
echo

# ── Trockenlauf ZUERST. Das ist der ganze Punkt. ───────────────────────────
echo "→ Trockenlauf (es wird noch nichts verändert):"
ausgabe="$(rsync -az --delete --dry-run --itemize-changes \
  "${ausschluss_argumente[@]}" "$QUELLE" "$ZIEL:$PFAD" 2>&1)"

# `*deleting` ist die Zeile, die 2026-08-07 niemand gesehen hat.
loeschungen="$(printf '%s\n' "$ausgabe" | grep -c '^\*deleting' || true)"
printf '%s\n' "$ausgabe" | sed 's/^/    /' | head -40
echo
echo "→ $loeschungen Löschung(en), $(printf '%s\n' "$ausgabe" | grep -c '^[<>]' || true) Übertragung(en)"

if [ "$loeschungen" -gt 0 ]; then
  echo
  echo "  ACHTUNG: Es würden Dateien auf dem SERVER gelöscht (Zeilen mit *deleting)."
  echo "  Prüfe jede einzeln. Steht dort etwas, das es nur auf dem Server gibt,"
  echo "  gehört es in die Ausnahmeliste in diesem Skript — NICHT durchgewinkt."
fi

$nur_pruefen && { echo; echo "(--nur-pruefen: hier ist Schluss)"; exit 0; }

if ! $ohne_rueckfrage; then
  echo
  read -r -p "Übertragen? [tippe genau: ja] " antwort
  [ "$antwort" = "ja" ] || { echo "abgebrochen."; exit 1; }
fi

echo
echo "→ Übertrage …"
rsync -az --delete "${ausschluss_argumente[@]}" "$QUELLE" "$ZIEL:$PFAD"

echo
echo "✓ Übertragen. Die Ausnahmen sind unangetastet geblieben:"
ssh -o BatchMode=yes "$ZIEL" "ls -la ~/pulse/infra/prod/.env ~/pulse/infra/prod/secrets/ 2>&1 | head -8" || true

echo
echo "Wirksam wird es erst mit einem Neustart auf dem Server:"
echo "    ssh $ZIEL 'cd ~/pulse/infra/prod && docker compose up -d'"
echo "Das ist bewusst NICHT Teil dieses Skripts."
