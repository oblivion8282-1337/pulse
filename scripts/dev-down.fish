#!/usr/bin/env fish
#
# Local dev stack — tear-down.
#
# Stoppt Electron, Vite, Uvicorns und die Container. Volumes bleiben erhalten
# (postgres-Daten + redis bleiben für den nächsten `dev-up` da).

set -l repo_root (realpath (dirname (status -f))/..)
cd $repo_root

set -l grn (set_color green)
set -l rst (set_color normal)
function _ok; echo "$grn ✓ $rst$argv"; end
function _info; echo "$grn→ $rst$argv"; end

# Nur Dev-Electron killen (PULSE_DEV_URL gesetzt) — Prod-Mode nicht anfassen.
_info "Electron (Dev) stoppen"
pkill -f "PULSE_DEV_URL.*electron\|electron@42.*electron \." 2>/dev/null
sleep 0.5
_ok "Electron weg"

_info "Vite stoppen"
pkill -f "vite dev\|vite/bin/vite" 2>/dev/null
sleep 0.3
_ok "Vite weg"

_info "Uvicorns stoppen"
pkill -f "uvicorn dcc_" 2>/dev/null
sleep 0.5
_ok "Uvicorns weg"

_info "MediaMTX stoppen"
pushd streaming/server >/dev/null
podman-compose stop mediamtx >/dev/null 2>&1
popd >/dev/null

_info "Container stoppen (Postgres / Redis / LiveKit)"
podman-compose --profile voice stop >/dev/null 2>&1
_ok "Container gestoppt (Volumes bleiben)"

echo ""
echo "$grn═══════════════════════════════════════════════════$rst"
echo "$grn  Dev-Stack heruntergefahren$rst"
echo "$grn═══════════════════════════════════════════════════$rst"
echo "  Nächster Start:   scripts/dev-up.fish"
echo "  Komplett-Reset:   podman-compose --profile voice down -v   (löscht Volumes!)"
echo ""
