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

# Nur Dev-Electron killen — Prod-Mode nicht anfassen. pkill nutzt ERE: eine
# Alternation ist ein nacktes |, "\|" waere ein LITERALES Pipe-Zeichen und
# wuerde nie matchen (Befund 2026-09-02: Dev-Electron ueberlebte dev-down).
_info "Electron (Dev) stoppen"
pkill -f "user-data-dir=.*/Pulse-Dev" 2>/dev/null
pkill -f "PULSE_DEV_URL.*electron" 2>/dev/null
pkill -f "electron@42.*electron \." 2>/dev/null
sleep 0.5
_ok "Electron weg"

_info "Vite stoppen"
pkill -f "vite dev|vite/bin/vite" 2>/dev/null
sleep 0.3
_ok "Vite weg"

_info "Uvicorns stoppen"
pkill -f "uvicorn dcc_" 2>/dev/null
sleep 0.5
_ok "Uvicorns weg"

_info "MediaMTX stoppen"
pushd streaming/server >/dev/null
docker compose stop mediamtx >/dev/null 2>&1
popd >/dev/null

_info "Container stoppen (Postgres / Redis / MinIO / LiveKit)"
docker compose --profile voice stop >/dev/null 2>&1
_ok "Container gestoppt (Volumes bleiben)"

echo ""
echo "$grn═══════════════════════════════════════════════════$rst"
echo "$grn  Dev-Stack heruntergefahren$rst"
echo "$grn═══════════════════════════════════════════════════$rst"
echo "  Nächster Start:   scripts/dev-up.fish"
echo "  Komplett-Reset:   docker compose --profile voice down -v   (löscht Volumes!)"
echo ""
