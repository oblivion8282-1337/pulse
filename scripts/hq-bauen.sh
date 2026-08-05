#!/usr/bin/env bash
# Baut die komplette HQ-Kette fuer den Dev-Stack auf dieser Maschine:
# gepatchtes FFmpeg, den Linux-Sidecar (Sender) und den nativen Player
# (Empfaenger). Danach kann `scripts/dev-up.fish` alles davon benutzen.
#
# EIN Befehl, weil die drei Teile nur zusammen etwas taugen: der Sidecar sendet
# Intra-Refresh nur, wenn sein FFmpeg die Option kennt, und der Player ist der
# Zuschauer, an dem man das Ergebnis sieht.
#
# WAS ES NICHT ANFASST: das System-FFmpeg. Sidecar und Player bekommen einen
# RPATH auf den eigenen Bau unter ~/.cache/pulse/ffmpeg-intra-refresh/prefix —
# nur diese beiden Programme sehen ihn. Jedes andere Programm auf dem Rechner,
# `ffmpeg` auf der Kommandozeile eingeschlossen, benutzt weiter das der
# Distribution.
#
# Auf NVIDIA ist der FFmpeg-Teil nicht noetig (`*_nvenc` hat Intra-Refresh
# upstream), schadet aber auch nicht — das Skript laeuft auf beiden Herstellern
# gleich.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cache_root="${XDG_CACHE_HOME:-$HOME/.cache}"
prefix="$cache_root/pulse/ffmpeg-intra-refresh/prefix"

# --- 1. Gepatchtes FFmpeg ---------------------------------------------------
#
# Unbedingt aufrufen: das Skript entscheidet selbst, ob schon etwas da ist
# (`PULSE_FFMPEG_NEUBAU=1` erzwingt den Neubau). Es kennt den Zielpfad ohnehin —
# ihn hier ein zweites Mal herzuleiten hiesse, ihn bei einem Umzug an zwei
# Stellen nachziehen zu muessen.
bash "$repo_root/streaming/ffmpeg-patches/bootstrap-ffmpeg.sh"

# `-Wl,--disable-new-dtags` ist der nicht offensichtliche Teil und darf beim
# Kuerzen NICHT wegfallen. Ohne ihn schreibt der Linker DT_RUNPATH statt
# DT_RPATH, und DT_RUNPATH gilt **nur fuer die direkt gelinkten Bibliotheken**:
# libavcodec wuerde von hier kommen, das libavutil DAHINTER aber wieder aus
# /usr/lib64. Zwei FFmpeg-Haelften in einem Prozess — der Fehler zeigt sich
# nicht beim Bauen, sondern als Absturz oder als still fehlende Option.
export PKG_CONFIG_PATH="$prefix/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
export RUSTFLAGS="-C link-arg=-Wl,-rpath,$prefix/lib -C link-arg=-Wl,--disable-new-dtags${RUSTFLAGS:+ $RUSTFLAGS}"

# --- 2. Sidecar (Sender) ----------------------------------------------------
echo ""
echo "==> Linux-HQ-Sidecar bauen"
cargo build --release --manifest-path "$repo_root/streaming/linux-hq-sidecar/Cargo.toml"

# --- 3. Player (Empfaenger) -------------------------------------------------
#
# Der gepatchte webrtc-rs-Zweig ist nicht eingecheckt (reproduzierbar
# herstellbar), und ohne ihn bricht cargo schon beim Aufloesen ab — deshalb
# immer erst das Bootstrap-Skript. Es ist idempotent.
echo ""
echo "==> webrtc-rs-Zweig herstellen"
bash "$repo_root/streaming/pulse-player/scripts/bootstrap-webrtc.sh"

echo ""
echo "==> Pulse-Player bauen"
cargo build --release --manifest-path "$repo_root/streaming/pulse-player/Cargo.toml"

# --- 4. Gegenprobe ----------------------------------------------------------
#
# Beide Binaries muessen wirklich am gepatchten FFmpeg haengen. Ein Bau, der
# versehentlich das System-FFmpeg erwischt hat, laeuft an — und verweigert dann
# beim ersten Streamversuch den Start, mit einer Meldung, die nach einem
# Codefehler aussieht statt nach einem Bauproblem.
echo ""
echo "==> Gegenprobe: haengen die Binaries am gepatchten FFmpeg?"
fehler=0
for bin in \
    "$repo_root/streaming/linux-hq-sidecar/target/release/pulse-linux-hq-sidecar" \
    "$repo_root/streaming/pulse-player/target/release/pulse-player"
do
    name="$(basename "$bin")"
    if [ ! -x "$bin" ]; then
        echo "  $name: FEHLT" >&2
        fehler=1
        continue
    fi
    pfad="$(ldd "$bin" 2>/dev/null | awk '/libavcodec/ {print $3}')"
    case "$pfad" in
        "$prefix"/*) echo "  $name: ok ($pfad)" ;;
        "")          echo "  $name: kein libavcodec gelinkt?" >&2; fehler=1 ;;
        *)           echo "  $name: haengt am FALSCHEN FFmpeg ($pfad)" >&2; fehler=1 ;;
    esac
done
[ "$fehler" -eq 0 ] || { echo "" >&2; echo "Bau unvollstaendig — s.o." >&2; exit 1; }

echo ""
echo "Fertig. Weiter mit:  scripts/dev-up.fish"
