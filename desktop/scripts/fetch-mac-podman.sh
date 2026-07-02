#!/usr/bin/env bash
# Lädt die drei Podman-Bausteine für das Mac-App-Hosting SHA-gepinnt nach
# desktop/resources-podman-mac/ (electron-builder packt sie nach
# Contents/Resources/podman/, wo containerRuntime.ts sie findet):
#   podman  — Remote-Client (aus dem offiziellen darwin_arm64-Release-Zip)
#   gvproxy — Machine-Netzwerk (containers/gvisor-tap-vsock)
#   vfkit   — Apple-Virtualisierung (crc-org/vfkit, signiert MIT
#             com.apple.security.virtualization-Entitlement — deshalb das
#             'vfkit'-Asset nehmen, NIE 'vfkit-unsigned'; afterPack's
#             --deep-Signierung fasst lose Resources-Binaries nicht an,
#             die Upstream-Signatur samt Entitlement bleibt erhalten)
#
# Läuft im dist:mac-Flow (siehe package.json). Idempotent: vorhandene Dateien
# mit korrektem Hash werden nicht neu geladen. Versionen zusammen mit den
# SHAs bumpen (re-hashen von den offiziellen Releases). Apple-Silicon-only —
# ein Intel-Build bräuchte die amd64-Pendants.
set -euo pipefail
cd "$(dirname "$0")/../resources-podman-mac"

PODMAN_VER=5.8.4
GVPROXY_VER=v0.8.9
VFKIT_VER=v0.6.3
SHA_PODMAN_ZIP=f71982247a47d4aac2bef11b5787a7d58670c8874bb13b8d4869f6a8963fefcb
SHA_GVPROXY=c6f7b4bc7f21bf810b5cf54e04d979b014c5d96472a03a9e97fe62a00940067c
SHA_VFKIT=19d0695d40d996ec38529a22b73cdaa84ff67ba15f4b44927292e7fe885cee0e

# macOS: shasum (perl, immer da); Linux-Dev-Maschinen: sha256sum als Fallback.
_sha() {
    if command -v shasum >/dev/null; then shasum -a 256 "$1" | cut -d' ' -f1
    else sha256sum "$1" | cut -d' ' -f1; fi
}

_fetch() { # $1 url  $2 ziel  $3 sha
    if [ -f "$2" ] && [ "$(_sha "$2")" = "$3" ]; then
        echo "[mac-podman] $2 vorhanden (Hash ok)"
        return
    fi
    curl -fsSL -o "$2" "$1"
    actual=$(_sha "$2")
    if [ "$actual" != "$3" ]; then
        echo "[mac-podman] FEHLER: SHA-Mismatch für $2 ($actual)" >&2
        rm -f "$2"
        exit 1
    fi
    echo "[mac-podman] $2 geladen + verifiziert"
}

if [ ! -f podman ] || [ ! -f .podman-ver ] || [ "$(cat .podman-ver)" != "$PODMAN_VER" ]; then
    _fetch "https://github.com/containers/podman/releases/download/v${PODMAN_VER}/podman-remote-release-darwin_arm64.zip" podman.zip "$SHA_PODMAN_ZIP"
    # Nur das podman-Binary aus dem Zip (podman-mac-helper brauchen wir nicht).
    unzip -p podman.zip "podman-${PODMAN_VER}/usr/bin/podman" > podman
    rm -f podman.zip
    echo "$PODMAN_VER" > .podman-ver
    echo "[mac-podman] podman ${PODMAN_VER} extrahiert"
fi

_fetch "https://github.com/containers/gvisor-tap-vsock/releases/download/${GVPROXY_VER}/gvproxy-darwin" gvproxy "$SHA_GVPROXY"
_fetch "https://github.com/crc-org/vfkit/releases/download/${VFKIT_VER}/vfkit" vfkit "$SHA_VFKIT"

chmod +x podman gvproxy vfkit
echo "[mac-podman] bereit: $(ls -m podman gvproxy vfkit)"
