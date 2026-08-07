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

# **Host-Key wird gepinnt, nicht beim ersten Mal geglaubt.** `accept-new`
# nimmt den Schluessel der Gegenstelle beim ersten Kontakt ungeprueft an — wer
# in dem Moment dazwischensitzt, bekommt das Archiv und wird nie bemerkt.
# Weil hier Produktions-Geheimnisse wandern, ist das zu wenig: die erwartete
# Kennung steht in `NOTFALL_HOSTKEY` (Format wie in `known_hosts`) und wird
# ueber eine eigene Datei erzwungen. Fehlt sie, bricht das Skript ab, statt
# stillschweigend zu vertrauen.
: "${NOTFALL_HOSTKEY:?NOTFALL_HOSTKEY fehlt in .env — Host-Kennung des Ziels pinnen}"
HOSTKEY_DATEI="$(mktemp)"
printf '%s\n' "$NOTFALL_HOSTKEY" > "$HOSTKEY_DATEI"

ssh_opts=(-i "$SSH_KEY" -o BatchMode=yes
          -o StrictHostKeyChecking=yes
          -o UserKnownHostsFile="$HOSTKEY_DATEI")
ssh_ziel() { ssh "${ssh_opts[@]}" "$ZIEL" "$@"; }

if [ "${1:-}" = "--liste" ]; then
  ssh_ziel "ls -la $ZIELPFAD/ 2>/dev/null" || echo "Zielverzeichnis nicht erreichbar"
  exit 0
fi

STEMPEL="$(date -u +%Y%m%d-%H%M)"
ARCHIV="prod-config-${STEMPEL}.tar.gz.enc"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP" "${HOSTKEY_DATEI:-}"' EXIT

# Nur die drei Dinge, die es NUR hier gibt. Alles andere steht im Git.
tar czf "$TMP/roh.tar.gz" .env secrets certs 2>/dev/null

# **Das Passwort geht NICHT ueber die Kommandozeile.** `-pass pass:…` legt es
# in argv, und argv ist auf Linux fuer JEDEN Benutzer der Maschine per `ps`
# lesbar. `-pass env:` liest es aus der Umgebung; die ist nur fuer denselben
# Benutzer und root einsehbar.
#
# PBKDF2 mit hoher Iterationszahl, weil das Archiv auf einer Maschine landet,
# die wir weniger scharf bewachen als diese hier.
export NOTFALL_ARCHIV_PASSWORT
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
  -in "$TMP/roh.tar.gz" -out "$TMP/$ARCHIV" -pass env:NOTFALL_ARCHIV_PASSWORT

# **Encrypt-then-MAC.** AES-CBC allein ist verschluesselt, aber nicht
# BEGLAUBIGT: wer das Archiv auf dem Zielrechner veraendert, erzeugt beim
# Entschluesseln Muell statt einer Fehlermeldung — im schlimmsten Fall
# unbemerkt. Der HMAC daneben macht jede Veraenderung sichtbar. Weder `gpg`
# noch `age` sind auf diesem Server vorhanden, sonst waere ein AEAD-Verfahren
# der kuerzere Weg.
# Auch hier NICHT ueber argv: `openssl dgst -hmac` nimmt den Schluessel nur
# als Argument entgegen, und das waere derselbe Fehler wie oben. Python liest
# ihn aus der Umgebung.
hmac_von() { python3 -c "
import hmac, hashlib, os, sys
schluessel = os.environ['NOTFALL_ARCHIV_PASSWORT'].encode()
with open(sys.argv[1], 'rb') as f:
    print(hmac.new(schluessel, f.read(), hashlib.sha256).hexdigest())
" "$1"; }
hmac_von "$TMP/$ARCHIV" > "$TMP/$ARCHIV.hmac"

ssh_ziel "mkdir -p $ZIELPFAD && chmod 700 $ZIELPFAD"
scp -q "${ssh_opts[@]}" "$TMP/$ARCHIV" "$ZIEL:$ZIELPFAD/$ARCHIV"
scp -q "${ssh_opts[@]}" "$TMP/$ARCHIV.hmac" "$ZIEL:$ZIELPFAD/$ARCHIV.hmac"
ssh_ziel "chmod 600 $ZIELPFAD/$ARCHIV $ZIELPFAD/$ARCHIV.hmac"

# Rückhol-Probe: ein Archiv, das sich nicht öffnen lässt, ist kein Backup.
# Deshalb wird JEDER Lauf gegengeprüft, nicht nur der erste.
ssh_ziel "cat $ZIELPFAD/$ARCHIV" > "$TMP/probe.enc"
ssh_ziel "cat $ZIELPFAD/$ARCHIV.hmac" > "$TMP/probe.hmac.fremd"
# Zuerst die Beglaubigung, dann erst entschluesseln — nie umgekehrt.
# Vergleich in konstanter Zeit — ein zeichenweiser Abbruch verriete sonst
# ueber die Laufzeit, wie weit ein gefaelschter HMAC stimmt.
if ! python3 -c "
import hmac, sys
a = open(sys.argv[1]).read().strip()
b = open(sys.argv[2]).read().strip()
sys.exit(0 if hmac.compare_digest(a, b) else 1)
" <(hmac_von "$TMP/probe.enc") "$TMP/probe.hmac.fremd"; then
  echo "[$(date -u +%FT%TZ)] FEHLER: HMAC des zurueckgeholten Archivs stimmt nicht" >&2
  exit 1
fi
if openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
     -in "$TMP/probe.enc" -out "$TMP/probe.tar.gz" \
     -pass env:NOTFALL_ARCHIV_PASSWORT 2>/dev/null \
   && tar tzf "$TMP/probe.tar.gz" | grep -q "secrets/jwt_private.pem"; then
  echo "[$(date -u +%FT%TZ)] $ARCHIV gesichert und zurueckgelesen (jwt_private.pem enthalten)"
else
  echo "[$(date -u +%FT%TZ)] FEHLER: $ARCHIV liess sich nicht zurueckholen" >&2
  exit 1
fi

# Alte Stände wegräumen, aber großzügig — sie kosten wenige Kilobyte.
ssh_ziel "cd $ZIELPFAD && ls -1t prod-config-*.tar.gz.enc 2>/dev/null | tail -n +$((BEHALTEN+1)) | sed 's/\\.enc$//' | xargs -r -I{} rm -f {}.enc {}.enc.hmac"
ANZ="$(ssh_ziel "ls -1 $ZIELPFAD/prod-config-*.tar.gz.enc 2>/dev/null | wc -l")"
echo "[$(date -u +%FT%TZ)] $ANZ Archive auf $ZIEL (Vorgabe: $BEHALTEN)"
