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
ziel="$hier/vendor/webrtc-rs"
# ALLE Patches, in alphabetischer Reihenfolge. Frueher stand hier genau einer,
# hartcodiert — der zweite (NACK-Sperrfrist) waere damit auf jeder anderen
# Maschine und in der CI stillschweigend gefehlt, und der Player haette dort
# ein anderes Verhalten gezeigt als hier gemessen.
shopt -s nullglob
patch_dateien=("$hier"/patches/*.patch)
shopt -u nullglob

[ ${#patch_dateien[@]} -gt 0 ] || { echo "Keine Patches in $hier/patches" >&2; exit 1; }

if [ -d "$ziel/.git" ]; then
    # Schon da: auf den Ausgangsstand zurück, damit ein zweiter Lauf nicht
    # denselben Patch ein zweites Mal anzuwenden versucht.
    #
    # `checkout` allein GENUEGT NICHT — es laesst Aenderungen an getrackten
    # Dateien stehen, und genau die sind hier ja die Patches. Der Rueckfall
    # wirkte deshalb nie; mit einem einzigen Patch fiel es nur nicht auf, weil
    # `apply --check` danach am schon gepatchten Baum scheiterte und das Skript
    # mit "wurde webrtc-rs angehoben?" abbrach — einer Meldung, die in die
    # voellig falsche Richtung zeigt.
    git -C "$ziel" reset -q --hard "$VERSION"
    git -C "$ziel" clean -qfd
else
    mkdir -p "$(dirname "$ziel")"
    # --depth 1 auf das Tag: die Historie brauchen wir nicht, der Klon ist
    # sonst erheblich größer.
    git clone -q --depth 1 --branch "$VERSION" "$REPO" "$ziel"
fi

for patch_datei in "${patch_dateien[@]}"; do
    git -C "$ziel" apply --check "$patch_datei" 2>/dev/null || {
        echo "Patch passt nicht auf $VERSION: $(basename "$patch_datei")" >&2
        echo "Wurde webrtc-rs angehoben?" >&2
        exit 1
    }
    git -C "$ziel" apply "$patch_datei"
    echo "  angewandt: $(basename "$patch_datei")"
done

echo "webrtc-rs $VERSION + ${#patch_dateien[@]} Pulse-Patches liegen in $ziel"
echo "Gegenprobe:  cd $hier && cargo build --release"
