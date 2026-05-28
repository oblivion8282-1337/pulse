#!/usr/bin/env fish
# Build the Pulse Flatpak into a signed OSTree repo and push it to the VPS, so a
# friend can `flatpak install` it once and then get new builds via `flatpak update`
# (or GNOME Software / KDE Discover, which auto-update Flatpaks in the background).
#
#   Prereq (once):  packaging/gen-signing-key.fish      → creates packaging/.gpg/
#   Each release:    packaging/publish.fish
#
# Serving (once, on the VPS): infra/prod/docker-compose.yml bind-mounts the repo
# dir into pulse_web and infra/prod/web-nginx.conf serves it under /flatpak/, so it
# ends up at https://howispulse.com/flatpak/  →  see packaging/README.md.
#
#   Friend installs:  flatpak install --user https://howispulse.com/flatpak/com.howispulse.Pulse.flatpakref
#   Friend updates:   flatpak update
#
# Web-only changes need NO new Flatpak — the packaged app loads howispulse.com
# remotely. Only native changes (electron/main|preload, the Python sidecar, the GSR
# binary) need a rebuild + republish.

set -l script_dir (dirname (status -f))
set -l repo_root (realpath $script_dir/..)
cd $repo_root

# ── config ──────────────────────────────────────────────────────────────────
set -l MANIFEST      packaging/com.howispulse.Pulse.yml
set -l BUILD_DIR     build/flatpak                       # flatpak-builder scratch (--force-clean'd)
set -l REPO_DIR      build/repo                          # local OSTree repo (archive-z2; persists across runs)
set -l GPG_HOME      packaging/.gpg
set -l VPS           michael@159.195.150.54
set -l VPS_REPO_PATH '~/pulse/flatpak-repo'              # host dir bind-mounted into pulse_web → /flatpak/
set -l REF_URL       'https://howispulse.com/flatpak/'
set -l RUNTIME_REPO  'https://dl.flathub.org/repo/flathub.flatpakrepo'

# ── signing key ─────────────────────────────────────────────────────────────
if not test -d $GPG_HOME
    echo "✗ no signing key at $GPG_HOME — run packaging/gen-signing-key.fish first"
    exit 1
end
set -l KEYID (gpg --homedir $GPG_HOME --list-keys --with-colons | awk -F: '/^fpr:/ {print $10; exit}')
if test -z "$KEYID"
    echo "✗ couldn't read a key fingerprint from $GPG_HOME"
    exit 1
end
echo "→ signing with key $KEYID"

# ── build into the repo ─────────────────────────────────────────────────────
echo "→ build:electron"
pnpm --filter @dcc/desktop build:electron; or exit 1

echo "→ flatpak-builder → $REPO_DIR  (FFmpeg/GSR come from .flatpak-builder cache)"
flatpak-builder --force-clean \
    --repo=$REPO_DIR \
    --gpg-sign=$KEYID --gpg-homedir=$GPG_HOME \
    $BUILD_DIR $MANIFEST
or begin
    echo "✗ flatpak-builder failed"
    exit 1
end

echo "→ build-update-repo  (static deltas → small incremental updates; prune old commits)"
flatpak build-update-repo \
    --generate-static-deltas --prune --prune-depth=3 \
    --gpg-sign=$KEYID --gpg-homedir=$GPG_HOME \
    $REPO_DIR
or begin
    echo "✗ build-update-repo failed"
    exit 1
end

# ── (re)generate the .flatpakref + .flatpakrepo with the current public key ──
# (idempotent — only changes if the key changes; the friend's first install reads
#  GPGKey from here and pins it, so it must match what build-update-repo signed with.)
set -l PUBKEY_B64 (gpg --homedir $GPG_HOME --export $KEYID | base64 -w0)
printf '%s\n' \
    '[Flatpak Ref]' \
    'Title=Pulse' \
    'Name=com.howispulse.Pulse' \
    'Branch=master' \
    "Url=$REF_URL" \
    'Homepage=https://howispulse.com' \
    "RuntimeRepo=$RUNTIME_REPO" \
    'IsRuntime=false' \
    "GPGKey=$PUBKEY_B64" \
    > $REPO_DIR/com.howispulse.Pulse.flatpakref
printf '%s\n' \
    '[Flatpak Repo]' \
    'Title=Pulse' \
    "Url=$REF_URL" \
    'Homepage=https://howispulse.com' \
    "GPGKey=$PUBKEY_B64" \
    > $REPO_DIR/pulse.flatpakrepo

# ── ship it ─────────────────────────────────────────────────────────────────
echo "→ rsync $REPO_DIR/ → $VPS:$VPS_REPO_PATH/"
rsync -a --delete $REPO_DIR/ $VPS:$VPS_REPO_PATH/
or begin
    echo "✗ rsync failed — is $VPS reachable and does $VPS_REPO_PATH exist?"
    echo "  (first time:  ssh $VPS 'mkdir -p $VPS_REPO_PATH')"
    exit 1
end

echo ""
echo "✓ published to https://howispulse.com/flatpak/"
echo "  friend installs:  flatpak install --user https://howispulse.com/flatpak/com.howispulse.Pulse.flatpakref"
echo "  friend updates:   flatpak update     (or GNOME Software / KDE Discover, automatically)"
