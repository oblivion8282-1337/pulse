#!/usr/bin/env bash
# Baut FFmpeg n8.1 aus der Quelle — mit dem hwcontext_cuda-Patch, der
# x2rgb10le/x2bgr10le als sw_format für CUDA-Frames freigibt.
#
# WARUM ES DAS GIBT. Der H1-Direktpfad (10-bit-RGB direkt an av1_nvenc,
# `encode/nv_import.rs::StagingFormat::Rgb10`) braucht einen CUDA-Frame-Pool
# mit sw_format=x2bgr10le. Die BtbN-Distribution (fetch-ffmpeg-linux.sh) hat
# dafür noch die statische Allowlist in libavutil/hwcontext_cuda.c — der Pool
# lehnt das Format mit rc=-38 ab (gemessen 2026-07-26). Upstream hat die
# Allowlist am 2026-07-22 komplett entfernt (`2cf3f4d6`, „hwcontext_cuda:
# remove format allowlist, accept any pixel format"); der Commit ist in keinem
# Release unter 9.1 und baut auf der CUarray-Serie auf — ein Roh-Cherry-Pick
# auf n8.1 appliert nicht. Der Patch hier ist der kleine Handport: nur die
# beiden Formate in die Allowlist, sonst nichts.
#
# Ablauf (Stand 2026-09-12, auf der RTX-4090-Maschine verifiziert):
#   ./build-ffmpeg-linux.sh
#   # danach den Sidecar damit bauen:
#   PATH=$HOME/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin:$PATH \
#     PKG_CONFIG_PATH=$PWD/ffmpeg-dist/n8.1-patched/lib/pkgconfig \
#     FFMPEG_DIR=$PWD/ffmpeg-dist/n8.1-patched cargo build --release
#
# Fallstricke, alle einmal gelebt:
# * ffnvcodec-Header 13.x brechen nvenc.c von n8.1 (`countingTypeLSB`) —
#   deshalb nv-codec-headers n12.2.72.0 LOKAL nach $PREFIX-sdk, nicht das
#   System-Paket (13.1.15 auf CachyOS).
# * Ohne TLS kann libavformat kein rtmps — der RTMPS-Push zum MediaMTX stirbt
#   mit „Protocol not found". --enable-gnutls (LGPL-sauber, honorierd auch
#   `tls_verify=0` des Sidecars); --enable-version3+openssl wäre der andere Weg.
# * --enable-cuda-llvm braucht clang; damit wird scale_cuda gebaut (Parität
#   zur BtbN-Distribution, der Sidecar selbst braucht es nicht).
set -euo pipefail

VERSION="n8.1"
SDK="n12.2.72.0"
hier="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
arbeit="${TMPDIR:-/tmp}/ffmpeg-n8.1-patched-build"
ziel="$hier/ffmpeg-dist/n8.1-patched"

mkdir -p "$arbeit"
cd "$arbeit"

[ -f ffmpeg-8.1.tar.xz ] || curl -fsSL --retry 3 -o ffmpeg-8.1.tar.xz \
    "https://ffmpeg.org/releases/ffmpeg-8.1.tar.xz"
[ -d ffmpeg-8.1 ] || tar xJf ffmpeg-8.1.tar.xz

# nv-codec-headers 12.2 lokal installieren (kein sudo, eigener Prefix).
[ -d nv-codec-headers-${SDK} ] || {
    curl -fsSL --retry 3 -o nvhdr.tar.gz \
        "https://github.com/FFmpeg/nv-codec-headers/archive/refs/tags/${SDK}.tar.gz"
    tar xzf nvhdr.tar.gz
}
make -C nv-codec-headers-${SDK} install PREFIX="$arbeit/sdk" >/dev/null

cd ffmpeg-8.1
# DER Patch: die zwei gepackten 10-bit-RGB-Formate in die Allowlist
# (Handport von 2cf3f4d6; auf n8.1 genügt das, die übrigen Änderungen des
# Upstream-Commits betreffen CUarray und den Testlauf).
grep -q "AV_PIX_FMT_X2BGR10LE" libavutil/hwcontext_cuda.c || sed -i \
    's/^    AV_PIX_FMT_BGR32,$/    AV_PIX_FMT_BGR32,\n    AV_PIX_FMT_X2RGB10LE,\n    AV_PIX_FMT_X2BGR10LE,/' \
    libavutil/hwcontext_cuda.c
grep -q "AV_PIX_FMT_X2BGR10LE" libavutil/hwcontext_cuda.c

PKG_CONFIG_PATH="$arbeit/sdk/lib/pkgconfig" ./configure \
    --prefix="$ziel" \
    --enable-shared --disable-static --disable-debug --disable-doc \
    --enable-ffnvcodec --enable-nvenc \
    --enable-vaapi --enable-libdrm \
    --enable-cuda-llvm --enable-gnutls
make -j"$(nproc)"
make install

echo
echo "Fertig: $ziel"
echo "Gegenprobe: LD_LIBRARY_PATH=$ziel/lib $ziel/bin/ffmpeg -hide_banner -f lavfi -i testsrc2=size=640x360:rate=60 -t 1 -init_hw_device cuda=cu:0 -filter_hw_device cu -vf format=x2bgr10le,hwupload -c:v av1_nvenc -f null -"
