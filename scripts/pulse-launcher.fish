#!/usr/bin/env fish
#
# Pulse-Launcher — wofi-basierter Modus-Picker. Aus der .desktop-Datei oder
# direkt aus dem Terminal aufrufbar. Zeigt zwei Einträge:
#
#   Pulse — Lokal (Dev)   →  scripts/dev-up.fish    (Vite + Backend + Electron)
#   Pulse — Prod          →  scripts/prod.fish      (nur Electron → VPS)
#
# Argumente:
#   --mode=dev     Picker überspringen, direkt Dev starten
#   --mode=prod    Picker überspringen, direkt Prod starten
#
# Nutzt wofi (Wayland-native, niri-freundlich). Stirbt mit Hinweis falls wofi
# fehlt — dann `pacman -S wofi` oder einen der anderen Picker (z.B. fuzzel,
# kdialog) in dieses Script einbauen.

set -l repo_root (realpath (dirname (status -f))/..)

# Argument-Parser (minimal)
set -l mode ""
for arg in $argv
    switch $arg
        case '--mode=dev'
            set mode dev
        case '--mode=prod'
            set mode prod
        case '*'
            echo "Unbekanntes Argument: $arg" >&2
            echo "Usage: pulse-launcher.fish [--mode=dev|--mode=prod]" >&2
            exit 1
    end
end

# Wenn kein Mode explizit → wofi-Picker
if test -z "$mode"
    command -v wofi >/dev/null
    or begin
        echo "wofi fehlt. Install: sudo pacman -S wofi" >&2
        exit 1
    end

    set -l choice (printf '%s\n%s\n' \
        "Pulse — Lokal (Dev)" \
        "Pulse — Prod" \
        | wofi --dmenu --prompt "Modus" --width 360 --height 180 --insensitive)

    switch $choice
        case "Pulse — Lokal*"
            set mode dev
        case "Pulse — Prod*"
            set mode prod
        case '*'
            # Picker abgebrochen (Esc) → still exit
            exit 0
    end
end

# Dispatch
switch $mode
    case dev
        exec fish $repo_root/scripts/dev-up.fish
    case prod
        exec fish $repo_root/scripts/prod.fish
end
