#!/usr/bin/env bash
#
# Pulse Self-Host — One-command installer
# =======================================
#   curl -fsSL https://howispulse.com/install | PULSE_BOOTSTRAP_TOKEN=<TOKEN> bash
#
# Token bevorzugt per Env-Variable (argv wäre für jeden lokalen User in `ps`
# sichtbar, solange das Script läuft); `bash -s -- <TOKEN>` bleibt als
# Fallback unterstützt.
#
# Das Script erkennt die Umgebung selbst und richtet sich passend ein — auch
# wenn auf dem Server schon ein Reverse-Proxy läuft (User-Output ist Englisch,
# Kommentare bleiben Deutsch für die Wartung):
#
#   1. Auto-Discovery-Proxy (caddy-docker-proxy / Traefik / nginx-proxy) → der
#      Container hängt sich ins Proxy-Netz + setzt Labels/Env → automatisch.
#   2. Port 80 + 443 frei → Pulse terminiert HTTPS selbst (Let's Encrypt).
#   3. Statischer dockerisierter Proxy → Netz-Anbindung + eine Route ausgeben.
#   4. Reverse-Proxy außerhalb von Docker → Loopback-Port + Route ausgeben.
#
# Sicherheit: Bootstrap-Token wird beim Einlösen verbraucht, das Pairing-Secret
# serverseitig rotiert. --dry-run zeigt nur den Plan (kein Token-Verbrauch).
set -euo pipefail

# --- Konfiguration (per Env überschreibbar) --------------------------------
CLOUD_ORIGIN="${PULSE_CLOUD_ORIGIN:-https://howispulse.com}"
IMAGE="${PULSE_IMAGE:-registry.howispulse.com/pulse-allinone:edge}"
CONTAINER="${PULSE_CONTAINER:-pulse}"
VOLUME="${PULSE_VOLUME:-pulse-data}"
# Config-Verzeichnis: root → /opt/pulse, sonst ins Home (Docker-Gruppen-User
# ohne root-FS-Zugriff). Per PULSE_DIR überschreibbar.
if [ -n "${PULSE_DIR:-}" ]; then
  :
elif [ "$(id -u)" = "0" ]; then
  PULSE_DIR="/opt/pulse"
else
  PULSE_DIR="${HOME:-/tmp}/.pulse"
fi
HTTP_PORT="${PULSE_HTTP_PORT:-8080}"
ENV_FILE="${PULSE_DIR}/pulse.env"
UPDATE_SH="${PULSE_DIR}/pulse-update.sh"
# Optionale harte Overrides:
#   PULSE_TLS_MODE = auto | behind-proxy ; PULSE_NETWORK = Docker-Netz
FORCE_TLS_MODE="${PULSE_TLS_MODE:-}"
FORCE_NETWORK="${PULSE_NETWORK:-}"

# --- Args ---------------------------------------------------------------- #
DRY_RUN=""
TOKEN=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --*) ;;                       # unbekannte Flags ignorieren
    *) [ -z "$TOKEN" ] && TOKEN="$arg" ;;
  esac
done
TOKEN="${TOKEN:-${PULSE_BOOTSTRAP_TOKEN:-}}"

# --- Ausgabe-Helfer --------------------------------------------------------
log()  { printf '\033[1;36m[pulse]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[pulse]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[pulse] ERROR:\033[0m %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

[ -n "$TOKEN" ] || die "No bootstrap token provided.
  Usage: curl -fsSL ${CLOUD_ORIGIN}/install | PULSE_BOOTSTRAP_TOKEN=<TOKEN> bash
  Get a token in the Pulse app: Settings → Self-Host → Set up server."

# --- Docker prüfen ------------------------------------------------------- #
command -v docker >/dev/null 2>&1 \
  || die "Docker is not installed. → https://docs.docker.com/engine/install/"
docker info >/dev/null 2>&1 \
  || die "Cannot reach the Docker daemon. Run this script as root (sudo) or start Docker."

# --- Helfer: Port belegt? ------------------------------------------------ #
port_busy() {
  if command -v ss >/dev/null 2>&1; then
    ss -Hltn "sport = :$1" 2>/dev/null | grep -q .
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$"
  else
    return 1   # kann nicht prüfen → als frei annehmen
  fi
}

udp_port_busy() {
  if command -v ss >/dev/null 2>&1; then
    ss -Hlun "sport = :$1" 2>/dev/null | grep -q .
  elif command -v netstat >/dev/null 2>&1; then
    netstat -lun 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$"
  else
    return 1
  fi
}

# --- Alle Ports prüfen, die wir binden werden --------------------------- #
#
# Warum VOR dem Token-Einlösen: der Token ist einmalig und wird in Schritt 2
# verbrannt, `docker run` läuft erst in Schritt 4. Ein belegter Port 3478 (ein
# anderer coturn, gar nicht selten) liess das Script unter `set -e` sterben —
# mit verbranntem Token und einer rohen Docker-Fehlermeldung. Zwei Sekunden
# vorher war das erkennbar.
#
# Übersprungen bei einer Neuinstallation: dort hält der ALTE Pulse-Container
# die Ports noch, und `docker run` bekommt sie, weil er vorher entfernt wird.
# Ohne diese Ausnahme meldete das Script bei jedem zweiten Lauf einen Konflikt
# mit sich selbst.
check_ports() {
  docker inspect "$CONTAINER" >/dev/null 2>&1 && return 0
  local belegt=""
  local p
  case "$MODE" in
    greenfield) for p in 80 443; do port_busy "$p" && belegt="${belegt} ${p}/tcp"; done ;;
    hostproxy)  port_busy "$HTTP_PORT" && belegt="${belegt} ${HTTP_PORT}/tcp" ;;
  esac
  port_busy 3478 && belegt="${belegt} 3478/tcp"
  port_busy 1936 && belegt="${belegt} 1936/tcp"
  udp_port_busy 3478 && belegt="${belegt} 3478/udp"
  udp_port_busy 8189 && belegt="${belegt} 8189/udp"
  for p in $(seq 7882 7892); do
    udp_port_busy "$p" && belegt="${belegt} ${p}/udp"
  done
  [ -z "$belegt" ] && return 0
  die "These ports are already in use:${belegt}
  Pulse needs them for voice and screen sharing. Free them (or stop whatever
  is listening) and run this command again — your setup token is still valid,
  nothing has been consumed yet."
}

# --- Helfer: erstes nicht-triviales Docker-Netz eines Containers --------- #
first_user_network() {
  docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' "$1" 2>/dev/null \
    | grep -vE '^(host|none|bridge|)$' | head -1
}

# --- Helfer: veroeffentlicht dieser Container 80 oder 443 nach aussen? --- #
#
# `.NetworkSettings.Ports` bildet Container-Port -> Host-Bindungen ab. Ein
# Container, der 80 nur EXPONIERT (Wert null), taucht damit nicht auf — genau
# der Unterschied zwischen einem Reverse-Proxy und einer App, die zufaellig
# nginx im Image hat.
publishes_web_port() {
  docker inspect -f '{{range $p, $c := .NetworkSettings.Ports}}{{if $c}}{{$p}} {{end}}{{end}}' "$1" 2>/dev/null \
    | grep -qE '(^| )(80|443)/tcp'
}

# --- Helfer: ist das unser eigener, laufender Container? ----------------- #
#
# Ohne diese Frage stuft sich der Installer beim ZWEITEN Lauf selbst herunter:
# im greenfield-Modus haelt Pulse 80 und 443, das Image passt auf kein
# Proxy-Muster, und der Zweig `none` schliesst daraus auf einen fremden
# Reverse-Proxy. Ergebnis: TLS kippt auf behind-proxy, ACME stellt ein, der
# Server verschwindet aus dem Internet — waehrend der Container laeuft und die
# Checkliste gruen ist. `check_ports` kennt diese Ausnahme laengst (s. dort);
# nur die Moduswahl kannte sie nicht.
eigener_container_laeuft() {
  [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = "true" ]
}

# --- Helfer: Traefik-certresolver von vorhandenen Containern erben ------- #
detect_traefik_certresolver() {
  docker ps -q 2>/dev/null | while read -r id; do
    docker inspect -f '{{range $k,$v := .Config.Labels}}{{$k}}={{$v}}{{"\n"}}{{end}}' "$id" 2>/dev/null
  done | grep -oE 'certresolver=[A-Za-z0-9_-]+' | head -1 | cut -d= -f2
}

# --- Reverse-Proxy erkennen --------------------------------------------- #
# Setzt: PROXY_KIND (none|caddy-docker-proxy|traefik|nginx-proxy|static-caddy|
#        static-nginx), PROXY_CONTAINER, PROXY_NET
PROXY_KIND=none; PROXY_CONTAINER=""; PROXY_NET=""
_set_proxy() { PROXY_CONTAINER="$1"; PROXY_KIND="$2"; PROXY_NET="$(first_user_network "$1")"; }

detect_proxy() {
  local name image
  # 1) Auto-Discovery-Proxies (höchste Priorität)
  while IFS=$'\t' read -r name image; do
    case "$image" in
      *caddy-docker-proxy*) _set_proxy "$name" caddy-docker-proxy; return ;;
    esac
  done < <(docker ps --format '{{.Names}}'$'\t''{{.Image}}' 2>/dev/null)
  while IFS=$'\t' read -r name image; do
    case "$image" in
      *traefik*)                              _set_proxy "$name" traefik;     return ;;
      *nginxproxy/nginx-proxy*|*jwilder/nginx-proxy*) _set_proxy "$name" nginx-proxy; return ;;
    esac
  done < <(docker ps --format '{{.Names}}'$'\t''{{.Image}}' 2>/dev/null)
  # 2) Statische dockerisierte Proxies — nur relevant, wenn 80/443 belegt.
  #
  # Anders als oben sind die Muster hier GENERISCH (`*caddy*`, `*nginx*`) und
  # treffen deshalb auch Container, die bloss zufaellig nginx im Image haben.
  # Deswegen zaehlt nur, wer 80/443 auch wirklich veroeffentlicht — das ist die
  # einzige Eigenschaft, die einen Reverse-Proxy von einer App unterscheidet.
  #
  # Ohne diese Bedingung nahm die Schleife den ERSTEN Namenstreffer aus
  # `docker ps`, und das sortiert nach Erstellzeit (neueste zuerst). Am
  # 2026-08-25 gewann so `pulsetest_web` (nginx:1.27-alpine, Port 80 nur
  # intern, die Weboberflaeche des Dev-Stacks) gegen den echten `caddy`, der
  # zwei Monate aelter war — der Installer haette den Betreiber angewiesen,
  # eine Route in einen Container einzutragen, der gar kein Proxy ist.
  #
  # Faellt hier nichts an, bleibt PROXY_KIND=none und `decide_mode` waehlt bei
  # belegtem 80/443 den Modus `hostproxy` — richtig fuer einen Proxy auf dem
  # Host und auch fuer einen mit `network_mode: host` (der veroeffentlicht
  # nichts und hat ohnehin kein eigenes Docker-Netz).
  if port_busy 80 || port_busy 443; then
    while IFS=$'\t' read -r name image; do
      publishes_web_port "$name" || continue
      case "$image" in
        *caddy*) _set_proxy "$name" static-caddy; return ;;
        *nginx*) _set_proxy "$name" static-nginx; return ;;
        *traefik*) _set_proxy "$name" traefik; return ;;
      esac
    done < <(docker ps --format '{{.Names}}'$'\t''{{.Image}}' 2>/dev/null)
  fi
}

# --- Modus festlegen ----------------------------------------------------- #
# MODE: greenfield | discovery | static-docker | hostproxy
decide_mode() {
  detect_proxy
  case "$PROXY_KIND" in
    caddy-docker-proxy|traefik|nginx-proxy)
      if [ -n "$PROXY_NET" ]; then MODE=discovery
      else warn "Proxy '${PROXY_CONTAINER}' is only on the default bridge — cannot auto-wire, using loopback."; MODE=hostproxy; fi ;;
    static-caddy|static-nginx)
      if [ -n "$PROXY_NET" ]; then MODE=static-docker; else MODE=hostproxy; fi ;;
    none)
      # Veroeffentlicht unser eigener laufender Container 80/443 SELBST, ist
      # das KEIN fremder Proxy, sondern der greenfield-Modus eines fruehreren
      # Laufs — der Container haelt die Ports dann zurecht. Blosses "laeuft"
      # reicht nicht: im hostproxy-Modus laeuft der Container ebenso, bindet
      # aber nur Loopback (s. build_run_args) — 80/443 gehoeren dann einem
      # host-nativen Reverse-Proxy, den `docker ps` gar nicht sieht. Ohne die
      # Veroeffentlichungs-Pruefung wuerde genau dieser gueltige, gleichwertige
      # Fall auf greenfield umgestellt und beim naechsten `docker run` die
      # eigenen 80/443 gegen den fremden Proxy verlieren.
      if eigener_container_laeuft && publishes_web_port "$CONTAINER"; then
        MODE=greenfield
      elif port_busy 80 || port_busy 443; then
        MODE=hostproxy
      else
        MODE=greenfield
      fi ;;
  esac
  # Harte Overrides
  if [ "$FORCE_TLS_MODE" = "auto" ]; then MODE=greenfield; fi
  if [ -n "$FORCE_NETWORK" ]; then
    PROXY_NET="$FORCE_NETWORK"
    if [ "$MODE" = "greenfield" ]; then MODE=static-docker; fi
  fi
  return 0   # nie über den Exit-Status der letzten Bedingung stolpern (set -e)
}

# --- docker-run-Argumente nach Modus zusammenbauen ---------------------- #
build_run_args() {
  RUN_ARGS=( -d --name "$CONTAINER" --restart unless-stopped
             --env-file "$ENV_FILE" -v "${VOLUME}:/data" )
  # Voice/HQ-Ports immer (Mirror infra/self-host/docker-compose.yml):
  # LiveKit-WebRTC, TURN, RTMPS-Ingest + MediaMTX-WHEP-ICE (8189/udp —
  # ohne den kommt die HQ-Stream-Wiedergabe nicht über den ICE-Handshake).
  RUN_ARGS+=( -p 7882-7892:7882-7892/udp -p 3478:3478/tcp -p 3478:3478/udp
              -p 1936:1936/tcp -p 8189:8189/udp )

  case "$MODE" in
    greenfield)
      TLS_MODE=auto
      RUN_ARGS+=( -p 80:80 -p 443:443 ) ;;
    discovery)
      TLS_MODE=behind-proxy
      RUN_ARGS+=( --network "$PROXY_NET" )
      case "$PROXY_KIND" in
        caddy-docker-proxy)
          RUN_ARGS+=( --label "caddy=${SRV_HOST}"
                      --label "caddy.reverse_proxy={{upstreams ${HTTP_PORT}}}" ) ;;
        traefik)
          local r="pulse-${SRV_HOST}"
          RUN_ARGS+=( --label "traefik.enable=true"
                      --label "traefik.http.routers.${r}.rule=Host(\`${SRV_HOST}\`)"
                      --label "traefik.http.routers.${r}.entrypoints=websecure"
                      --label "traefik.http.routers.${r}.tls=true"
                      --label "traefik.http.services.${r}.loadbalancer.server.port=${HTTP_PORT}" )
          local cr; cr="$(detect_traefik_certresolver || true)"
          [ -n "$cr" ] && RUN_ARGS+=( --label "traefik.http.routers.${r}.tls.certresolver=${cr}" ) || true ;;
        nginx-proxy)
          RUN_ARGS+=( -e "VIRTUAL_HOST=${SRV_HOST}" -e "VIRTUAL_PORT=${HTTP_PORT}" )
          if docker ps --format '{{.Image}}' 2>/dev/null | grep -qiE 'acme-companion|nginx-proxy-companion'; then
            RUN_ARGS+=( -e "LETSENCRYPT_HOST=${SRV_HOST}" -e "LETSENCRYPT_EMAIL=${ADMIN_EMAIL}" )
          fi ;;
      esac ;;
    static-docker)
      TLS_MODE=behind-proxy
      RUN_ARGS+=( --network "$PROXY_NET" ) ;;
    hostproxy)
      TLS_MODE=behind-proxy
      RUN_ARGS+=( -p "127.0.0.1:${HTTP_PORT}:${HTTP_PORT}" ) ;;
  esac
  RUN_ARGS+=( "$IMAGE" )
}

# --- Plan ausgeben ------------------------------------------------------- #
print_plan() {
  log "Detected mode: ${MODE}${PROXY_KIND:+  (proxy: ${PROXY_KIND}${PROXY_CONTAINER:+ → ${PROXY_CONTAINER}}${PROXY_NET:+, network ${PROXY_NET}})}"
  case "$MODE" in
    greenfield)    log "→ Pulse binds 80/443 and obtains its own Let's Encrypt certificate." ;;
    discovery)     log "→ Pulse joins '${PROXY_NET}'; the proxy picks it up automatically. No manual step." ;;
    static-docker) log "→ Pulse joins '${PROXY_NET}', reachable as '${CONTAINER}:${HTTP_PORT}'. One route needed (see below)." ;;
    hostproxy)     log "→ Pulse listens on 127.0.0.1:${HTTP_PORT}. One route in your proxy needed (see below)." ;;
  esac
}

# --- JSON-Feld auslesen (python3 bevorzugt, sonst grep/sed) -------------- #
# Newlines werden hart entfernt: die Werte landen zeilenweise in der .env.
jget() {
  if command -v python3 >/dev/null 2>&1; then
    printf '%s' "$1" | python3 -c "import sys,json;print(json.load(sys.stdin).get('$2',''))" | tr -d '\r\n'
  else
    printf '%s' "$1" | grep -o "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 \
      | sed 's/.*:[[:space:]]*"//; s/"$//' | tr -d '\r\n'
  fi
}

# --- Host-Updater: Skript generieren (ersetzt Watchtower) --------------- #
# Statt eines dauerlaufenden Fremd-Containers mit Docker-Socket (= Root auf
# dem Host) schreibt der Installer ein kleines, lesbares Skript auf den Host
# und lässt es per systemd-Timer laufen. KEIN Container hält den Socket; der
# Update-Code führt nur fest verdrahtete Befehle aus, nimmt keine Anweisungen
# aus dem Image entgegen. Die exakten docker-run-Argumente werden quoting-sicher
# ins Skript eingebacken, damit der Container identisch neu erstellt wird.
write_update_script() {
  mkdir -p "$PULSE_DIR"
  {
    cat <<'HEADER'
#!/usr/bin/env bash
# Pulse self-host updater — generated by the installer, replaces Watchtower.
# Pulls the configured image; if its digest changed, recreates the container
# with the exact same run arguments. Run by systemd timer 'pulse-update' or
# manually. Edit nothing here — re-run the installer to regenerate.
set -euo pipefail
HEADER
    printf 'IMAGE=%q\n' "$IMAGE"
    printf 'CONTAINER=%q\n' "$CONTAINER"
    # Eigener Log-Pfad, damit das Skript ihn selbst kappen kann (s. BODY).
    # Nur die Cron-Variante schreibt dorthin; unter systemd geht alles nach
    # journald (das begrenzt sich selbst) und die Datei existiert nie — das
    # Kappen ist dann ein No-op.
    printf 'LOG=%q\n' "${PULSE_DIR}/pulse-update.log"
    printf 'RUN_ARGS=('
    printf '%q ' "${RUN_ARGS[@]}"
    printf ')\n'
    # Registry-Credentials einbacken (chmod 700, gleicher Schutz wie pulse.env).
    # Nur wenn IMAGE von der eigenen Registry kommt — der GHCR-Fallback via
    # PULSE_IMAGE braucht kein Login.
    case "$IMAGE" in
      registry.howispulse.com/*)
        printf 'REGISTRY=%q\n' "registry.howispulse.com"
        printf 'REG_USER=%q\n' "$CLIENT_ID"
        printf 'REG_PASS=%q\n' "$CLIENT_SECRET" ;;
    esac
    cat <<'BODY'

# Das eigene Log kappen — auf JEDEM Ausgang, deshalb per trap.
#
# Ohne das waechst die Datei unbegrenzt: der Updater laeuft alle fuenf Minuten,
# und sobald die Instanz in der Cloud geloescht oder gesperrt ist, scheitert
# schon der Registry-Login (403 "instance is not available") — dann schreibt
# jeder Lauf eine Zeile, fuer immer. Rund 17 KB am Tag auf einem fremden
# Rechner, auf dem niemand nachsieht. Genau die frueh abbrechenden Pfade sind
# die lauten, deshalb trap statt einer Zeile am Ende.
#
# In-place gekappt (gleiche Inode), nicht per Umbenennen: der Cron haelt die
# Datei mit O_APPEND offen, waehrend dieses Skript laeuft. Ein Umbenennen
# liesse die laufende Ausgabe in der alten Datei verschwinden.
# Erst ab 4000 Zeilen kappen, dann auf 2000 — nicht bei jedem Ueberschreiten.
# Ohne diesen Abstand traefe die Grenze nach dem ersten Kappen bei JEDEM Lauf
# wieder zu (2000 + eine neue Zeile) und das Skript schriebe alle fuenf Minuten
# 2000 Zeilen neu, fuer nichts.
_trim_log() {
  [ -f "${LOG:-}" ] || return 0
  local zeilen tmp
  zeilen="$(wc -l < "$LOG" 2>/dev/null || echo 0)"
  [ "${zeilen:-0}" -gt 4000 ] 2>/dev/null || return 0
  tmp="$(mktemp 2>/dev/null)" || return 0
  if tail -n 2000 "$LOG" > "$tmp" 2>/dev/null; then
    cat "$tmp" > "$LOG" 2>/dev/null || true
  fi
  rm -f "$tmp"
}
trap _trim_log EXIT

# `docker run -d` liefert 0, sobald der Container ERZEUGT wurde — nicht, wenn
# er tatsaechlich laeuft. Ein Image, das startet und sofort wieder stirbt,
# gaelte sonst als Erfolg: der Updater loeschte daraufhin die Rollback-Kopie
# UND das zuletzt funktionierende Image. Da IMAGE ein rollender Tag ist
# (z. B. ':edge'), ist die Vorversion danach nicht mehr adressierbar.
#
# Versuche/Intervall ueber Env steuerbar, damit Tests nicht 15 Sekunden je
# Fall warten muessen. Im Betrieb bleibt das GESAMTFENSTER beim Defaultwert
# von 15 Sekunden: ein frisch gestarteter Container kann kurz brauchen
# (eigene Migration, langsamer Healthcheck), bevor er dauerhaft laeuft — ein
# einzelner Check waere zu ungeduldig.
#
# Das INTERVALL selbst ist bewusst klein (0,2 s statt 1 s, bei entsprechend
# mehr Versuchen — dasselbe Gesamtfenster, nur feiner abgetastet) — NICHT
# wegen Genauigkeit um ihrer selbst willen. Die Schleife bricht beim ersten
# fehlgeschlagenen Check sofort ab, sitzt also nichts aus; was tatsächlich
# zählt, ist die LÜCKE zwischen zwei Stichproben. Gestartet wird mit
# '--restart unless-stopped': ein Container in einer Neustartschleife kann
# zwischen zwei Ein-Sekunden-Proben sterben UND wieder hochkommen — jede
# Probe sähe dann 'true', der Fehler wäre durchgerutscht. Mit 0,2 s wird
# dieses Fenster fünfmal kleiner, ohne die Kulanzzeit für einen langsam
# startenden, gesunden Container zu verkürzen. Kostet ein paar zusätzliche
# 'docker inspect'-Aufrufe — vernachlässigbar. Bruchteilssekunden bei
# 'sleep' sind keine GNU-Besonderheit: das Skript setzt an keiner Stelle eine
# bestimmte Distribution voraus, und sowohl GNU coreutils als auch BusyBox
# (Alpine 3.20 sowie busybox:1.36 direkt geprüft) akzeptieren 'sleep 0.2'.
# Welche Shell interpretiert, spielt dabei ohnehin keine Rolle — 'sleep' ist
# ein externes Programm, kein Shell-Builtin, in bash genau wie in dash/sh.
# Der erzeugte Updater läuft trotzdem immer unter bash, nie unter /bin/sh:
# Zeile 1 ist '#!/usr/bin/env bash' (s. HEADER-Heredoc oben, direkt geprüft
# am generierten Skript), und beide Aufrufwege — 'ExecStart=${UPDATE_SH}' im
# systemd-Unit sowie der Cron-Eintrag — starten die Datei über ihren
# ausführbaren Pfad (chmod 700), nicht über ein explizites 'sh $UPDATE_SH'.
container_laeuft_stabil() {
  local i versuche intervall
  versuche="${PULSE_UPDATE_STABIL_VERSUCHE:-75}"
  intervall="${PULSE_UPDATE_STABIL_INTERVALL:-0.2}"
  for i in $(seq 1 "$versuche"); do
    [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = "true" ] || return 1
    sleep "$intervall"
  done
  return 0
}

# Rückweg der letzten Aktualisierung aufräumen — NICHT im Erfolgszweig unten
# (siehe dort), sondern erst hier, am Anfang des NÄCHSTEN Laufs. `docker run`
# und die Stabilitätsprüfung oben decken nur den häufigsten Fall ab: einen
# Container, der sofort wieder stirbt. Einen, der zwei Minuten läuft und DANN
# stirbt, wiesen sie fälschlich als Erfolg aus — beide Rückwege wären da
# schon gelöscht. Läuft $CONTAINER genau JETZT, beim nächsten Timer-Takt fünf
# Minuten später, war der letzte Wechsel tatsächlich dauerhaft erfolgreich:
# das Beobachtungsfenster wird damit der ganze Fünf-Minuten-Takt statt einer
# kurzen Stichprobe direkt nach dem Start.
#
# Muss VOR dem Digest-Kurzschluss unten stehen — sonst räumt ein Lauf ohne
# neues Image (der häufigste) nie auf, und der Rückweg bliebe für immer liegen.
#
# Ersetzt die frühere bedingungslose "docker rm -f ${CONTAINER}-old # Rest
# eines früheren Fehlversuchs" direkt vor dem Umbenennen weiter unten: die
# hätte nach diesem Umbau auch einen noch nicht bestätigten, gültigen
# Rückweg gelöscht. Ihren eigentlichen Fall — ein abgebrochener früherer Lauf
# (Host stirbt zwischen Umbenennen und Neustart) — deckt weiterhin etwas ab:
# entweder existiert "$CONTAINER" danach gar nicht mehr (dann greift das
# "if docker inspect $CONTAINER" unten erst gar nicht, keine Namenskollision
# möglich) oder er läuft wieder — und genau den räumt dieser Block hier beim
# nächsten Takt auf.
if docker inspect "${CONTAINER}-old" >/dev/null 2>&1 \
   && [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = "true" ]; then
  backup_image_id="$(docker inspect -f '{{.Image}}' "${CONTAINER}-old" 2>/dev/null || true)"
  docker rm -f "${CONTAINER}-old" >/dev/null 2>&1 || true
  # Nur das damalige Rückweg-Image entfernen — kein host-weites 'image prune'.
  { [ -n "$backup_image_id" ] && docker image rm "$backup_image_id" >/dev/null 2>&1; } || true
fi

if [ -n "${REG_PASS:-}" ]; then
  docker login "$REGISTRY" -u "$REG_USER" -p "$REG_PASS" >/dev/null 2>&1 \
    || { echo "pulse-update: registry login failed, will retry next run" >&2; exit 0; }
fi
docker pull "$IMAGE" >/dev/null 2>&1 \
  || { echo "pulse-update: pull failed (network/registry?), will retry next run" >&2; exit 0; }
new_id="$(docker image inspect --format '{{.Id}}' "$IMAGE" 2>/dev/null || true)"
cur_id="$(docker inspect --format '{{.Image}}' "$CONTAINER" 2>/dev/null || true)"
[ -n "$new_id" ] || { echo "pulse-update: cannot read image id, skipping" >&2; exit 0; }
[ "$new_id" = "$cur_id" ] && exit 0   # already up to date

echo "pulse-update: updating $CONTAINER -> $new_id"
# Alten Container beiseitestellen statt sofort löschen → Rollback bei Fehlstart.
# Single-Container mit festen Ports: der alte MUSS vor dem neuen gestoppt werden
# (kurze Downtime unvermeidbar), aber er bleibt als '<name>-old' erhalten, bis
# der Aufräum-Block oben ihn beim nächsten bestätigt erfolgreichen Lauf entfernt.
if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  docker rename "$CONTAINER" "${CONTAINER}-old" >/dev/null 2>&1 || true
  docker stop "${CONTAINER}-old" >/dev/null 2>&1 || true
fi
if docker run "${RUN_ARGS[@]}" >/dev/null && container_laeuft_stabil "$CONTAINER"; then
  echo "pulse-update: done"
else
  echo "pulse-update: new container failed to start — rolling back" >&2
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  if docker inspect "${CONTAINER}-old" >/dev/null 2>&1; then
    docker rename "${CONTAINER}-old" "$CONTAINER" >/dev/null 2>&1 || true
    docker start "$CONTAINER" >/dev/null 2>&1 || true
  fi
  exit 1
fi
BODY
  } > "$UPDATE_SH"
  chmod 700 "$UPDATE_SH"
}

# --- Host-Updater: systemd-Timer installieren --------------------------- #
install_update_timer() {
  cat > /etc/systemd/system/pulse-update.service <<EOF
[Unit]
Description=Pulse self-host auto-update
Wants=network-online.target
After=network-online.target docker.service

[Service]
Type=oneshot
ExecStart=${UPDATE_SH}
EOF
  cat > /etc/systemd/system/pulse-update.timer <<'EOF'
[Unit]
Description=Pulse self-host auto-update (every 5 min)

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
Persistent=true

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now pulse-update.timer >/dev/null 2>&1
}

# --- Host-Updater: User-Crontab (Fallback ohne root/systemd) ------------- #
# Ein docker-group-User (non-root) kann keinen System-Timer schreiben, aber
# seine eigene Crontab — die läuft sudo-frei und unabhängig vom Login. So
# bleibt Auto-Update auch beim non-root-Install erhalten (der alte Watchtower
# lief als Container ebenfalls non-root — ohne Fallback wäre das ein Regress).
install_update_cron() {
  local entry="*/5 * * * * ${UPDATE_SH} >> ${PULSE_DIR}/pulse-update.log 2>&1"
  # Bestehenden Eintrag für unser Skript ersetzen (idempotent), Rest behalten.
  # `crontab -l` endet bei leerer/fehlender Crontab mit 1 und schweigt; bleibt
  # nach dem Herausfiltern nichts übrig (leere Crontab ODER eine Crontab, die
  # bisher NUR unseren eigenen Eintrag enthielt), endet `grep -vF` ebenfalls
  # mit 1 — hier ist das ein Normalzustand, kein Fehler. Ohne das `|| true`
  # reisst `pipefail` + `set -e` (Skriptkopf) die Gruppe ab, BEVOR
  # `echo "$entry"` läuft: die Crontab würde leer installiert, und der
  # gesamte Installer stirbt danach still mit Exit 1 — nachdem der Container
  # schon läuft und bevor die Proxy-Route ausgegeben wird.
  { crontab -l 2>/dev/null | grep -vF "$UPDATE_SH" || true; echo "$entry"; } | crontab -
}

# ======================================================================== #
# Ablauf
# ======================================================================== #

# 1) Umgebung erkennen + Modus wählen (braucht KEINEN Token).
SRV_HOST="<hostname>"; ADMIN_EMAIL=""    # Platzhalter für die Dry-Run-Vorschau
decide_mode
build_run_args
print_plan

if [ -n "$DRY_RUN" ]; then
  echo
  log "DRY RUN — nothing changed, no token consumed."
  log "Planned container start:"
  printf '    docker run'; printf ' %q' "${RUN_ARGS[@]}"; echo
  exit 0
fi

# 1b) Ports prüfen, solange der Token noch unverbraucht ist.
check_ports

# 2) Token einlösen (verbraucht ihn, rotiert das Secret).
log "Redeeming bootstrap token at ${CLOUD_ORIGIN}…"
RESP="$(curl -fsSL -X POST "${CLOUD_ORIGIN}/api/auth/selfhost/bootstrap" \
        -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json')" \
  || die "Token redemption failed — expired or already used?
  Generate a fresh command in the Pulse app (Set up server → regenerate)."

INSTANCE_ID="$(jget "$RESP" instance_id)"
OWNER_ID="$(jget "$RESP" owner_user_id)"
SRV_HOST="$(jget "$RESP" hostname)"
CLIENT_ID="$(jget "$RESP" client_id)"
CLIENT_SECRET="$(jget "$RESP" client_secret)"
ADMIN_EMAIL="$(jget "$RESP" admin_email)"
RESP_ORIGIN="$(jget "$RESP" cloud_origin)"
[ -n "$RESP_ORIGIN" ] && CLOUD_ORIGIN="$RESP_ORIGIN" || true
[ -n "$INSTANCE_ID" ] && [ -n "$CLIENT_SECRET" ] && [ -n "$SRV_HOST" ] \
  || die "Unexpected response from the cloud — aborting."
log "Instance: ${SRV_HOST} (ID ${INSTANCE_ID})"

# Hostname steht jetzt fest → Run-Args neu bauen (Labels brauchen ihn).
build_run_args

# 3) Config schreiben (chmod 600).
mkdir -p "$PULSE_DIR"
( umask 077
  cat > "$ENV_FILE" <<EOF
PULSE_HOSTNAME=${SRV_HOST}
PULSE_INSTANCE_ID=${INSTANCE_ID}
PULSE_INSTANCE_OWNER_ID=${OWNER_ID}
PULSE_INSTANCE_MODE=self-host
PULSE_CLOUD_ORIGIN=${CLOUD_ORIGIN}
PULSE_CLOUD_CLIENT_ID=${CLIENT_ID}
PULSE_CLOUD_CLIENT_SECRET=${CLIENT_SECRET}
PULSE_ADMIN_EMAIL=${ADMIN_EMAIL}
PULSE_TLS_MODE=${TLS_MODE}
PULSE_HTTP_PORT=${HTTP_PORT}
EOF
)
chmod 600 "$ENV_FILE"
log "Configuration written: ${ENV_FILE} (readable by root only)"

# 4) Container starten.
case "$IMAGE" in
  registry.howispulse.com/*)
    log "Logging in to Pulse registry (instance credentials)…"
    docker login registry.howispulse.com -u "$CLIENT_ID" -p "$CLIENT_SECRET" \
      || die "Registry login failed — instance credentials rejected (suspended or wrong instance?)." ;;
esac
log "Pulling image ${IMAGE}…"
docker pull "$IMAGE"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
log "Starting Pulse (${MODE})…"
docker run "${RUN_ARGS[@]}" >/dev/null

# 5) Auto-Update — Host-systemd-Timer statt eines socket-haltenden Containers.
# Kein Container braucht den Docker-Socket; der Update-Code ist das oben
# generierte, lesbare Skript. PULSE_NO_AUTOUPDATE=1 schaltet es ab
# (PULSE_NO_WATCHTOWER bleibt als Alias erhalten).
# Migration: einen früher angelegten Watchtower-Container ablösen.
docker rm -f pulse-watchtower >/dev/null 2>&1 || true
if [ -z "${PULSE_NO_AUTOUPDATE:-${PULSE_NO_WATCHTOWER:-}}" ]; then
  write_update_script
  log "Update helper written: ${UPDATE_SH}"
  if [ "$(id -u)" = "0" ] && command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    install_update_timer
    log "Auto-updates enabled (systemd timer 'pulse-update.timer', checks every 5 min)."
  elif command -v crontab >/dev/null 2>&1; then
    install_update_cron
    log "Auto-updates enabled (user crontab, checks every 5 min). 'crontab -l' to view."
  else
    warn "No root+systemd and no crontab — auto-update could not be scheduled."
    warn "Update manually anytime:   ${UPDATE_SH}"
  fi
fi

# 6) Startfortschritt verfolgen — mitlaufende Checkliste statt Stille.
#
# Gelesen wird der Fortschritt AUS DEM CONTAINER (`docker exec … cat
# /data/setup-status`, geschrieben von cont-init-main.sh), nicht über HTTP.
# Das ist der einzige Weg, der in jedem Modus funktioniert: im Modus
# `greenfield` ist der externe HTTPS-Weg genau so lange tot, wie Caddy noch
# kein Zertifikat hat — also genau während der Phase, über die man etwas
# wissen will. Und im Modus `static-docker` gibt es überhaupt keinen Weg von
# aussen, bevor der Betreiber die Route unten angelegt hat.
schritt_text() {
  case "$1" in
    start)               echo "container started" ;;
    10-check-cloud-creds) echo "configuration checked" ;;
    01-init-data-dirs)   echo "data directory prepared" ;;
    03-init-secrets)     echo "keys generated" ;;
    02-init-postgres)    echo "database initialised" ;;
    04-init-coturn)      echo "TURN configured" ;;
    05-init-livekit)     echo "voice server configured" ;;
    07-render-env)       echo "runtime configuration written" ;;
    08-init-mediamtx)    echo "screen-share relay configured" ;;
    09-init-caddy)       echo "web server configured" ;;
    11-render-frpc)      echo "tunnel configured" ;;
    06-run-migrations)   echo "database migrated" ;;
    fertig)              echo "startup complete" ;;
    *)                   echo "$1" ;;
  esac
}

log "Starting up — this takes about a minute:"
GESEHEN=0
FERTIG=""
ABBRUCH=""
for _ in $(seq 1 60); do
  STATUS_ROH="$(docker exec "$CONTAINER" cat /data/setup-status 2>/dev/null || true)"
  if [ -n "$STATUS_ROH" ]; then
    ZEILEN="$(printf '%s\n' "$STATUS_ROH" | wc -l)"
    if [ "$ZEILEN" -gt "$GESEHEN" ]; then
      printf '%s\n' "$STATUS_ROH" | tail -n +$((GESEHEN + 1)) | while IFS="$(printf '\t')" read -r _t name zustand; do
        [ -z "$name" ] && continue
        if [ "$zustand" = "ok" ]; then
          printf '    \033[1;32m+\033[0m %s\n' "$(schritt_text "$name")"
        else
          printf '    \033[1;31mx\033[0m %s — FAILED\n' "$(schritt_text "$name")"
        fi
      done
      GESEHEN="$ZEILEN"
    fi
    printf '%s\n' "$STATUS_ROH" | grep -q "$(printf '\t')fertig$(printf '\t')ok" && { FERTIG=1; break; }
    # Merker statt `exit` in der Regel: ein `exit` dort springt nach END,
    # und dessen `exit` ueberschreibt den Status wieder — die Erkennung waere
    # damit immer falsch.
    printf '%s\n' "$STATUS_ROH" \
      | awk -F"$(printf '\t')" '$3 != "" && $3 != "ok" { gefunden=1 } END { exit !gefunden }' \
      && { ABBRUCH=1; break; }
  fi
  # Ein Container, der nicht mehr läuft, wird auch nicht mehr fertig.
  if ! docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
    ABBRUCH=1; break
  fi
  sleep 5
done

echo
if [ -n "$ABBRUCH" ]; then
  err "Startup aborted. The step marked FAILED above is where it stopped."
  err "  docker logs ${CONTAINER} 2>&1 | tail -50"
  exit 1
fi
[ -n "$FERTIG" ] || warn "Startup is taking longer than expected — check: docker logs -f ${CONTAINER}"

# 7) Falls eine Route nötig ist, sie + den Reload-Befehl konkret ausgeben.
#
# BEVOR geprüft wird, nicht danach: im Modus `static-docker` hat der Container
# keinen veröffentlichten Port, er ist also über https://<hostname> erst
# erreichbar, NACHDEM diese Route steht. Früher stand die Prüfung davor und
# lief zwangsläufig fünf Minuten ins Leere, bevor der Betreiber überhaupt
# erfuhr, was er noch zu tun hat.
if [ "$MODE" = "static-docker" ] || [ "$MODE" = "hostproxy" ]; then
  if [ "$MODE" = "static-docker" ]; then TARGET="${CONTAINER}:${HTTP_PORT}"; else TARGET="127.0.0.1:${HTTP_PORT}"; fi
  # Reload-Befehl nach erkanntem Proxy (bei dockerisiertem statischem Proxy
  # kennen wir den Container-Namen → konkreter Befehl).
  case "$PROXY_KIND" in
    static-caddy) RELOAD_CMD="docker exec ${PROXY_CONTAINER} caddy reload --config /etc/caddy/Caddyfile" ;;
    static-nginx) RELOAD_CMD="docker exec ${PROXY_CONTAINER} nginx -s reload" ;;
    *)            RELOAD_CMD="# reload your reverse proxy, e.g.:  sudo systemctl reload caddy   (or: nginx -s reload)" ;;
  esac
  cat <<EOF

  ----------------------------------------------------------------
  Last step — ONE route in your existing reverse proxy.
  (If a route for ${SRV_HOST} already exists, just point it at http://${TARGET}.)

  Caddy — add to your Caddyfile:
      ${SRV_HOST} {
          reverse_proxy ${TARGET}
      }
  nginx — inside the server block (WebSockets must pass through):
      location / {
          proxy_pass http://${TARGET};
          proxy_http_version 1.1;
          proxy_set_header Upgrade \$http_upgrade;
          proxy_set_header Connection "upgrade";
          proxy_set_header Host \$host;
      }

  Then reload the proxy:
      ${RELOAD_CMD}
  ----------------------------------------------------------------

EOF
  # Ohne die Route kann keine Prüfung von aussen gelingen — also erst fragen.
  printf '  Press Enter once the route is in place (or Ctrl-C to check later)… '
  # Mit Frist: ein unbeaufsichtigter Lauf mit Terminal haenge sonst fuer immer.
  read -r -t 600 _ </dev/tty 2>/dev/null || true
  echo
fi

# Bericht der Aussen-Pruefung — eine Checkliste, kein Protokollauszug.
#
# Der Adressat sitzt genau hier: er hat gerade installiert, steht auf der
# Maschine und kann sofort handeln. Deshalb je Glied ein Haken oder ein Kreuz,
# und fuer das ERSTE Kreuz der volle Klartext samt Handgriff — die Glieder
# danach wiederholen in aller Regel nur dieselbe Ursache.
#
# Die Saetze kommen vom Server (`dcc_auth/diagnose_texte.py`) und nicht von
# hier. Sonst stuenden sie ein zweites Mal im Repo und beschrieben nach ein
# paar Monaten denselben Zustand anders als die App.
#
# Der Code steht in einer Variablen statt direkt hinter `python3 -c '...'`:
# im zitierten Here-Doc bleiben beide Anfuehrungszeichen frei benutzbar. Kein
# f-String mit eigenen Anfuehrungszeichen — das erlaubt erst Python 3.12
# (PEP 701), und Debian 12 bringt 3.11 mit.
PY_BERICHT=$(cat <<'PYEOF'
import json, os, sys, textwrap

def wrap(text, einzug):
    breite = max(28, 74 - len(einzug))
    zeilen = []
    for absatz in str(text).split("\n"):
        zeilen.extend(textwrap.wrap(absatz, breite) or [""])
    return "\n".join(einzug + z for z in zeilen)

try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)

# Farben nur am Terminal. Wer die Ausgabe in eine Datei leitet, um sie zu
# verschicken, soll Text bekommen und keine Steuerzeichen.
if sys.stdout.isatty():
    GRUEN, ROT, GELB, AUS = "\033[1;32m", "\033[1;31m", "\033[1;33m", "\033[0m"
else:
    GRUEN = ROT = GELB = AUS = ""
LINIE = "  " + "-" * 66

schritte = d.get("schritte", [])
print()
for s in schritte:
    marke = GRUEN + "[ ok ]" + AUS if s.get("ok") else ROT + "[FAIL]" + AUS
    print("    {0} {1}".format(marke, s.get("titel") or s.get("schritt")))

# Eine abgebrochene Kette darf sich nicht wie eine vollstaendige lesen.
offen = d.get("nicht_geprueft") or []
if offen:
    print()
    print("    " + GELB + "[ -- ]" + AUS + " not checked, the chain stopped before them:")
    print(wrap(", ".join(offen), "           "))

print()
if d.get("gesamt") == "ok":
    print(LINIE)
    print("  " + GRUEN + "YOUR SERVER IS REACHABLE FROM THE INTERNET." + AUS)
    print("  Every link answered. Your users can sign in.")
    print(LINIE)
    sys.exit(0)

fehler = None
for s in schritte:
    if not s.get("ok"):
        fehler = s
        break
if fehler is None:
    sys.exit(0)

print(LINIE)
print("  " + ROT + "THIS IS WHERE IT BREAKS: " + str(fehler.get("titel") or fehler.get("schritt")) + AUS)
print()
print(wrap(fehler.get("was_ist") or fehler.get("befund"), "    "))
if fehler.get("einzelheit"):
    print()
    print("    measured: " + str(fehler.get("einzelheit")))

# Zeigt der Name auf eine ANDERE Maschine als die, auf der wir stehen?
# Beides ist moeglich — ein falscher DNS-Eintrag oder ein Firmennetz mit
# getrenntem Ein- und Ausgang — und der Unterschied entscheidet ueber den
# Handgriff. Deshalb werden beide Adressen nebeneinandergestellt und beide
# Deutungen genannt, statt eine zu behaupten.
eigene = (os.environ.get("PULSE_EIGENE_IP") or "").strip()
aufgeloest = ""
for s in schritte:
    if s.get("schritt") == "dns" and s.get("ok"):
        aufgeloest = str(s.get("einzelheit") or "").strip()
if eigene and aufgeloest and eigene not in [a.strip() for a in aufgeloest.split(",")]:
    print()
    print(wrap(
        "Note: the name resolves to " + aufgeloest + ", but this machine reports "
        "its own outgoing address as " + eigene + ". Either the DNS record points "
        "at a different machine, or a firewall in front of it is not forwarding "
        "to this one. Both look the same from outside.", "    "))

if fehler.get("was_tun"):
    print()
    print("    " + GELB + "WHAT TO DO" + AUS)
    print(wrap(fehler.get("was_tun"), "    "))

print()
print("  Fix this first, then check again from this machine:")
print("      docker exec " + (os.environ.get("PULSE_CONTAINER_NAME") or "pulse") + " pulse-doctor")
print(LINIE)
PYEOF
)

# 8) Die Prüfung von aussen — das Einzige, was der Server über sich selbst
# NICHT sagen kann. Die Cloud geht die ganze Kette ab (DNS, Zertifikat,
# Routing, CORS, WebSocket-Upgrade, UDP) und benennt das Glied, das fehlt.
#
# Die eigene Aussenadresse kommt AUS DEM CONTAINER, nicht aus einem zweiten
# Aufruf an einen fremden Dienst: dort steht genau die Zahl, mit der Pulse
# selbst arbeitet (04-init-coturn), und es entsteht keine neue Abhaengigkeit.
pruefung_von_aussen() {
  local antwort eigene
  antwort="$(curl -fsS -m 60 -X POST \
    "${CLOUD_ORIGIN}/api/auth/selfhost/diagnose/${INSTANCE_ID}" \
    -H "X-Pulse-Client-Id: ${CLIENT_ID}" \
    -H "X-Pulse-Client-Secret: ${CLIENT_SECRET}" 2>/dev/null)" || return 1
  [ -n "$antwort" ] || return 1
  command -v python3 >/dev/null 2>&1 || { printf '%s\n' "$antwort"; return 0; }
  eigene="$(docker exec "$CONTAINER" sed -n 's/^external-ip=//p' \
    /etc/coturn/turnserver.conf 2>/dev/null | tr -d '\r' | head -n1 || true)"
  printf '%s' "$antwort" \
    | PULSE_EIGENE_IP="$eigene" PULSE_CONTAINER_NAME="$CONTAINER" python3 -c "$PY_BERICHT"
}

log "Checking your server from the outside — this is what your users will see:"
if pruefung_von_aussen; then
  :
else
  warn "Could not run the external check right now."
  warn "Run it on this machine any time:  docker exec $CONTAINER pulse-doctor"
  warn "Or in the Pulse app: My Instances → Check connection."
fi

echo
log "Pulse should now be at https://${SRV_HOST}"

# Kernel-UDP-Puffer: NUR ein Hinweis, ausdruecklich kein Eingriff.
#
# Warum nicht selbst setzen: der Installer laeuft nicht zwingend als root, und
# ungefragt am Kernel des WIRTS zu drehen ist etwas anderes, als einen
# Container hinzustellen — die Grenze gilt fuer jeden Dienst auf der Maschine.
# Warum ueberhaupt: MediaMTX buendelt alle WebRTC-Sitzungen auf EINEM
# UDP-Socket, LiveKit fordert von sich aus grosse Puffer an; Debians Vorgabe
# (~212 KB) klemmt beide still, und der Verlust entsteht dann auf dem Server
# selbst — keine Fehlerkorrektur der Welt holt ihn zurueck. Volle Begruendung:
# `infra/prod/sysctl-pulse.conf`, Anleitung `infra/self-host/README.md`.
cat <<'EOF'

  ----------------------------------------------------------------
  Optional — only worth it once many people watch at the same time:
  raising the kernel's UDP buffer limits helps WebRTC (screen share
  and voice). As root, once:

      printf 'net.core.rmem_max = 16777216\nnet.core.wmem_max = 16777216\n' \
        > /etc/sysctl.d/99-pulse.conf && sysctl --system

  These are upper limits, not reservations — no memory is used until
  a socket actually asks for it. Pulse runs fine without this.
  ----------------------------------------------------------------
EOF

log "Done."
