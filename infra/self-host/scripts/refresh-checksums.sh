#!/usr/bin/env bash
# Refresh / re-verify the SHA-256 checksums of all bundled third-party
# binaries in infra/self-host/Dockerfile.
#
# Three modes:
#
#   1. Re-verify (no flags)
#        ./refresh-checksums.sh
#      Downloads every binary pinned in the Dockerfile, hashes it, compares
#      against the SHA256_* ARG values. Exits 0 if all match, 1 if any
#      mismatch (and prints a diff).
#
#   2. Update existing pins (--write)
#        ./refresh-checksums.sh --write
#      Same downloads + hashing as re-verify, but when a hash changes, the
#      Dockerfile is rewritten in place. Useful when upstream silently
#      republished a tarball under the same version (and you have audited
#      that the change is legitimate).
#
#   3. Version bump (--set NAME=VERSION ..., implies --write)
#        ./refresh-checksums.sh --set CADDY_VERSION=2.9.0
#        ./refresh-checksums.sh --set CADDY_VERSION=2.9.0 --set LIVEKIT_VERSION=1.9.0
#      Rewrites the ARG <NAME>=<VERSION> line, then downloads the new
#      tarballs, recomputes all relevant SHA-256 pins, and rewrites them.
#
# Exit codes:
#   0  ok (verify match, or update completed)
#   1  network / download / hash error, or verify mismatch in mode 1
#   2  invalid CLI usage

set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────
# Locate the Dockerfile relative to this script (no matter where it's run
# from).
# ──────────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
DOCKERFILE="$(cd -- "${SCRIPT_DIR}/.." && pwd)/Dockerfile"

if [[ ! -f "${DOCKERFILE}" ]]; then
    echo "error: Dockerfile not found at ${DOCKERFILE}" >&2
    exit 1
fi

# ──────────────────────────────────────────────────────────────────────────
# CLI parsing
# ──────────────────────────────────────────────────────────────────────────
WRITE=0
declare -A VERSION_OVERRIDES=()

usage() {
    sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
    exit "${1:-2}"
}

while (( $# > 0 )); do
    case "$1" in
        --write)
            WRITE=1
            shift
            ;;
        --set)
            if [[ $# -lt 2 || "$2" != *=* ]]; then
                echo "error: --set requires NAME=VERSION" >&2
                exit 2
            fi
            key="${2%%=*}"
            val="${2#*=}"
            if [[ -z "$key" || -z "$val" ]]; then
                echo "error: --set: both NAME and VERSION must be non-empty (got '$2')" >&2
                exit 2
            fi
            VERSION_OVERRIDES[$key]="$val"
            WRITE=1
            shift 2
            ;;
        -h|--help)
            usage 0
            ;;
        *)
            echo "error: unknown argument '$1'" >&2
            usage 2
            ;;
    esac
done

# ──────────────────────────────────────────────────────────────────────────
# Read current ARG values from the Dockerfile
#   read_arg NAME → echo's the value, or empty string if not found
# ──────────────────────────────────────────────────────────────────────────
read_arg() {
    local name="$1"
    grep -E "^ARG ${name}=" "${DOCKERFILE}" | head -n1 | sed -E "s/^ARG ${name}=//"
}

S6_OVERLAY_VERSION="$(read_arg S6_OVERLAY_VERSION)"
CADDY_VERSION="$(read_arg CADDY_VERSION)"
LIVEKIT_VERSION="$(read_arg LIVEKIT_VERSION)"
MEDIAMTX_VERSION="$(read_arg MEDIAMTX_VERSION)"

# Apply --set overrides
for key in "${!VERSION_OVERRIDES[@]}"; do
    case "$key" in
        S6_OVERLAY_VERSION) S6_OVERLAY_VERSION="${VERSION_OVERRIDES[$key]}" ;;
        CADDY_VERSION)      CADDY_VERSION="${VERSION_OVERRIDES[$key]}" ;;
        LIVEKIT_VERSION)    LIVEKIT_VERSION="${VERSION_OVERRIDES[$key]}" ;;
        MEDIAMTX_VERSION)   MEDIAMTX_VERSION="${VERSION_OVERRIDES[$key]}" ;;
        *)
            echo "error: --set: unknown version name '$key'" >&2
            echo "       valid: S6_OVERLAY_VERSION CADDY_VERSION LIVEKIT_VERSION MEDIAMTX_VERSION" >&2
            exit 2
            ;;
    esac
done

# Validate we got everything
for var in S6_OVERLAY_VERSION CADDY_VERSION LIVEKIT_VERSION MEDIAMTX_VERSION; do
    if [[ -z "${!var}" ]]; then
        echo "error: ${var} not set (Dockerfile parse failed?)" >&2
        exit 1
    fi
done

# ──────────────────────────────────────────────────────────────────────────
# Download targets: name → URL. Each entry produces one SHA256_<NAME> pin.
# ──────────────────────────────────────────────────────────────────────────
declare -A URLS=(
    [S6_NOARCH]="https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz"
    [S6_X86_64]="https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-x86_64.tar.xz"
    [S6_AARCH64]="https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-aarch64.tar.xz"
    [CADDY_AMD64]="https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_amd64.tar.gz"
    [CADDY_ARM64]="https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_arm64.tar.gz"
    [LIVEKIT_AMD64]="https://github.com/livekit/livekit/releases/download/v${LIVEKIT_VERSION}/livekit_${LIVEKIT_VERSION}_linux_amd64.tar.gz"
    [LIVEKIT_ARM64]="https://github.com/livekit/livekit/releases/download/v${LIVEKIT_VERSION}/livekit_${LIVEKIT_VERSION}_linux_arm64.tar.gz"
    [MEDIAMTX_AMD64]="https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}/mediamtx_v${MEDIAMTX_VERSION}_linux_amd64.tar.gz"
    [MEDIAMTX_ARM64]="https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}/mediamtx_v${MEDIAMTX_VERSION}_linux_arm64.tar.gz"
)

# Iteration order is stable (we sort the keys) so log output is reproducible.
NAMES=(S6_NOARCH S6_X86_64 S6_AARCH64 CADDY_AMD64 CADDY_ARM64 LIVEKIT_AMD64 LIVEKIT_ARM64 MEDIAMTX_AMD64 MEDIAMTX_ARM64)

# ──────────────────────────────────────────────────────────────────────────
# Download + hash each binary into a temp dir, capture results.
#
# WORK_DIR lives next to the Dockerfile (not in /tmp) so the final `mv` is
# same-filesystem and atomic. On many setups /tmp is tmpfs while the repo is
# on disk — cross-device mv falls back to cp+unlink, which is not atomic.
# ──────────────────────────────────────────────────────────────────────────
WORK_DIR="$(mktemp -d "$(dirname "${DOCKERFILE}")/.refresh-checksums-XXXXXX")"
trap 'rm -rf "${WORK_DIR}"' EXIT

declare -A NEW_HASHES=()
declare -A OLD_HASHES=()

echo "Versions:"
echo "  S6_OVERLAY_VERSION = ${S6_OVERLAY_VERSION}"
echo "  CADDY_VERSION      = ${CADDY_VERSION}"
echo "  LIVEKIT_VERSION    = ${LIVEKIT_VERSION}"
echo "  MEDIAMTX_VERSION   = ${MEDIAMTX_VERSION}"
echo
echo "Downloading + hashing ${#NAMES[@]} binaries..."
echo

for name in "${NAMES[@]}"; do
    url="${URLS[$name]}"
    out="${WORK_DIR}/${name}.bin"
    printf "  %-15s  " "${name}"
    if ! curl -fsSL --retry 3 --retry-delay 2 -o "${out}" "${url}"; then
        echo "FAILED (download)"
        echo "    url: ${url}" >&2
        exit 1
    fi
    hash="$(sha256sum "${out}" | awk '{print $1}')"
    NEW_HASHES[$name]="${hash}"
    OLD_HASHES[$name]="$(read_arg "SHA256_${name}")"
    if [[ -z "${OLD_HASHES[$name]}" ]]; then
        echo "${hash}  (new pin)"
    elif [[ "${OLD_HASHES[$name]}" == "${hash}" ]]; then
        echo "${hash}  match"
    else
        echo "${hash}  CHANGED"
        echo "      old: ${OLD_HASHES[$name]}" >&2
    fi
done

# ──────────────────────────────────────────────────────────────────────────
# Compute diff: which pins changed?
# ──────────────────────────────────────────────────────────────────────────
CHANGED=()
for name in "${NAMES[@]}"; do
    if [[ "${OLD_HASHES[$name]}" != "${NEW_HASHES[$name]}" ]]; then
        CHANGED+=("$name")
    fi
done

echo

if (( ${#CHANGED[@]} == 0 )) && (( ${#VERSION_OVERRIDES[@]} == 0 )); then
    echo "✓ All ${#NAMES[@]} pins match — Dockerfile is in sync with upstream."
    exit 0
fi

# ──────────────────────────────────────────────────────────────────────────
# Re-verify mode (no --write): mismatch is an error.
# ──────────────────────────────────────────────────────────────────────────
if (( WRITE == 0 )); then
    echo "✗ ${#CHANGED[@]} pin(s) differ from the Dockerfile:" >&2
    for name in "${CHANGED[@]}"; do
        echo "    SHA256_${name}: ${OLD_HASHES[$name]} → ${NEW_HASHES[$name]}" >&2
    done
    echo >&2
    echo "If upstream legitimately republished the artifact (rare!), audit the" >&2
    echo "change, then re-run with --write to update the pins." >&2
    exit 1
fi

# ──────────────────────────────────────────────────────────────────────────
# Write mode: update Dockerfile in place via atomic rewrite.
# We update ARGs by exact line-anchored sed; never substring matching that
# might catch another similarly-named arg.
# ──────────────────────────────────────────────────────────────────────────
TMP_DOCKERFILE="${WORK_DIR}/Dockerfile.new"
cp "${DOCKERFILE}" "${TMP_DOCKERFILE}"

# 1. Rewrite ARG <NAME>_VERSION lines for any --set overrides
for key in "${!VERSION_OVERRIDES[@]}"; do
    val="${VERSION_OVERRIDES[$key]}"
    # sed -i works in-file; instead we rewrite the temp file (portable across BSD/GNU).
    sed -E "s|^ARG ${key}=.*$|ARG ${key}=${val}|" "${TMP_DOCKERFILE}" > "${TMP_DOCKERFILE}.tmp"
    mv "${TMP_DOCKERFILE}.tmp" "${TMP_DOCKERFILE}"
done

# 2. Rewrite each SHA256_<NAME> line
for name in "${CHANGED[@]}"; do
    sed -E "s|^ARG SHA256_${name}=.*$|ARG SHA256_${name}=${NEW_HASHES[$name]}|" "${TMP_DOCKERFILE}" > "${TMP_DOCKERFILE}.tmp"
    mv "${TMP_DOCKERFILE}.tmp" "${TMP_DOCKERFILE}"
done

# 3. Sanity-check: did we actually substitute the expected number of lines?
# `grep -c` exits 1 when no lines match; under `set -e` that would abort the
# script silently before we ever check expected vs actual. `|| true` keeps
# the sanity check active even in the zero-change edge case (which then
# fails the assertion below — exactly what we want).
expected_changes=$(( ${#CHANGED[@]} + ${#VERSION_OVERRIDES[@]} ))
actual_changes=$(diff "${DOCKERFILE}" "${TMP_DOCKERFILE}" | { grep -cE '^[<>]' || true; } | awk '{print $1/2}')
if [[ "${actual_changes%.*}" != "${expected_changes}" ]]; then
    echo "error: expected ${expected_changes} line changes, got ${actual_changes%.*}" >&2
    echo "       refusing to overwrite the Dockerfile — inspect ${TMP_DOCKERFILE}" >&2
    cp "${TMP_DOCKERFILE}" "/tmp/Dockerfile.refresh-checksums.failed"
    echo "       a copy has been saved to /tmp/Dockerfile.refresh-checksums.failed" >&2
    exit 1
fi

# 4. Atomic rename into place
mv "${TMP_DOCKERFILE}" "${DOCKERFILE}"

echo "✓ Dockerfile updated:"
for key in "${!VERSION_OVERRIDES[@]}"; do
    echo "    ARG ${key}=${VERSION_OVERRIDES[$key]}"
done
for name in "${CHANGED[@]}"; do
    echo "    ARG SHA256_${name}=${NEW_HASHES[$name]}"
done
echo
echo "Review the diff:  git diff infra/self-host/Dockerfile"
