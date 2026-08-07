#!/usr/bin/env bash
# Verschlüsselte Notfall-Kopie der Konfiguration auf einen ZWEITEN Rechner.
#
# **Warum es das gibt.** Am 2026-08-07 hat ein `rsync --delete` auf dem
# Produktivserver `.env`, `secrets/` und `certs/` gelöscht. Das restic-Backup
# lief einwandfrei — es sicherte nur Nutzerdaten, keine Konfiguration. Der
# private JWT-Schlüssel war damit endgültig weg: alle Sitzungen und alle
# Geräte-Zertifikate mussten neu ausgestellt werden.
#
# Seither sichert `backup/backup.sh config` die Konfiguration mit. Das hilft
# aber nur, solange der SERVER steht: restic-Repo, Konfiguration und Dienste
# liegen auf derselben Maschine. Fällt sie aus, ist alles gleichzeitig weg.
# Deshalb zusätzlich diese Kopie auf einem zweiten Rechner.
#
# **Verschlüsselt, weil das Ziel ein Testserver ist.** Wer dort Zugriff
# bekommt, hätte sonst den Produktions-Schlüssel. Das Passwort steht in der
# `.env` der PRODUKTION — und gehört zusätzlich in einen Passwortmanager,
# denn genau bei einem Totalverlust der Produktion ist die `.env` nicht mehr da.
#
# Die Richtung ist Absicht: Produktion schiebt zum Testserver, nie umgekehrt.
# Ein Schlüssel vom Testserver in die Produktion wäre der gefährlichere Weg.
#
#   ./notfall-sicherung.sh          # sichern
#   ./notfall-sicherung.sh --liste  # zeigt, was auf dem Ziel liegt

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

ZIEL="${NOTFALL_ZIEL:-michael@77.42.71.166}"
ZIELPFAD="${NOTFALL_ZIELPFAD:-~/pulse-prod-notfall}"
SSH_KEY="${NOTFALL_SSH_KEY:-$HOME/.ssh/id_ed25519_notfall}"
BEHALTEN="${NOTFALL_BEHALTEN:-14}"

# shellcheck disable=SC1091
set -a; . ./.env; set +a
: "${NOTFALL_ARCHIV_PASSWORT:?NOTFALL_ARCHIV_PASSWORT fehlt in .env}"

ssh_ziel() { ssh -i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$ZIEL" "$@"; }

if [ "${1:-}" = "--liste" ]; then
  ssh_ziel "ls -la $ZIELPFAD/ 2>/dev/null" || echo "Zielverzeichnis nicht erreichbar"
  exit 0
fi

STEMPEL="$(date -u +%Y%m%d-%H%M)"
ARCHIV="prod-config-${STEMPEL}.tar.gz.enc"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Nur die drei Dinge, die es NUR hier gibt. Alles andere steht im Git.
tar czf "$TMP/roh.tar.gz" .env secrets certs 2>/dev/null

# PBKDF2 mit hoher Iterationszahl — das Archiv landet auf einer Maschine, die
# wir weniger scharf bewachen als diese hier.
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
  -in "$TMP/roh.tar.gz" -out "$TMP/$ARCHIV" -pass "pass:$NOTFALL_ARCHIV_PASSWORT"

ssh_ziel "mkdir -p $ZIELPFAD && chmod 700 $ZIELPFAD"
scp -q -i "$SSH_KEY" -o BatchMode=yes "$TMP/$ARCHIV" "$ZIEL:$ZIELPFAD/$ARCHIV"
ssh_ziel "chmod 600 $ZIELPFAD/$ARCHIV"

# Rückhol-Probe: ein Archiv, das sich nicht öffnen lässt, ist kein Backup.
# Deshalb wird JEDER Lauf gegengeprüft, nicht nur der erste.
ssh_ziel "cat $ZIELPFAD/$ARCHIV" > "$TMP/probe.enc"
if openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
     -in "$TMP/probe.enc" -out "$TMP/probe.tar.gz" \
     -pass "pass:$NOTFALL_ARCHIV_PASSWORT" 2>/dev/null \
   && tar tzf "$TMP/probe.tar.gz" | grep -q "secrets/jwt_private.pem"; then
  echo "[$(date -u +%FT%TZ)] $ARCHIV gesichert und zurueckgelesen (jwt_private.pem enthalten)"
else
  echo "[$(date -u +%FT%TZ)] FEHLER: $ARCHIV liess sich nicht zurueckholen" >&2
  exit 1
fi

# Alte Stände wegräumen, aber großzügig — sie kosten wenige Kilobyte.
ssh_ziel "cd $ZIELPFAD && ls -1t prod-config-*.tar.gz.enc 2>/dev/null | tail -n +$((BEHALTEN+1)) | xargs -r rm -f"
ANZ="$(ssh_ziel "ls -1 $ZIELPFAD/prod-config-*.tar.gz.enc 2>/dev/null | wc -l")"
echo "[$(date -u +%FT%TZ)] $ANZ Archive auf $ZIEL (Vorgabe: $BEHALTEN)"
