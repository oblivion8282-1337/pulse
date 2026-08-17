#!/usr/bin/env bash
# Holt die FFmpeg-Fassung, gegen die der Player geschrieben ist — für den
# LOKALEN Prüfbau auf Linux.
#
# WARUM ES DAS GIBT. `ffmpeg-next` 8.1 übersetzt nicht gegen jedes FFmpeg: in
# FFmpeg 9 sind die Felder verschwunden, aus denen man die Fähigkeiten eines
# Codecs auslas (`pix_fmts`, `sample_fmts`, `supported_framerates`,
# `ch_layouts` — ersetzt durch `avcodec_get_supported_config`), drei
# Codec-Kennungen sind weg, und es kamen Sorten von Zusatzdaten hinzu, die die
# Crate nicht kennt. Auf einer Maschine mit FFmpeg 9 im System — Arch und
# CachyOS liefern das seit 2026 — scheitert `cargo check` deshalb mit 14
# Fehlern, und zwar IN DER CRATE, nicht in Pulse-Code. Am 2026-08-17 hat das
# eine Änderung am Player ungeprüft in die CI geschickt.
#
# WAS ES NICHT IST: der Bauweg der Auslieferung. Der Flatpak baut den Player
# gegen sein eigenes, gebündeltes FFmpeg (`packaging/com.howispulse.Pulse.yml`,
# ffmpeg-Modul) — dort hängen zwei Dinge dran, die es sonst nirgends gibt: der
# VAAPI-Intra-Refresh-Patch und die Decoder-Liste, ohne die der Player kein
# Bild zeigt. Was hier geladen wird, taugt zum ÜBERSETZEN, nicht zum
# Ausliefern.
#
# WARUM `PKG_CONFIG_PATH` UND NICHT NUR `FFMPEG_DIR`: auf Linux findet
# `ffmpeg-sys-next` seine Bibliotheken über pkg-config. `FFMPEG_DIR` allein —
# der Weg, den der Windows-Sidecar geht — wird dabei übergangen, und der Bau
# nimmt weiter das System-FFmpeg. Nachgewiesen am 2026-08-17: mit gesetztem
# `FFMPEG_DIR` blieben es dieselben 14 Fehler, erst mit `PKG_CONFIG_PATH` ging
# es durch. Beide zu setzen schadet nicht und macht die Absicht deutlich.
#
# WARUM DER PFAD NICHT IN `.cargo/config.toml` STEHT: der Flatpak baut dieselbe
# Kiste. Stünde `FFMPEG_DIR` dort fest, zeigte es beim Flatpak-Bau auf ein
# Verzeichnis, das es nicht gibt. Deshalb bleibt es eine Umgebungsvariable, die
# nur setzt, wer hier von Hand baut.
set -euo pipefail

# LGPL, nicht GPL — dieselbe Auflage wie überall im Projekt (`CLAUDE.md`:
# FFmpeg überall LGPL und dynamisch gelinkt). Die GPL-Variante liegt im selben
# Release daneben; sie ist hier ausdrücklich NICHT gemeint.
VERSION="n8.1"
URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-${VERSION}-latest-linux64-lgpl-shared-8.1.tar.xz"
# Prüfsumme vom 2026-08-17. **Das Release heißt `latest` und wird neu gebaut** —
# die Summe ändert sich also, ohne dass die FFmpeg-Version wechselt. Schlägt
# die Prüfung fehl, erst nachsehen, ob `pkg-config --modversion libavcodec`
# im Entpackten weiterhin 62.x meldet (= FFmpeg 8.1); dann die Summe hier
# nachziehen. Eine Summe, die niemand prüft, ist keine.
SHA256="10ccdea5b5f0742d2337e5a4254fb0457c566a78aef7635a40dbd7376834824b"

hier="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ziel="$hier/ffmpeg-dist/n8.1-lgpl-shared"
tarball="$hier/ffmpeg-dist/ffmpeg-${VERSION}-lgpl-shared.tar.xz"

if [ -d "$ziel" ]; then
    echo "liegt schon da: $ziel"
    echo "Neu holen:  rm -rf $hier/ffmpeg-dist && $0"
    exit 0
fi

mkdir -p "$hier/ffmpeg-dist"
[ -f "$tarball" ] || curl -fsSL --retry 3 -o "$tarball" "$URL"

ist="$(sha256sum "$tarball" | cut -d' ' -f1)"
if [ "$ist" != "$SHA256" ]; then
    echo "Prüfsumme passt nicht: $ist, erwartet $SHA256" >&2
    echo "Das Release 'latest' wird neu gebaut — s. Kommentar an SHA256 oben." >&2
    rm -f "$tarball"
    exit 1
fi

tar -xJf "$tarball" -C "$hier/ffmpeg-dist"
mv "$hier/ffmpeg-dist/ffmpeg-${VERSION}"-*-linux64-lgpl-shared-8.1 "$ziel"
rm -f "$tarball"

echo "FFmpeg ${VERSION} (LGPL, shared) liegt in $ziel"
echo
echo "Bauen:"
echo "  export PKG_CONFIG_PATH=\"$ziel/lib/pkgconfig\""
echo "  export FFMPEG_DIR=\"$ziel\""
echo "  cargo check"
