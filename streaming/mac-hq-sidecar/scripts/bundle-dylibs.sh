#!/bin/bash
# Make the macOS HQ sidecar self-contained for distribution.
#
# The release binary links our private FFmpeg (+ openssl/opus) by absolute path
# (~/src/ffmpeg-openssl/lib, /opt/homebrew/...), which only exists on the build
# machine. This recursively copies every non-system dylib it needs next to the
# binary and rewrites all install-names to @loader_path, so the folder is
# portable — electron-builder ships it as Resources/hq-sidecar/ and the sidecar
# loads the libs from beside itself on any Mac.
#
# Apple-Silicon note: install_name_tool invalidates a Mach-O's signature, and
# arm64 SIGKILLs unsigned/invalid binaries — so every modified file is re-signed
# ad-hoc (`codesign -s -`). That's enough to *run*; Gatekeeper still shows the
# "unverified developer" prompt on first open (we ship unsigned by choice).
#
# Usage: bundle-dylibs.sh <output-dir> <binary> [more-binaries...]
#
# More than one binary shares ONE set of dylibs: the player and the sidecar
# link the same private FFmpeg and both ship in Resources/hq-sidecar/. The
# dedup below keys on file-existence in OUT, so the second binary finds the
# first one's dylibs already there and skips copying them. Argument order was
# <binary> <outdir> until 2026-08-20 — it had to flip for the variadic tail.
set -euo pipefail

OUT="${1:?usage: bundle-dylibs.sh <outdir> <binary> [more...]}"
shift
[ "$#" -ge 1 ] || { echo "usage: bundle-dylibs.sh <outdir> <binary> [more...]" >&2; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT"

# Copy every binary in first, then scan them all — a single queue, one dylib set.
queue=()
for bin in "$@"; do
  [ -f "$bin" ] || { echo "not found: $bin" >&2; exit 1; }
  name="$(basename "$bin")"
  cp -f "$bin" "$OUT/$name"
  chmod u+w "$OUT/$name"
  queue+=("$OUT/$name")
done

is_system() {
  case "$1" in
    /usr/lib/*|/System/*|@*) return 0 ;;
    *) return 1 ;;
  esac
}

# Worklist of Mach-O files (inside OUT) to scan. Dedup by file-existence in OUT
# (a dylib already copied there has been queued too) — keeps this compatible
# with the macOS system bash 3.2 (no associative arrays).
i=0
while [ "$i" -lt "${#queue[@]}" ]; do
  f="${queue[$i]}"; i=$((i + 1))
  # otool -L: line 1 is the file header (`path:`) → skip; the rest are deps
  # (a dylib's own id is among them and, once rewritten to @…, is skipped).
  while read -r dep; do
    [ -z "$dep" ] && continue
    is_system "$dep" && continue
    base="$(basename "$dep")"
    if [ ! -f "$OUT/$base" ]; then
      cp -f "$dep" "$OUT/$base"
      chmod u+w "$OUT/$base"
      install_name_tool -id "@loader_path/$base" "$OUT/$base"
      queue+=("$OUT/$base")
    fi
    install_name_tool -change "$dep" "@loader_path/$base" "$f"
  done < <(otool -L "$f" | tail -n +2 | awk '{print $1}')
done

# Re-sign everything ad-hoc (required to run on Apple Silicon after edits).
for f in "$OUT"/*; do
  codesign --force --sign - --timestamp=none "$f" 2>/dev/null || codesign --force --sign - "$f"
done

echo "✓ bundled $(ls "$OUT" | wc -l | tr -d ' ') files into $OUT"
for bin in "$@"; do
  name="$(basename "$bin")"
  echo "--- $name deps (should be @loader_path / system only) ---"
  otool -L "$OUT/$name" | tail -n +2 | awk '{print "  "$1}'
done
