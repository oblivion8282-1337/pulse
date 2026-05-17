#!/usr/bin/env fish
# Baut GSR aus dem git-Source mit unseren beiden Patches angewendet —
# das lokale Binary-Pendant zum Flatpak-`gpu-screen-recorder`.
#
# Custom-Binary landet in $XDG_CACHE_HOME/pulse/gsr/gpu-screen-recorder/build/
# (default $HOME/.cache/pulse/gsr/...) und wird vom Sidecar-Resolver
# (gsr_binary.py) vor dem System-Binary bevorzugt. Persistenter Pfad —
# überlebt Reboots, anders als der frühere /tmp-Buildplatz.

# ── Pinned upstream commit ─────────────────────────────────────────────────
# Muss exakt mit `packaging/com.unicutmedia.Pulse.yml` (gpu-screen-recorder
# Source-`commit:`) übereinstimmen, sonst baut der lokale Dev-Build was anderes
# als der ausgelieferte Flatpak. Die Patches sind zeilenanker-anhängig — gegen
# einen verschobenen HEAD schlagen sie still fehl. Wenn du bumpst, beide
# Stellen + ggf. die Patches refreshen (`patch -p1 --dry-run` gegen den neuen
# Commit prüfen).
set gsr_pinned_commit 0349083cfe4578dbc8bc600e31187e8e09318add

# XDG-Cache-Pfad — XDG_CACHE_HOME überschreibbar, sonst $HOME/.cache. Im
# Gegensatz zum früheren /tmp-Pfad bleibt das nach Reboot stehen, sodass der
# HQ-Stream-Button nach jedem Login direkt verfügbar ist.
if set -q XDG_CACHE_HOME; and test -n "$XDG_CACHE_HOME"
    set cache_root $XDG_CACHE_HOME
else
    set cache_root $HOME/.cache
end
set source_dir $cache_root/pulse/gsr/gpu-screen-recorder

# Migration: existing /tmp-Build einmal mitnehmen, falls jemand vor dem Move
# schon gebaut hat — spart einen Re-Clone. Symlink/Cp wäre fragil; einfach
# clobbern wenn der neue Pfad leer ist.
if not test -d $source_dir; and test -d /tmp/gsr-analysis/gpu-screen-recorder
    echo "→ Migriere alten /tmp-Build nach $source_dir"
    mkdir -p (dirname $source_dir)
    mv /tmp/gsr-analysis/gpu-screen-recorder $source_dir
end

# ── repo_dir VOR dem cd auflösen ───────────────────────────────────────────
# `status -f` kann ein relativer Pfad sein, wenn das Skript via `fish
# streaming/bootstrap-gsr.fish` (relativ) gestartet wird. Nach dem späteren
# `cd $source_dir` würde der relative Pfad ins Leere zeigen → die Patches-
# Glob matcht 0 Files → Patches werden still nie angewendet. `realpath` fixt
# das einmal hier oben.
set repo_dir (realpath (dirname (status -f)))

# Build-Tools sicherstellen
for tool in meson ninja gcc pkg-config git
    if not command -v $tool >/dev/null 2>&1
        echo "✗ $tool fehlt — installiere mit: sudo pacman -S $tool"
        exit 1
    end
end

# Source holen falls nicht da. Kein --depth=1: wir checken gleich einen
# spezifischen Commit aus, und das ist mit shallow clone unzuverlässig.
if not test -d $source_dir
    echo "→ Clone Source nach $source_dir"
    mkdir -p (dirname $source_dir)
    git clone https://repo.dec05eba.com/gpu-screen-recorder $source_dir
    or begin
        echo "✗ git clone fehlgeschlagen"
        exit 1
    end
end

cd $source_dir

# Pinned Commit holen + hart auschecken (verwirft eventuelle alte Patch-
# Modifikationen aus früheren bootstrap-Runs)
echo "→ Pin auf $gsr_pinned_commit ..."
git fetch --quiet origin $gsr_pinned_commit
or begin
    echo "✗ git fetch fehlgeschlagen — Commit existiert nicht im Remote?"
    exit 1
end
git reset --hard --quiet $gsr_pinned_commit
or begin
    echo "✗ git reset --hard fehlgeschlagen"
    exit 1
end

# Version-Echo (zur Info, kein Abbruch). `gsr_version` — NICHT `version`,
# letzteres ist eine read-only fish-builtin und würde mit `set` fehlschlagen.
set gsr_version (grep '^version' project.conf | cut -d'"' -f2)
echo "→ Source-Version: $gsr_version"

# Patches anwenden — laut scheitern statt still, sonst entsteht ein
# unpatched-Binary das funktioniert (sieht erfolgreich aus) aber ohne
# unsere Codec-/Whitelist-Erweiterungen läuft.
echo ""
echo "→ Patches anwenden ..."
for patch_file in $repo_dir/patches/*.patch
    if test -f $patch_file
        echo "  → "(basename $patch_file)
        patch -p1 < $patch_file
        or begin
            echo ""
            echo "✗ Patch fehlgeschlagen: "(basename $patch_file)
            echo "  Möglicherweise gegen den gepinnten Commit ($gsr_pinned_commit)"
            echo "  rebasen oder im Flatpak-Manifest synchron bumpen."
            exit 1
        end
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

    # Verifizieren dass die Patches im finalen Binary gelandet sind.
    # Suchstring `.ts and .flv` matcht ausschließlich den gepatchten
    # Warntext aus 0001-opus-flv-whitelist.patch.
    if strings build/gpu-screen-recorder | grep -q ".ts and .flv"
        echo "  ✓ FLV-Opus-Patch drin — AV1+Enhanced-RTMP mit Opus-Audio aktiv"
    else
        echo "  ✗ FLV-Opus-Patch FEHLT im Binary — etwas ist beim Patchen schief gegangen"
        exit 1
    end
else
    echo "✗ Build fehlgeschlagen"
    exit 1
end
