#!/usr/bin/env fish
#
# Electron im Prod-Mode starten (lädt https://pulse.unicutmedia.com).
#
# Symmetrisch zu dev-up.fish — nur die Electron-Schicht. Backend ist die echte
# VPS, keine lokalen Services nötig. GSR-Binary für HQ-Streaming wird gesetzt
# wenn vorhanden, sonst ist nur Watching/Voice möglich.
#
# Bricht ab wenn schon ein Electron läuft.

set -l repo_root (realpath (dirname (status -f))/..)
cd $repo_root

set -l red (set_color red)
set -l grn (set_color green)
set -l ylw (set_color yellow)
set -l rst (set_color normal)

function _info; echo "$grn→ $rst$argv"; end
function _warn; echo "$ylw⚠ $rst$argv"; end
function _die; echo "$red✗ $rst$argv" >&2; exit 1; end

# Guard: zweites Electron würde kollidieren
for pid in (pgrep -f 'electron \.$' 2>/dev/null)
    _die "Es läuft schon eine Electron-Instanz (PID $pid). Erst schließen."
end

# Build (idempotent + schnell)
_info "Electron-Bundle bauen"
pushd desktop >/dev/null
PATH=$HOME/.local/bin:$PATH pnpm run build:electron >/dev/null 2>&1; or _die "build:electron failed"

# Optional: GSR-Binary für HQ-Streaming
set -l gsr_env ""
set -l gsr_bin "/tmp/gsr-analysis/gpu-screen-recorder/build/gpu-screen-recorder"
if test -x $gsr_bin
    set gsr_env "GSR_BINARY=$gsr_bin PULSE_SIDECAR_PY=$repo_root/streaming/gsr-sidecar/control.py"
else
    _warn "GSR-Binary fehlt — HQ-Stream-Button bleibt versteckt."
end

_info "Electron starten (→ pulse.unicutmedia.com)"
bash -c "env $gsr_env setsid nohup ./node_modules/.bin/electron . > /tmp/dcc-electron-prod.log 2>&1 < /dev/null &"
popd >/dev/null
sleep 2
echo "$grn ✓ $rstPulse läuft (Prod). Log: /tmp/dcc-electron-prod.log"
