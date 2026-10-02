#!/usr/bin/env fish
# Local Flatpak build + install for the Pulse SERVER app (user scope, no sudo).
#
# Spiegel von build.fish (Client), mit dem Server-Bundle: die Reihenfolge ist
# hier DER Witz — `build:electron:server` muss VOR flatpak-builder laufen, denn
# das Manifest kopiert desktop/electron/dist (gitignored, nur nach dem Bau
# vorhanden), und ein vorheriger Client-Bau hätte die server.html/server.js
# fehlen lassen. Details: packaging/com.howispulse.PulseServer.yml (Kopf).
#
# Erstbau zieht ggf. die BaseApp — danach geht es in Minuten (kein
# FFmpeg/Rust-Modul, anders als der Client).

set script_dir (dirname (status -f))
set repo_root (realpath $script_dir/..)
cd $repo_root

echo "→ build:electron:server (esbuild → desktop/electron/dist mit server.html)"
pnpm --filter @dcc/desktop build:electron:server; or exit 1

set manifest packaging/com.howispulse.PulseServer.yml
set build_dir build/flatpak-server
mkdir -p $build_dir

echo "→ flatpak-builder (Server-Flatpak: kein FFmpeg/Rust — schnell)"
flatpak-builder \
    --user \
    --install-deps-from=flathub \
    --force-clean \
    --install \
    $build_dir \
    $manifest

if test $status -eq 0
    echo ""
    echo "✓ done — start with:  flatpak run com.howispulse.PulseServer"
else
    echo ""
    echo "✗ build failed — see output above"
    exit 1
end
