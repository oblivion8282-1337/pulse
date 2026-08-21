#!/usr/bin/env bash
# Baut das FFmpeg, gegen das der Linux-Sidecar und der Player linken.
#
# WARUM ES DAS GIBT: `ffmpeg-next = "8.1"` uebersetzt nur gegen FFmpeg 8.1.
# Aktuelle Distributionen liegen darueber (Arch/CachyOS auf n9.0.1), und dagegen
# bricht die Kiste an nicht abgedeckten Enum-Werten ab. Das Distributions-FFmpeg
# taugt als Grundlage also nicht, unabhaengig davon, welche Optionen es kennt.
#
# **Bis zum 2026-08-21 trug dieses Verzeichnis zusaetzlich zwei Patches**, die
# rollenden Intra-Refresh fuer die VA-API- und AMF-Encoder freilegten. Die
# Betriebsart ist entfallen (Begruendung im Wurzel-`CLAUDE.md`), die Patches
# damit auch — gebaut wird jetzt unveraenderter Upstream-Quelltext.
#
# WOHIN: $XDG_CACHE_HOME/pulse/ffmpeg/ (Standard ~/.cache/pulse/ffmpeg/) —
# derselbe persistente Ort, den auch `streaming/bootstrap-gsr.fish` benutzt.
# NICHT nach /tmp: das ist auf manchen Maschinen ein tmpfs, der Bau waere nach
# jedem Reboot weg.
#
# Das System-FFmpeg wird NICHT angefasst. `scripts/hq-bauen.sh` baut Sidecar und
# Player mit einem RPATH auf das Ergebnis hier — nur diese beiden Programme
# sehen dieses FFmpeg, alles andere auf dem Rechner bleibt, wie es ist.
#
# LIZENZ: der Bau ist bewusst LGPL — kein `--enable-gpl`, kein libx264. Das ist
# die Bedingung aus dem Wurzel-`CLAUDE.md` (Pulse darf keinen GPL-Code linken)
# und dieselbe, unter der das Flatpak sein FFmpeg baut. `--enable-version3` ist
# Pflicht, sobald OpenSSL 3 dazukommt (Apache-2.0 vertraegt sich mit LGPLv3,
# nicht mit v2.1).
set -euo pipefail

# Derselbe Stand, den das Flatpak pinnt (packaging/com.howispulse.Pulse.yml,
# ffmpeg-Modul). Dev und Auslieferung sollen denselben Quelltext bauen —
# sonst gilt eine hier gemessene Zahl fuer die ausgelieferte App nicht.
VERSION="n8.1.1"
# Derselbe Commit, den das Flatpak-Manifest nennt. Er steht hier ZUSAETZLICH
# zum Tag, weil ein flacher Klon den Tag nicht peelen kann ("refs/tags/n8.1.1
# ist kein Commit") — ein `reset --hard n8.1.1` beim zweiten Lauf scheitert
# daran. Auf den Commit zurueckzusetzen geht immer.
COMMIT="239f2c733de417201d7ad3b3b8b0d9b63285b2b1"
REPO="https://github.com/FFmpeg/FFmpeg.git"

hier="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$hier/../.." && pwd)"
cache_root="${XDG_CACHE_HOME:-$HOME/.cache}"
wurzel="$cache_root/pulse/ffmpeg"
quelle="$wurzel/src"
prefix="$wurzel/prefix"

# Schon gebaut? Dann nichts tun. Die Pruefung sitzt HIER und nicht beim
# Aufrufer, weil hier der Pfad ohnehin steht — sonst muesste jeder Aufrufer ihn
# selbst herleiten und bei einem Umzug mitwandern.
if [ -x "$prefix/bin/ffmpeg" ] && [ "${PULSE_FFMPEG_NEUBAU:-0}" != "1" ]; then
    echo "==> FFmpeg liegt schon da ($prefix)"
    echo "    Neu bauen:  PULSE_FFMPEG_NEUBAU=1 $0"
    exit 0
fi

# --- Quelltext holen --------------------------------------------------------
#
# `flacher_klon` statt `gepatchter_klon`: hier gibt es nichts mehr anzuwenden
# (s. Kopf). Der Klon samt Commit-Reset und Zeitstempel ist derselbe, und ihn
# ein zweites Mal auszuschreiben hiesse, zwei Fassungen davon zu pflegen.
echo "==> FFmpeg $VERSION holen (flacher Klon, ~100 MB)"
. "$repo_root/scripts/lib/gepatchter-klon.sh"
flacher_klon "$REPO" "$VERSION" "$quelle" "$COMMIT"

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
)

# AUF NVIDIA IST DIESER ZWEIG NICHT OPTIONAL, auch wenn die Meldung unten
# harmlos klingt: ohne NVENC hat der fertige Sidecar GAR KEINEN Encoder. Sein
# `health` meldet dann `video_codecs: []`, die Oberflaeche blendet den
# HQ-Knopf aus, und nichts sagt einem warum. Auf Arch heisst das Paket
# `ffnvcodec-headers`.
#
# DIE HEADER DUERFEN ABER NICHT ZU NEU SEIN. Ab `n13.1.15.0` ist
# `NV_ENC_CLOCK_TIMESTAMP_SET.countingType` in `countingTypeLSB`/`…MSB`
# aufgeteilt; das hier gebaute FFmpeg (s. VERSION oben) kennt nur den alten
# Namen und bricht mit
#   nvenc.c: »NV_ENC_CLOCK_TIMESTAMP_SET« hat kein Element namens »countingType«
# ab. Letzte passende Fassung ist `n13.0.19.0`. Wenn die Distribution schon
# weiter ist, NICHT das Systempaket herunterstufen (das naechste Systemupdate
# hebt es wieder an), sondern daneben legen:
#
#   git clone https://github.com/FFmpeg/nv-codec-headers && cd nv-codec-headers
#   git checkout n13.0.19.0 && make install PREFIX=~/.cache/pulse/nv-codec-headers-n13.0
#   export PKG_CONFIG_PATH=~/.cache/pulse/nv-codec-headers-n13.0/lib/pkgconfig:$PKG_CONFIG_PATH
#   PULSE_FFMPEG_NEUBAU=1 scripts/hq-bauen.sh
#
# Gegen das System-FFmpeg zu bauen ist KEIN Ausweg: die `ffmpeg-next`-Crate
# haengt an der API dieser Fassung (mit n9.0.1 bricht schon `cargo build` ab).
if pkg-config --exists ffnvcodec 2>/dev/null; then
    echo "==> nv-codec-headers gefunden — NVENC/NVDEC kommen mit"
    opts+=(--enable-nvenc --enable-ffnvcodec --enable-cuvid --enable-nvdec)
else
    echo "==> nv-codec-headers fehlen — Bau ohne NVENC/NVDEC (auf AMD/Intel richtig so,"
    echo "    auf NVIDIA bekommt der Sidecar dadurch KEINEN Encoder — s. Kommentar hier)"
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
for enc in av1_vaapi h264_vaapi; do
    if LD_LIBRARY_PATH="$prefix/lib" "$prefix/bin/ffmpeg" \
        -hide_banner -h "encoder=$enc" 2>/dev/null | grep -q "intra_refresh"; then
        echo "  $enc: intra_refresh da"
    else
        echo "  $enc: intra_refresh FEHLT" >&2
        fehlt=1
    fi
done
[ "$fehlt" -eq 0 ] || { echo "Der Patch hat nicht gegriffen." >&2; exit 1; }

echo ""
echo "Fertig: $prefix"
echo "Sidecar und Player dagegen bauen:  scripts/hq-bauen.sh"
