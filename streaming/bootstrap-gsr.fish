#!/usr/bin/env fish
# Baut GSR aus dem git-master Source (Version 5.13.5+).
# Nötig für SRT-Push mit Opus-Audio (System-AUR ist auf 5.13.4 — kein ts-Opus).
#
# Custom-Binary landet in /tmp/gsr-analysis/gpu-screen-recorder/build/gpu-screen-recorder
# start-stream-server-srt.fish nutzt diesen Pfad automatisch (mit Fallback auf System-Binary).

set source_dir /tmp/gsr-analysis/gpu-screen-recorder

# Build-Tools sicherstellen
for tool in meson ninja gcc pkg-config git
    if not command -v $tool >/dev/null 2>&1
        echo "✗ $tool fehlt — installiere mit: sudo pacman -S $tool"
        exit 1
    end
end

# Source holen falls nicht da
if not test -d $source_dir
    echo "→ Clone Source nach $source_dir"
    mkdir -p (dirname $source_dir)
    git clone --depth=1 https://repo.dec05eba.com/gpu-screen-recorder $source_dir
end

cd $source_dir

# Update auf neuesten master
echo "→ Update Source auf neuesten master ..."
git pull 2>/dev/null

# Version-Check
set version (grep '^version' project.conf | cut -d'"' -f2)
echo "→ Source-Version: $version"
if test "$version" = "5.13.4" -o "$version" = "5.13.3" -o "$version" = "5.13.2"
    echo "⚠️  Source-Version ist nicht ≥ 5.13.5 — Opus-für-ts wahrscheinlich noch nicht drin"
    echo "    Build trotzdem fortsetzen? (y/N)"
    read confirm
    test "$confirm" = "y" -o "$confirm" = "Y"; or exit 1
end

# Patches anwenden (idempotent, --forward = überspringt wenn schon drin)
echo ""
echo "→ Patches anwenden ..."
set repo_dir (dirname (status -f))
for patch_file in $repo_dir/patches/*.patch
    if test -f $patch_file
        echo "  → "(basename $patch_file)
        patch -p1 -N --forward --silent < $patch_file 2>&1 | grep -v "Reversed\|Skipping" | head -3
    end
end

# Build
echo ""
echo "→ meson setup ..."
rm -rf build
meson setup build --buildtype=release > /dev/null
echo "→ Compiling (kann 1-2 Min dauern) ..."
meson compile -C build 2>&1 | tail -3

if test -x build/gpu-screen-recorder
    echo ""
    echo "✓ Build erfolgreich:"
    echo "  $source_dir/build/gpu-screen-recorder"
    ./build/gpu-screen-recorder --version | head -1 | xargs -I {} echo "  Version: {}"

    # Whitelist-Checks
    if strings build/gpu-screen-recorder | grep -q "and .ts and .flv"
        echo "  ✓ Opus-Whitelist mit .ts UND .flv — AV1+RTMP und SRT+Opus beide ok"
    else if strings build/gpu-screen-recorder | grep -q "and .ts files"
        echo "  ⚠ Opus-für-ts ja, aber .flv-Patch fehlt — AV1+Enhanced-RTMP fällt auf AAC"
    else
        echo "  ✗ Opus-Whitelist hat weder .ts noch .flv — Source-Version zu alt"
    end
else
    echo "✗ Build fehlgeschlagen"
    exit 1
end
