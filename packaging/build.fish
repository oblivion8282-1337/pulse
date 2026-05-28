#!/usr/bin/env fish
# Local Flatpak build + install (user scope, no sudo).
#
# Builds the esbuild bundle first (the manifest copies electron/dist/*.cjs, which
# are gitignored and only exist after build:electron), then runs flatpak-builder.
# First run pulls runtimes + builds FFmpeg + GSR from source → ~15-30 min.
#
# Distribution (later): instead of `--install`, do
#   flatpak-builder --repo=<repo-dir> --force-clean build/flatpak packaging/com.howispulse.Pulse.yml
# then host <repo-dir> over HTTPS and hand out a .flatpakref.

set script_dir (dirname (status -f))
set repo_root (realpath $script_dir/..)
cd $repo_root

echo "→ build:electron (esbuild → desktop/electron/dist/*.cjs)"
pnpm --filter @dcc/desktop build:electron; or exit 1

set manifest packaging/com.howispulse.Pulse.yml
set build_dir build/flatpak
mkdir -p $build_dir

echo "→ flatpak-builder (first run: ~15-30 min — FFmpeg + GSR from source)"
flatpak-builder \
    --user \
    --install-deps-from=flathub \
    --force-clean \
    --install \
    $build_dir \
    $manifest

if test $status -eq 0
    echo ""
    echo "✓ done — start with:  flatpak run com.howispulse.Pulse"
else
    echo ""
    echo "✗ build failed — see output above"
    exit 1
end
