#!/usr/bin/env bash
# Baut das gepatchte FFmpeg, das Intra-Refresh ueber VA-API durchreicht.
#
# WARUM ES DAS GIBT: Intra-Refresh ist auf AMD und Intel die Betriebsart, die
# unter Paketverlust gewinnt (16,0 gegen 65,6 Prozent gestoerte Sekunden bei
# gleicher Datenrate, Messakte
# `streaming/testbench/profiles/amd-2026-08-01-intra-refresh-echter-sender.json`).
# Die Hardware kann es, der Treiber kann es — FFmpeg reicht es nicht durch, in
# KEINER Version, auch nicht in master. Begruendung und Beweiskette: README.md
# daneben.
#
# Ohne dieses FFmpeg bricht der Sidecar den Start ab, sobald Intra-Refresh
# verlangt wird (`encode/opts.rs::intra_refresh_pruefen`) — bewusst, denn still
# auf Keyframes zurueckzufallen hiesse, einen Keyframe-Strom unter dem Etikett
# der anderen Betriebsart zu fahren. Auf NVIDIA wird das Skript nicht gebraucht:
# `*_nvenc` hat die Option upstream.
#
# WOHIN: $XDG_CACHE_HOME/pulse/ffmpeg-intra-refresh/ (Standard
# ~/.cache/pulse/ffmpeg-intra-refresh/) — derselbe persistente Ort, den auch
# `streaming/bootstrap-gsr.fish` benutzt. NICHT nach /tmp: das ist auf dieser
# Maschine ein tmpfs, der Bau waere nach jedem Reboot weg.
#
# Das System-FFmpeg wird NICHT angefasst. `scripts/hq-bauen.sh` baut Sidecar und
# Player mit einem RPATH auf das Ergebnis hier — nur diese beiden Programme
# sehen das gepatchte FFmpeg, alles andere auf dem Rechner bleibt, wie es ist.
#
# LIZENZ: der Bau ist bewusst LGPL — kein `--enable-gpl`, kein libx264. Das ist
# die Bedingung aus dem Wurzel-`CLAUDE.md` (Pulse darf keinen GPL-Code linken)
# und dieselbe, unter der das Flatpak sein FFmpeg baut. `--enable-version3` ist
# Pflicht, sobald OpenSSL 3 dazukommt (Apache-2.0 vertraegt sich mit LGPLv3,
# nicht mit v2.1).
set -euo pipefail

# Derselbe Stand, den das Flatpak pinnt (packaging/com.howispulse.Pulse.yml,
# ffmpeg-Modul). Dev und Auslieferung sollen denselben Quelltext patchen —
# sonst gilt eine hier gemessene Zahl fuer die ausgelieferte App nicht.
VERSION="n9.0"
# Derselbe Commit, den das Flatpak-Manifest nennt. Er steht hier ZUSAETZLICH
# zum Tag, weil ein flacher Klon den Tag nicht peelen kann ("refs/tags/n9.0
# ist kein Commit") — ein `reset --hard n9.0` beim zweiten Lauf scheitert
# daran. Auf den Commit zurueckzusetzen geht immer.
COMMIT="d32b387f2b0a484599d4587d651891f0c63c4238"
REPO="https://github.com/FFmpeg/FFmpeg.git"

hier="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$hier/../.." && pwd)"
cache_root="${XDG_CACHE_HOME:-$HOME/.cache}"
wurzel="$cache_root/pulse/ffmpeg-intra-refresh"
quelle="$wurzel/src"
prefix="$wurzel/prefix"

# Schon gebaut? Dann nichts tun. Die Pruefung sitzt HIER und nicht beim
# Aufrufer, weil hier der Pfad ohnehin steht — sonst muesste jeder Aufrufer ihn
# selbst herleiten und bei einem Umzug mitwandern.
if [ -x "$prefix/bin/ffmpeg" ] && [ "${PULSE_FFMPEG_NEUBAU:-0}" != "1" ]; then
    echo "==> Gepatchtes FFmpeg liegt schon da ($prefix)"
    echo "    Neu bauen:  PULSE_FFMPEG_NEUBAU=1 $0"
    exit 0
fi

# --- Quelltext holen und patchen -------------------------------------------
echo "==> FFmpeg $VERSION holen und patchen (flacher Klon, ~100 MB)"
. "$repo_root/scripts/lib/gepatchter-klon.sh"
gepatchter_klon "$REPO" "$VERSION" "$quelle" "$hier" "$COMMIT"

# --- Konfigurieren ----------------------------------------------------------
#
# Bewusst NAH am Flatpak-Bau, aber nicht identisch. Zwei Unterschiede, beide
# mit Grund:
#
#   * Decoder bleiben AN. Das Flatpak schaltet sie ab (`--disable-decoders`),
#     weil dort bisher nur encodiert wurde. Der native Player dekodiert
#     (`av1`/`h264` + VAAPI-hwaccel, `opus`) — ohne Decoder baut er zwar, findet
#     zur Laufzeit aber keinen und zeigt nichts an.
#   * Filter bleiben AN. Das Flatpak laesst nur fuenf uebrig; hier waere das
#     eingesparte Platz, den niemand braucht, und die `ffmpeg`-Kommandozeile
#     (unten die Gegenprobe) verlangt mehr davon als diese fuenf.
#
# NVENC nur, wenn die Kopfdateien da sind: auf einer AMD-Maschine sind sie es
# nicht, und ein hartes `--enable-nvenc` liesse `configure` scheitern statt
# etwas Brauchbares zu bauen. Der Cache ist ohnehin pro Maschine.
opts=(
    --prefix="$prefix"
    --enable-shared
    --disable-static
    --disable-debug
    --disable-doc
    # Beschleunigt den Bau spuerbar und wird von nichts hier gebraucht.
    --disable-avdevice
    --disable-sdl2
    # LGPLv3 statt v2.1 — Bedingung fuer OpenSSL 3 (RTMPS auf dem
    # Standard-Sendeweg). KEIN --enable-gpl, KEIN libx264.
    --enable-version3
    --enable-openssl
    # Der VAAPI-Encode-Pfad des Sidecars: DMABUF -> DRM_PRIME -> hwmap ->
    # scale_vaapi. `--enable-libdrm` ist Pflicht fuer den DRM-hwdevice-Kontext;
    # fehlt es, scheitert av_hwdevice_ctx_create(DRM) irrefuehrend mit ENOMEM.
    --enable-vaapi
    --enable-libdrm
    # Opus: Ton-Encode im Sidecar, Ton-Decode im Player.
    --enable-libopus
    # dav1d: AV1-SOFTWARE-Decode im Player, und zwar schnell. Der native
    # AV1-Decoder in FFmpeg ist um ein Vielfaches langsamer — ohne dav1d ist
    # `PULSE_PLAYER_HWDEC=0` keine brauchbare Option, sondern nur eine
    # theoretische. Gebraucht wird sie auf AMD-APUs, wo Encode und Decode sich
    # eine Einheit teilen und gleichzeitige Last die GPU zuruecksetzt
    # (s. `decode.rs::hwdec_vorgabe`).
    --enable-libdav1d
    # Vulkan-Encode (h264_vulkan/av1_vulkan) — der Pfad, ueber den
    # Intra-Refresh mit waehlbarer RICHTUNG laeuft (COLUMN statt der
    # Zeilen, die der NVENC-Slice-Pfad vorgibt). Patch 0004 reicht die
    # VK_KHR_video_encode_intra_refresh-Optionen durch. libplacebo ist
    # Voraussetzung fuer die Vulkan-Encoder in FFmpeg; shaderc wird, wenn
    # installiert (auf Arch: shaderc-Paket), automatisch dazugelinkt.
    --enable-vulkan
    --enable-libplacebo
)

if pkg-config --exists ffnvcodec 2>/dev/null; then
    echo "==> nv-codec-headers gefunden — NVENC/NVDEC kommen mit"
    opts+=(--enable-nvenc --enable-ffnvcodec --enable-cuvid --enable-nvdec)
else
    echo "==> nv-codec-headers fehlen — Bau ohne NVENC/NVDEC (auf AMD/Intel richtig so)"
fi

cd "$quelle"
echo "==> configure"
./configure "${opts[@]}" >"$wurzel/configure.log" 2>&1 || {
    echo "configure gescheitert — letzte Zeilen aus $wurzel/configure.log:" >&2
    tail -25 "$wurzel/configure.log" >&2
    exit 1
}

echo "==> make -j$(nproc) (dauert ein paar Minuten)"
make -j"$(nproc)" >"$wurzel/build.log" 2>&1 || {
    echo "Bau gescheitert — letzte Zeilen aus $wurzel/build.log:" >&2
    tail -25 "$wurzel/build.log" >&2
    exit 1
}
make install >>"$wurzel/build.log" 2>&1

# Die Gegenprobe startet ffmpeg sofort nach make install. Auf dieser Maschine
# sah das zweimal (n8.1.1 UND n9.0) so aus, als greife der VAAPI-Patch nicht —
# die Option war nachträglich manoeller Prüfung aber da. Ein Filesystem-Race
# zwischen make install und dem Loader; sync löst es zuverlässig.
sync

# --- Gegenprobe -------------------------------------------------------------
#
# Ohne die waere nicht gesagt, dass der Patch wirklich greift: ein FFmpeg ohne
# die Option baut genauso durch, und der Fehler faellt erst beim ersten
# Streamversuch auf.
#
# `LD_LIBRARY_PATH` ist hier PFLICHT und keine Vorsichtsmassnahme. FFmpeg linkt
# sein eigenes `ffmpeg`-Binary ohne RPATH: ohne die Variable laedt der Loader
# das libavcodec der Distribution aus /usr/lib64 — die Gegenprobe befragt dann
# das System-FFmpeg und meldet "Patch hat nicht gegriffen", obwohl der Bau
# in Ordnung ist. Genau das ist hier beim ersten Lauf passiert.
echo "==> Gegenprobe"
fehlt=0
# Gegenprobe mit retry: der h264_vaapi-Check sah auf dieser Maschine wiederholt
# FEHLT aus, obwohl die Option zweifelsfrei da ist (manuell nach dem Bau
# verifiziert). Ein Last-/Shell-Race im Bau-Lauf, das sync allein nicht loest;
# retry tut es. Bleibt der Check nach Versuchen FEHLT, ist es echt.
check_enc_opt() {
    local enc="$1" opt="$2" n
    for n in 1 2 3 4 5; do
        if LD_LIBRARY_PATH="$prefix/lib" "$prefix/bin/ffmpeg" \
            -hide_banner -h "encoder=$enc" 2>/dev/null | grep -q "$opt"; then
            return 0
        fi
        sleep 0.3
    done
    return 1
}
# VAAPI-Encoder (Patch 0001): Basis-Option intra_refresh.
for enc in av1_vaapi h264_vaapi; do
    if check_enc_opt "$enc" "intra_refresh"; then
        echo "  $enc: intra_refresh da"
    else
        echo "  $enc: intra_refresh FEHLT" >&2
        fehlt=1
    fi
done
# NVENC-Encoder (Patch 0003): entkoppelt intra_refresh_period/cnt von -g.
# NUR pruefen, wenn NVENC auch gebaut wurde — ohne ffnvcodec wird es gar nicht
# konfiguriert, und die Schleife wuerde auf AMD/Intel falsch FEHLT melden.
# Geprueft wird intra_refresh_period (nicht intra_refresh): letzteres hat
# NVENC ohnehin upstream, nur die neue Option beweist, dass der Patch gegriffen.
if pkg-config --exists ffnvcodec 2>/dev/null; then
    for enc in av1_nvenc h264_nvenc; do
        if check_enc_opt "$enc" "intra_refresh_period"; then
            echo "  $enc: intra_refresh_period da"
        else
            echo "  $enc: intra_refresh_period FEHLT (Patch 0003 nicht gegriffen?)" >&2
            fehlt=1
        fi
    done
fi

# Vulkan-Encoder (Patch 0004): Intra-Refresh-Richtung COLUMN — nur wenn
# Vulkan-Encode ueberhaupt gebaut wurde (benoetigt libplacebo + shaderc).
# Nicht fehlerbehaftet, wenn der Encoder fehlt (z.B. libplacebo nicht
# installiert): dann ist der COLUMN-Pfad einfach nicht verfuegbar, der
# NVENC-Weg laeuft unberuehrt weiter.
for enc in h264_vulkan av1_vulkan; do
    if LD_LIBRARY_PATH="$prefix/lib" "$prefix/bin/ffmpeg" \
        -hide_banner -encoders 2>/dev/null | grep -q " $enc "; then
        if check_enc_opt "$enc" "intra_refresh"; then
            echo "  $enc: intra_refresh da (COLUMN-Pfad)"
        else
            echo "  $enc: Encoder gebaut, aber intra_refresh FEHLT (Patch 0004?)" >&2
            fehlt=1
        fi
    else
        echo "  $enc: nicht gebaut (libplacebo/shaderc fehlt? Vulkan-Encode aus)"
    fi
done
[ "$fehlt" -eq 0 ] || { echo "Der Patch hat nicht gegriffen." >&2; exit 1; }

echo ""
echo "Fertig: $prefix"
echo "Sidecar und Player dagegen bauen:  scripts/hq-bauen.sh"
