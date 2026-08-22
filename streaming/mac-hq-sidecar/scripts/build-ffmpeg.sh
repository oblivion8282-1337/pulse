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
# `--enable-libdav1d` is NOT optional, and it is about DECODING, not encoding
# (added 2026-08-20, when the native player started shipping on macOS too).
# Without it this build cannot decode AV1 AT ALL: FFmpeg's own `av1` decoder is
# a hardware stub — `-h decoder=av1` reports "Threading capabilities: none" and
# "Supported hardware devices: videotoolbox", i.e. VideoToolbox is its only
# backend. And VideoToolbox only gained an AV1 DECODER with M3. Measured on an
# M2 with this build before dav1d was added:
#   AV1 + -hwaccel videotoolbox → "Failed setup for format videotoolbox_vld …
#                                  Function not implemented"
#   AV1 without hwaccel         → "Conversion failed!", 0 frames
#   H.264 + videotoolbox        → fine, 60 frames at 16.7x
# That is not an edge case: Windows AMD hosts send AV1, because intra-refresh
# there rides on `av1_amf`. dav1d is BSD-2-Clause, so it does not touch the LGPL
# posture below.
#
# `--disable-xlib --disable-libxcb` keeps this build DETERMINISTIC, and that is
# the point — not the few hundred kilobytes. FFmpeg's configure enables whatever
# it happens to find, and pkg-config searches Homebrew's shared prefix no matter
# what PKG_CONFIG_PATH says. On 2026-08-20 that silently pulled libX11, libxcb,
# libXau and libXdmcp into the macOS bundle (some other formula had installed
# them), where X11 has no purpose whatsoever — and every one of them would have
# needed an attribution entry. A build that ships different libraries depending
# on what else the machine has installed is not a build you can redistribute
# with confidence. Add `--disable-` for anything not deliberately wanted.
#
# Output: shared dylibs in $PREFIX/lib. `streaming/mac-hq-sidecar/.cargo/config.toml`
# points PKG_CONFIG_PATH at $PREFIX/lib/pkgconfig (default ~/src/ffmpeg-openssl).
# Override the install location with PREFIX=… if you keep the config.toml in sync.
#
# Requires: Xcode CLT, Homebrew openssl@3 + opus + dav1d (headers/libs), curl, tar.
set -euo pipefail

VER="${FFMPEG_VERSION:-8.0.1}"
PREFIX="${PREFIX:-$HOME/src/ffmpeg-openssl}"
WORK="${WORK:-$HOME/src}"
SRC="$WORK/ffmpeg-$VER"
TARBALL="$WORK/ffmpeg-$VER.tar.xz"

# openssl@3 + opus pkgconfig so configure resolves --enable-openssl/--enable-libopus.
export PKG_CONFIG_PATH="$(brew --prefix openssl@3)/lib/pkgconfig:$(brew --prefix opus)/lib/pkgconfig:$(brew --prefix dav1d)/lib/pkgconfig"

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
  --enable-libdav1d \
  --disable-xlib --disable-libxcb \
  --disable-ffplay --disable-doc --disable-debug \
  --enable-neon

make -j"$(sysctl -n hw.ncpu)"
rm -rf "$PREFIX"
make install

echo "✓ done. TLS/codec sanity:"
"$PREFIX/bin/ffmpeg" -version | sed -n '1p'
"$PREFIX/bin/ffmpeg" -version | tr ' ' '\n' | grep -E 'openssl|securetransport|videotoolbox|libopus|libdav1d' || true
# AV1 decode is the one that silently degrades: without libdav1d the `av1`
# decoder is present but cannot decode a single frame on pre-M3 hardware
# (see the header). Fail loudly here rather than in a viewer's black window.
#
# `grep -c`, NOT `grep -q`: under `set -o pipefail` a `-q` exits at the first
# match, ffmpeg gets SIGPIPE, and the pipeline reports failure even though the
# decoder was found. That cost a false alarm on the very first run of this check.
DECODERS="$("$PREFIX/bin/ffmpeg" -hide_banner -decoders 2>/dev/null || true)"
case "$DECODERS" in
  *libdav1d*) : ;;
  *) echo "✗ libdav1d missing — AV1 would not decode on M1/M2 (see header). Is 'brew install dav1d' present, and was PKG_CONFIG_PATH set for it?" >&2
     exit 1 ;;
esac

# Nothing unexpected may have crept in. `bundle-dylibs.sh` copies whatever these
# dylibs reference, so a stray dependency here ends up in the shipped DMG and in
# the attribution file. See the xlib note in the header for how that happened.
STRAYS="$(otool -L "$PREFIX"/lib/libav*.dylib 2>/dev/null \
  | grep -oE '/[^ ]*/lib(X11|xcb|Xau|Xdmcp|x264|x265|vpx|fdk)[^ ]*' | sort -u || true)"
if [ -n "$STRAYS" ]; then
  echo "✗ unexpected dependencies linked into this FFmpeg:" >&2
  echo "$STRAYS" | sed 's/^/    /' >&2
  echo "  configure enabled something it found on this machine. Add the matching --disable- flag." >&2
  exit 1
fi
echo "✓ no stray X11/GPL-codec dependencies"
