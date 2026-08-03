#!/usr/bin/env bash
# Stellt den gepatchten webrtc-rs-Zweig her, den der Player braucht.
#
# WARUM ES DAS GIBT: `Cargo.toml` bindet webrtc-rs über `[patch.crates-io]` an
# einen lokalen Pfad. Lag der nur auf EINER Maschine, war der Player dort ein
# Ein-Maschinen-Programm — und zwar nicht nur der Paritätspfad, sondern alles:
# cargo bricht schon beim Auflösen ab, wenn der Pfad fehlt.
#
#   error: failed to load source for dependency `webrtc`
#   Caused by: failed to read .../webrtc-rs-pulse/webrtc/Cargo.toml
#
# Also: Zweig klonen, Patch anwenden, fertig. Das Ergebnis liegt unter
# `vendor/webrtc-rs/` neben dem Player und ist gitignored — reproduzierbar
# herstellbar statt eingecheckt.
#
# WAS DER PATCH MACHT: webrtc-rs entschlüsselt und speichert Pakete nicht
# angemeldeter Ströme bereits (`undeclared_media_processor` →
# `store_simulcast_stream`), räumt sie bei Fehlschlag auch nicht weg — nur der
# Lesezugriff fehlt, Karte und Zugriffe sind `pub(crate)`. Der Zweig fügt zwei
# lesende Methoden hinzu, sonst nichts. Ohne ihn kommt der FlexFEC-Empfänger
# des Players nie an die Paritätspakete.
#
# Fällt weg, sobald webrtc-rs selbst etwas Gleichwertiges anbietet.
set -euo pipefail

VERSION="v0.17.2"
REPO="https://github.com/webrtc-rs/webrtc.git"

hier="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$hier/../.." && pwd)"
ziel="$hier/vendor/webrtc-rs"

# Klonen, Zuruecksetzen und Patchen macht der gemeinsame Helfer — dieselbe
# Mechanik braucht `streaming/ffmpeg-patches/bootstrap-ffmpeg.sh`, und die
# beiden Erkenntnisse darin (reset statt checkout, alle Patches statt einem)
# gehoeren an EINE Stelle.
. "$repo_root/scripts/lib/gepatchter-klon.sh"
gepatchter_klon "$REPO" "$VERSION" "$ziel" "$hier/patches"

anzahl=$(ls -1 "$hier"/patches/*.patch 2>/dev/null | wc -l)
echo "webrtc-rs $VERSION + $anzahl Pulse-Patches liegen in $ziel"
echo "Gegenprobe:  cd $hier && cargo build --release"
