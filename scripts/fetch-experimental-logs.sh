#!/usr/bin/env bash
# Holt die vom Desktop-Client hochgeladenen Sidecar-Diagnose-Logs von der Cloud.
#
# Wozu: Der Linux-HQ-Sidecar (Rust) lädt bei Stream-Ende/-Fehler den Schwanz
# seiner `sidecar.log` hoch — aber nur, wenn der Nutzer im Kompatibilitäts-Tab
# "Diagnose-Protokolle senden" eingeschaltet hat (`uploadDiagnosticLogs`).
# Die Uploads landen in `auth.experimental_logs` auf dem Cloud-Postgres; von
# außen gibt es KEINE Leseroute (bewusst — die Logs sind Support-Material).
# Dieses Skript ist der Lesezugriff: ssh → docker exec → psql.
#
# Im Log steht das, was `av_buffersrc_add_frame_flags failed (rc=-22)` allein
# nicht verrät: FFmpegs eigene Fehlerzeile (der Sidecar tee't stderr mit) und
# die Zeilen `[stream] Import auf <Render-Node> fehlgeschlagen: …`, also welche
# Karte den Puffer abgelehnt hat.
#
# Benutzung:
#   scripts/fetch-experimental-logs.sh              # die letzten 20 auflisten
#   scripts/fetch-experimental-logs.sh list 50
#   scripts/fetch-experimental-logs.sh show <id>    # ein Log im Volltext
#   scripts/fetch-experimental-logs.sh latest       # das neueste im Volltext
set -euo pipefail

HOST="${PULSE_PROD_HOST:-michael@159.195.150.54}"

die() { echo "FEHLER: $*" >&2; exit 1; }

# SQL über ssh an den Postgres-Container. Das SQL reist über stdin und wird erst
# auf dem Server per `$(cat)` zum psql-Argument — direkt in die Kommandozeile
# eingesetzt müsste es durch zwei Quoting-Ebenen (lokale Shell + ssh-Remote-Shell)
# und jedes Anführungszeichen im Statement wäre eine Falle. Deshalb braucht
# `docker exec` auch kein `-i`: psql liest nichts von stdin, es bekommt ein Arg.
# `-tA` (bei show/latest) = keine Kopfzeile/Ausrichtung, damit Volltext-Logs
# unverfälscht rauskommen.
psql_remote() { # psql_remote <flags> <sql>
  ssh -o BatchMode=yes "$HOST" \
    "docker exec pulse_postgres psql -U dcc -d dcc $1 \"\$(cat)\"" <<<"$2"
}

# Die Zahl-Prüfungen in cmd_list/cmd_show sind nicht Komfort, sondern Pflicht:
# beide Werte werden unescaped ins SQL interpoliert.
cmd_list() {
  local limit="${1:-20}"
  [[ "$limit" =~ ^[0-9]+$ ]] || die "limit muss eine Zahl sein"
  psql_remote -c "
    select id, created_at, reason,
           system_info->>'os'          as os,
           system_info->>'os_release'  as kernel,
           system_info->>'app_version' as app,
           length(log_text)            as zeichen
      from auth.experimental_logs
     order by created_at desc
     limit $limit;"
}

cmd_show() {
  local id="${1:-}"
  [[ "$id" =~ ^[0-9]+$ ]] || die "show braucht eine numerische id (siehe 'list')"
  psql_remote -tAc "select log_text from auth.experimental_logs where id = $id;"
}

cmd_latest() {
  psql_remote -tAc "
    select log_text from auth.experimental_logs
     order by created_at desc limit 1;"
}

case "${1:-list}" in
  list)   cmd_list "${2:-}" ;;
  show)   cmd_show "${2:-}" ;;
  latest) cmd_latest ;;
  *)      sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 1 ;;
esac
