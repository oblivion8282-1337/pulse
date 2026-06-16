#!/bin/bash
# Build the FFmpeg the macOS HQ sidecar links against.
#
# Two reasons we don't use Homebrew's FFmpeg:
#   1. TLS — Homebrew links Apple SecureTransport, which blocks on RTMPS bulk
#      writes after the handshake; MediaMTX then drops the publish on a 10s i/o
#      timeout (the original "macOS HQ stream never starts" failure). We build
#      with `--enable-openssl --disable-securetransport` → RTMPS works.
#   2. Licensing — Homebrew's build is GPL (x264/x265). This build is LGPL
#      (VideoToolbox covers H.264/HEVC encode, so no x264/x265), which is what
#      we can redistribute with bundled dylibs.
#
# Output: shared dylibs in $PREFIX/lib. `streaming/mac-hq-sidecar/.cargo/config.toml`
# points PKG_CONFIG_PATH at $PREFIX/lib/pkgconfig (default ~/src/ffmpeg-openssl).
# Override the install location with PREFIX=… if you keep the config.toml in sync.
#
# Requires: Xcode CLT, Homebrew openssl@3 + opus (for headers/libs), curl, tar.
set -euo pipefail

VER="${FFMPEG_VERSION:-8.0.1}"
PREFIX="${PREFIX:-$HOME/src/ffmpeg-openssl}"
WORK="${WORK:-$HOME/src}"
SRC="$WORK/ffmpeg-$VER"
TARBALL="$WORK/ffmpeg-$VER.tar.xz"

# openssl@3 + opus pkgconfig so configure resolves --enable-openssl/--enable-libopus.
export PKG_CONFIG_PATH="$(brew --prefix openssl@3)/lib/pkgconfig:$(brew --prefix opus)/lib/pkgconfig"

echo "→ FFmpeg $VER  →  prefix $PREFIX"
mkdir -p "$WORK"
[ -f "$TARBALL" ] || curl -fSL "https://ffmpeg.org/releases/ffmpeg-$VER.tar.xz" -o "$TARBALL"
rm -rf "$SRC"; mkdir -p "$SRC"; tar -xf "$TARBALL" -C "$WORK"

cd "$SRC"
./configure \
  --prefix="$PREFIX" \
  --enable-shared --disable-static \
  --enable-openssl --disable-securetransport \
  --enable-videotoolbox --enable-audiotoolbox \
  --enable-libopus \
  --disable-ffplay --disable-doc --disable-debug \
  --enable-neon

make -j"$(sysctl -n hw.ncpu)"
rm -rf "$PREFIX"
make install

echo "✓ done. TLS/codec sanity:"
"$PREFIX/bin/ffmpeg" -version | sed -n '1p'
"$PREFIX/bin/ffmpeg" -version | tr ' ' '\n' | grep -E 'openssl|securetransport|videotoolbox|libopus' || true
