#!/usr/bin/env fish
#
# Local dev stack — one-shot up.
#
# Brings up containers (Postgres / Redis / LiveKit / MediaMTX), runs Alembic
# upgrades, starts the 5 uvicorn services with `--reload`, the Vite dev server,
# and Electron pointed at localhost:5173. Idempotent — safe to re-run.
#
# Refuses to start if an Electron instance against the *prod* URL is already
# running (refusing to mix dev + prod in the same login session).
#
# Logs land in /tmp/dcc-*.log.

set -l repo_root (realpath (dirname (status -f))/..)
cd $repo_root

set -l red (set_color red)
set -l grn (set_color green)
set -l ylw (set_color yellow)
set -l rst (set_color normal)

function _ok; echo "$argv[1]$grn ✓ $rst$argv[2]"; end
function _info; echo "$grn→ $rst$argv"; end
function _warn; echo "$ylw⚠ $rst$argv"; end
function _die; echo "$red✗ $rst$argv" >&2; exit 1; end

# --- Prerequisites ----------------------------------------------------------

_info "Pre-flight checks"
test -f .env; or _die ".env fehlt — vergleiche mit .env.example"
test -f secrets/jwt_private.pem; or _die "secrets/jwt_private.pem fehlt"
command -v docker >/dev/null; or _die "docker fehlt"
docker compose version >/dev/null 2>&1; or _die "docker compose (Plugin) fehlt"
command -v uv >/dev/null; or _die "uv fehlt"

set -l pnpm_bin (command -v pnpm)
if test -z "$pnpm_bin"
    set pnpm_bin "$HOME/.local/bin/pnpm"
    test -x $pnpm_bin; or _die "pnpm fehlt (auch nicht in ~/.local/bin)"
end
_ok "" "Tools da"

# --- Guard: keine zweite Electron-Instanz ----------------------------------

# Wir prüfen pro laufendem Electron-Hauptprozess in /proc/<pid>/environ, ob
# PULSE_DEV_URL gesetzt ist. Wenn ein Electron OHNE PULSE_DEV_URL läuft, ist
# das ein prod-Fenster — abbrechen, damit dev/prod-Sessions sich nicht
# überschneiden. Andernfalls (alle existierenden Electrons sind bereits dev)
# starten wir trotzdem; das Vite-HMR im laufenden Dev-Fenster reagiert eh
# live.
for pid in (pgrep -f 'electron \.$' 2>/dev/null)
    set -l env_file /proc/$pid/environ
    test -r $env_file; or continue
    if not tr '\0' '\n' < $env_file | grep -q "^PULSE_DEV_URL="
        _die "Es läuft eine Electron-Instanz im Prod-Mode (PID $pid). Erst dieses Fenster schließen, sonst kollidieren Login-States."
    end
end

# --- Load env ---------------------------------------------------------------

# Parse the .env we need for uvicorn-Start. .env ist KEY=VALUE-Zeilen.
function _read_env_var
    set -l name $argv[1]
    set -l line (grep -m1 "^$name=" .env)
    if test -n "$line"
        echo (string replace -r "^$name=" "" -- $line)
    end
end

set -gx POSTGRES_PASSWORD (_read_env_var POSTGRES_PASSWORD)
test -n "$POSTGRES_PASSWORD"; or _die "POSTGRES_PASSWORD fehlt in .env"

# Service-zu-Service-Secret (auth → chat-gateway DELETE /me purge,
# chat-gateway → voice-signaling eviction). Fehlt es, 503t die
# Account-Löschung — kein harter Fehler fürs Dev-Loop, nur ein Hinweis.
set -l internal_secret (_read_env_var INTERNAL_SERVICE_SECRET)
if test -z "$internal_secret"
    _warn "INTERNAL_SERVICE_SECRET fehlt in .env — Account-Löschung (DELETE /me) bleibt 503. Generieren: python -c 'import secrets; print(secrets.token_urlsafe(32))'"
end

# --- Container --------------------------------------------------------------

_info "Container starten (Postgres + Redis + MinIO + LiveKit)"
docker compose --profile voice up -d >/dev/null 2>&1; or _die "docker compose root failed"

_info "MediaMTX starten"
cd $repo_root/streaming/server
if not test -f mediamtx.yml
    cp mediamtx.yml.template mediamtx.yml
    _warn "mediamtx.yml aus Template erstellt"
end
docker compose up -d mediamtx >/dev/null 2>&1; or _die "docker compose mediamtx failed"
cd $repo_root

# Wait for Postgres healthy
for i in (seq 1 20)
    docker exec dcc_night_postgres pg_isready -U dcc -d dcc >/dev/null 2>&1; and break
    sleep 0.5
end
_ok "" "Container up"

# --- Migrationen ------------------------------------------------------------

_info "Alembic upgrade (auth + chat-gateway)"
for svc in auth chat-gateway
    pushd services/$svc >/dev/null
    POSTGRES_HOST=localhost POSTGRES_PORT=5434 \
        uv run alembic upgrade head >/dev/null 2>&1
    or _die "alembic $svc failed"
    popd >/dev/null
end
_ok "" "DB aktuell"

# --- Uvicorns ---------------------------------------------------------------

# Kill alte Instanzen damit --reload sauber neu startet.
pkill -f "uvicorn dcc_" 2>/dev/null
sleep 0.5

# PULSE_INSTANCE_MODE=cloud: lokales Dev verhält sich wie howispulse.com.
# Ohne das greift der Default `self-host` → chat-gateway verlangt eine
# PULSE_INSTANCE_ID (Cert-Modell) und crasht beim Start, auth-svc blockt zudem
# POST /register.
set -l common_env "REDIS_URL=redis://localhost:6380/0 AUTH_JWKS_URL=http://127.0.0.1:8001/.well-known/jwks.json PULSE_INSTANCE_MODE=cloud"
set -l pg_env "POSTGRES_PASSWORD=$POSTGRES_PASSWORD POSTGRES_HOST=localhost POSTGRES_PORT=5434"
set -l jwt_env "JWT_PRIVATE_KEY_FILE=$repo_root/secrets/jwt_private.pem JWT_PUBLIC_KEY_FILE=$repo_root/secrets/jwt_public.pem"
set -l lk_env "LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=devsecretdevsecretdevsecretdevsecret LIVEKIT_URL=ws://localhost:7880"
# auth + chat-gateway teilen das Internal-Secret; auth braucht zusätzlich
# CHAT_GATEWAY_URL (Default zeigt auf den Docker-Namen, lokal unerreichbar).
set -l internal_env "INTERNAL_SERVICE_SECRET=$internal_secret"

_info "Uvicorns starten (mit --reload)"

# auth (8001)
bash -c "cd services/auth && env $pg_env $jwt_env $common_env $internal_env CHAT_GATEWAY_URL=http://127.0.0.1:8002 setsid nohup uv run uvicorn dcc_auth.app:app --host 127.0.0.1 --port 8001 --reload > /tmp/dcc-auth.log 2>&1 < /dev/null &"

# chat-gateway (8002)
bash -c "cd services/chat-gateway && env $pg_env $common_env $internal_env MEDIA_SVC_URL=http://127.0.0.1:8004 setsid nohup uv run uvicorn dcc_chat_gateway.app:app --host 127.0.0.1 --port 8002 --reload > /tmp/dcc-chat.log 2>&1 < /dev/null &"

# voice-signaling (8003) — braucht INTERNAL_SERVICE_SECRET, damit der
# participant_left-Webhook den chat-gateway-Revoke-Endpoint authentifiziert
# aufrufen kann (sonst bleibt ein Voice-Pull-Grant beim Verlassen stehen).
bash -c "cd services/voice-signaling && env $common_env $lk_env $internal_env CHAT_GATEWAY_URL=http://127.0.0.1:8002 setsid nohup uv run uvicorn dcc_voice_signaling.app:app --host 127.0.0.1 --port 8003 --reload > /tmp/dcc-voice.log 2>&1 < /dev/null &"

# media-svc (8004)
bash -c "cd services/media-svc && env $common_env MEDIAMTX_API_URL=http://localhost:9997/v3/paths/list setsid nohup uv run uvicorn dcc_media_svc.app:app --host 127.0.0.1 --port 8004 --reload > /tmp/dcc-media.log 2>&1 < /dev/null &"

# mediamtx-auth-hook (8005)
bash -c "cd services/mediamtx-auth-hook && env $common_env setsid nohup uv run uvicorn dcc_mediamtx_auth_hook.app:app --host 127.0.0.1 --port 8005 --reload > /tmp/dcc-authhook.log 2>&1 < /dev/null &"

# Auf alle 5 Ports warten
for port in 8001 8002 8003 8004 8005
    for i in (seq 1 30)
        ss -tln 2>/dev/null | grep -q ":$port "; and break
        sleep 0.3
    end
end
_ok "" "Services up (auth/chat/voice/media/auth-hook)"

# --- Vite -------------------------------------------------------------------

pkill -f "vite dev\|vite/bin/vite" 2>/dev/null
sleep 0.5
_info "Vite starten"
bash -c "export PATH=$HOME/.local/bin:\$PATH; cd web && setsid nohup pnpm dev --host 127.0.0.1 --port 5173 > /tmp/dcc-vite.log 2>&1 < /dev/null &"
for i in (seq 1 30)
    ss -tln 2>/dev/null | grep -q ":5173 "; and break
    sleep 0.3
end
_ok "" "Vite up (:5173)"

# --- Electron (dev) ---------------------------------------------------------

_info "Electron Build"
pushd desktop >/dev/null
PATH=$HOME/.local/bin:$PATH pnpm run build:electron >/dev/null 2>&1; or _die "electron build failed"

set -l gsr_env ""
# bootstrap-gsr.fish baut nach $XDG_CACHE_HOME/pulse/gsr/... — der Pfad
# überlebt Reboots (im Gegensatz zum alten /tmp/gsr-analysis-Standort).
# Wir checken den XDG-Pfad zuerst, das Legacy-/tmp-Verzeichnis als Fallback.
set -l cache_root (test -n "$XDG_CACHE_HOME"; and echo "$XDG_CACHE_HOME"; or echo "$HOME/.cache")
set -l gsr_bin "$cache_root/pulse/gsr/gpu-screen-recorder/build/gpu-screen-recorder"
if not test -x $gsr_bin
    set gsr_bin "/tmp/gsr-analysis/gpu-screen-recorder/build/gpu-screen-recorder"
end
if test -x $gsr_bin
    set gsr_env "GSR_BINARY=$gsr_bin PULSE_SIDECAR_PY=$repo_root/streaming/gsr-sidecar/control.py"
else
    _warn "GSR-Binary fehlt — HQ-Stream-Button bleibt versteckt. (`streaming/bootstrap-gsr.fish` baut es.)"
end

_info "Electron starten (→ localhost:5173)"
bash -c "env PULSE_DEV_URL=http://localhost:5173 PULSE_DEVTOOLS=1 $gsr_env setsid nohup ./node_modules/.bin/electron . > /tmp/dcc-electron-dev.log 2>&1 < /dev/null &"
popd >/dev/null
sleep 2
_ok "" "Electron up"

# --- Zusammenfassung --------------------------------------------------------

echo ""
echo "$grn═══════════════════════════════════════════════════$rst"
echo "$grn  Pulse Dev-Stack läuft$rst"
echo "$grn═══════════════════════════════════════════════════$rst"
echo "  Web:       http://127.0.0.1:5173"
echo "  Services:  :8001 (auth) :8002 (chat) :8003 (voice) :8004 (media) :8005 (auth-hook)"
echo "  Infra:     postgres :5434  redis :6380  livekit :7880  mediamtx :8889/1935/1936"
echo "  Logs:      /tmp/dcc-*.log"
echo ""
echo "  Hot-Reload: Backend (uvicorn --reload) + Frontend (Vite HMR) reagieren sofort."
echo "  Stop:      scripts/dev-down.fish"
echo ""
