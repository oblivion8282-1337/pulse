#!/usr/bin/env bash
# Prueft die Produktions-Konfiguration gegen das, was die Dienste WIRKLICH
# erwarten — read-only, ohne einen einzigen Schreibzugriff auf den Server.
#
# ── Warum es das gibt ───────────────────────────────────────────────────────
#
# Am 2026-08-07 hat eine Absicherungsarbeit die `.env` auf dem Produktivserver
# neu geschrieben und dabei ZWEI Schluessel verloren: `REGISTRY_PUSH_TOKEN` und
# `JWT_CERT_FILE`. Aufgefallen ist es erst Stunden spaeter beim Deploy, und auch
# dann nur, weil ein Baulauf rot wurde. Alle 15 Container liefen die ganze Zeit
# gesund, die Webseite funktionierte, Anmeldungen gingen — kaputt war nur ein
# Weg, den man einmal am Tag braucht.
#
# **Das ist die Fehlerklasse, um die es hier geht:** eine Einstellung, die
# fehlt, ohne dass irgendetwas ausfaellt. Ein Neustart deckt sie nicht auf, ein
# Health-Check auch nicht.
#
# ── Was NICHT die Frage ist ─────────────────────────────────────────────────
#
# „Welche Einstellungen sind ungesetzt?" — das sind rund 90 von 138, und das ist
# voellig in Ordnung: Ratengrenzen, Laufzeiten, Intervalle laufen auf ihren
# Vorgaben. Eine Liste davon ist Laerm, in dem der eine echte Fund untergeht.
#
# Gefaehrlich sind genau zwei Sorten von Vorgabe:
#
#   1. **Ein Pfad**, der im Container ins Leere zeigt. Genau so ist
#      `JWT_CERT_FILE` gestorben: die Vorgabe `./secrets/jwt_public.crt` ist
#      relativ, und im Container gibt es dort nichts. Der Dienst startet
#      trotzdem und meldet den Fehler erst, wenn jemand die Funktion benutzt.
#   2. **Ein leeres Geheimnis.** So ist `REGISTRY_PUSH_TOKEN` gestorben: die
#      Vorgabe ist `None`, und der Endpunkt antwortet dann brav mit 401.
#
# ── Die Falle, in die ich beim Bauen selbst getappt bin ─────────────────────
#
# Relative Vorgaben haengen am ARBEITSORDNER des Containers, und der ist NICHT
# `/app`, sondern `/app/services/<dienst>`. Mit der falschen Annahme meldet
# dieses Skript zwei Fehlalarme (Avatare und Community-Icons liegen sehr wohl
# da, nur eine Ebene tiefer). Deshalb wird der Arbeitsordner abgefragt und nicht
# geraten — die Zeile mit `.Config.WorkingDir` ist der Grund, warum der Bericht
# stimmt.
#
# ── Aufruf ──────────────────────────────────────────────────────────────────
#
#   bash scripts/prod-env-pruefen.sh              # gegen pulse-prod
#   ZIEL=pulse-test bash scripts/prod-env-pruefen.sh
#
# Rueckgabewert 1, wenn ein Befund vorliegt — damit es in einen Cron passt.
set -uo pipefail

ZIEL="${ZIEL:-pulse-prod}"
FERN="${FERN:-~/pulse/infra/prod}"
WURZEL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BEFUNDE=0

ssh_still() { ssh -o BatchMode=yes -o ConnectTimeout=20 "$ZIEL" "$@" 2>/dev/null; }

echo "== Konfigurations-Pruefung gegen $ZIEL =="
if ! ssh_still true; then
  echo "FEHLER: $ZIEL nicht erreichbar (SSH)." >&2
  exit 2
fi
# Die Betriebsart entscheidet, welche Wege es auf dieser Instanz ueberhaupt
# gibt (s. die Ausnahme weiter unten). Unbekannt => wie Self-Host behandeln,
# also strenger pruefen: lieber ein Befund zu viel als einer zu wenig.
MODUS="$(ssh_still "grep -oE '^PULSE_INSTANCE_MODE=.*' $FERN/.env | cut -d= -f2-" | tr -d '\r')"
echo "   Betriebsart: ${MODUS:-unbekannt}"

# ── 1. Was DEPLOY.md ausdruecklich in der `.env` verlangt ───────────────────
#
# Die Doku ist hier die Autoritaet, nicht der Code: sie nennt die Schluessel,
# die ein Mensch beim Aufsetzen von Hand eintragen muss. Beide am 2026-08-07
# verlorenen standen dort (Zeile 198 und 225) — diese Pruefung allein haette
# den Vorfall gefunden.
echo
echo "-- In DEPLOY.md fuer die .env verlangt, auf dem Server nicht gesetzt:"
# **Gegen die Settings-Klassen gefiltert.** Ohne diesen Filter meldet die
# Pruefung auch `PGPW` und `COMPOSE_PROFILES` — Shell-Variablen aus Beispielen
# in der Doku, die nie in einer `.env` stehen. Ein Werkzeug, das bei jedem Lauf
# zwei Fehlalarme wirft, wird nach dem zweiten Mal ignoriert; dann haette es
# den Vorfall auch nicht verhindert.
# Ueber Dateien statt Prozess-Substitution: `comm -12 - <(…)` innerhalb einer
# Befehlsersetzung lieferte unter Git-Bash still eine LEERE Menge — die
# Pruefung meldete dann „nichts" und pruefte in Wahrheit gar nichts. Ein
# stiller Fehlalarm in die andere Richtung, und damit genau die Sorte Fehler,
# gegen die dieses Skript geschrieben ist.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
grep -hoE '^    [a-z][a-z0-9_]*:' "$WURZEL"/services/*/src/*/config.py \
  | tr -d ' :' | tr 'a-z' 'A-Z' | sort -u > "$TMP/bekannt"
grep -oE '`[A-Z][A-Z0-9_]{3,}=' "$WURZEL/infra/prod/DEPLOY.md" 2>/dev/null \
  | tr -d '`=' | sort -u > "$TMP/dok"
comm -12 "$TMP/dok" "$TMP/bekannt" > "$TMP/soll"
ssh_still "grep -oE '^[A-Z0-9_]+=' $FERN/.env | tr -d '='" | sort -u > "$TMP/ist"
SOLL_DOK="$(cat "$TMP/soll")"
FEHLT_DOK="$(comm -23 "$TMP/soll" "$TMP/ist")"
if [ -n "$FEHLT_DOK" ]; then
  printf '   FEHLT: %s\n' $FEHLT_DOK
  BEFUNDE=$((BEFUNDE + 1))
else
  echo "   nichts (${SOLL_DOK:+$(printf '%s\n' "$SOLL_DOK" | wc -l | tr -d ' ')} Schluessel geprueft)"
fi

# ── 2. Pfad-Vorgaben, die im Container ins Leere zeigen ─────────────────────
#
# Aus den `Settings`-Klassen der Dienste abgeleitet, nicht aus einer gepflegten
# Liste — eine gepflegte Liste veraltet, die Klassen nicht. Geprueft wird nur,
# was NICHT gesetzt ist (gesetzte Werte hat jemand bewusst gewaehlt).
echo
echo "-- Ungesetzte Pfad-Vorgaben, die im Container nicht existieren:"
for cfg in "$WURZEL"/services/*/src/*/config.py; do
  dienst="$(echo "$cfg" | sed 's|.*/services/||; s|/src/.*||')"
  container="pulse_$(echo "$dienst" | tr '-' '_')"
  ssh_still "docker inspect $container >/dev/null" || continue
  arbeitsordner="$(ssh_still "docker inspect $container --format '{{.Config.WorkingDir}}'")"
  [ -z "$arbeitsordner" ] && continue
  gesetzt="$(ssh_still "docker inspect $container --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -oE '^[A-Z0-9_]+'")"

  # Felder mit einer Pfad-artigen Vorgabe: `feld: ... = "..."` mit / darin.
  while IFS= read -r zeile; do
    feld="$(echo "$zeile" | sed 's/^ *//; s/:.*//')"
    vorgabe="$(echo "$zeile" | sed 's/.*= *//; s/^Path(//; s/)$//' | tr -d '"'"'"'')"
    [ -z "$vorgabe" ] && continue
    # Eine URL ist kein Pfad. Ohne diese Zeile meldet die Pruefung
    # `VOICE_SIGNALING_URL` als fehlende Datei unter
    # `/app/services/chat-gateway/http://127.0.0.1:8003` — sichtbarer Unsinn,
    # der die echten Befunde entwertet.
    case "$vorgabe" in *://*) continue ;; esac
    case "$vorgabe" in */*) : ;; *) continue ;; esac
    name="$(echo "$feld" | tr 'a-z' 'A-Z')"
    printf '%s\n' "$gesetzt" | grep -qx "$name" && continue
    # Cert-Modell-Wege gibt es auf einer Cloud-Instanz nicht. Der
    # Sitzungs-Schluessel wird dort nie angelegt, weil sich niemand per Cert
    # anmeldet (`PULSE_INSTANCE_MODE=cloud`) — seine Abwesenheit ist der
    # Normalzustand und kein Befund. Auf einem Self-Host waere sie einer,
    # deshalb haengt die Ausnahme an der Betriebsart und ist nicht pauschal.
    if [ "$MODUS" = cloud ]; then
      case "$name" in SESSION_SIGNING_KEY_FILE | JWKS_PIN_FILE) continue ;; esac
    fi
    case "$vorgabe" in
      /*) voll="$vorgabe" ;;
      ./*) voll="$arbeitsordner/${vorgabe#./}" ;;
      *) voll="$arbeitsordner/$vorgabe" ;;
    esac
    if ! ssh_still "docker exec $container sh -c '[ -e \"$voll\" ]'"; then
      echo "   $dienst: $name zeigt auf $voll — existiert nicht"
      BEFUNDE=$((BEFUNDE + 1))
    fi
  done < <(grep -hE '^    [a-z][a-z0-9_]*: .*= *("|Path\()' "$cfg")
done
[ "$BEFUNDE" -eq 0 ] && echo "   nichts"

# ── 3. Was der Vorfall vom 2026-08-07 unmittelbar betraf ────────────────────
#
# Eine gezielte Funktionsprobe schlaegt jede Existenzpruefung: sie beweist, dass
# der Weg GEHT, nicht nur dass eine Datei dasteht. Ohne Zugangsdaten hier — die
# gehoeren nicht in ein Pruefskript.
echo
echo "-- Funktionsprobe Registry-Token-Dienst (ohne Zugangsdaten, 401 = gesund):"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
        'https://howispulse.com/api/auth/registry/token?service=registry.howispulse.com' || echo 000)"
case "$code" in
  401) echo "   HTTP 401 — Endpunkt lebt und verlangt Anmeldung (richtig)" ;;
  500) echo "   HTTP 500 — Endpunkt kaputt (typisch: JWT_CERT_FILE fehlt)"; BEFUNDE=$((BEFUNDE + 1)) ;;
  *)   echo "   HTTP $code — unerwartet"; BEFUNDE=$((BEFUNDE + 1)) ;;
esac

echo
if [ "$BEFUNDE" -eq 0 ]; then
  echo "== Kein Befund =="
  exit 0
fi
echo "== $BEFUNDE Befund(e) — s.o. =="
exit 1
