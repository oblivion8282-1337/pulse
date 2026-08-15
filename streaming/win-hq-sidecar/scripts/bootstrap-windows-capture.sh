#!/usr/bin/env bash
# Stellt den gepatchten windows-capture-Zweig her, den der Sidecar braucht.
#
# WARUM ES DAS GIBT: `Cargo.toml` bindet windows-capture über
# `[patch.crates-io]` an einen lokalen Pfad (`vendor/windows-capture/`), und
# der ist gitignored — reproduzierbar herstellbar statt eingecheckt, dieselbe
# Bauart wie `streaming/pulse-player/scripts/bootstrap-webrtc.sh`. Fehlt der
# Pfad, bricht cargo schon beim AUFLÖSEN ab, nicht erst beim Übersetzen.
#
# WAS DER PATCH MACHT: Die Crate setzt `IsCursorCaptureEnabled` nur beim
# Start der Aufnahme und legt die WGC-Session danach nirgends offen. Für das
# Cursor-Echo der Fernsteuerung muss der Host-Cursor aber MITTEN IM STREAM aus
# der Aufnahme genommen und wieder hineingelegt werden können (der Steuernde
# sieht seinen eigenen, verzögerungsfreien Zeiger; der nachlaufende
# Stream-Cursor wäre nur ein Geisterbild). Der Patch reicht die Session einmal
# an den Handler durch (`on_session_ready`, Default no-op) — sonst nichts.
#
# WARUM TARBALL STATT GIT-KLON: Das Upstream-Repo trägt keine Tags; ein
# `--branch <tag>`-Klon wie in `scripts/lib/gepatchter-klon.sh` ist damit
# nicht pinbar. Das crates.io-Tarball ist unveränderlich und über die
# SHA256-Prüfsumme gepinnt — dieselbe, die im Cargo.lock steht.
#
# Fällt weg, sobald windows-capture selbst einen Laufzeit-Zugriff auf die
# Session anbietet.
set -euo pipefail

VERSION="2.0.0"
# Prüfsumme des .crate-Tarballs. Beim Anheben der Version neu bestimmen:
# `curl -fsSL <URL> | sha256sum`. (Der frühere Verweis „steht im Cargo.lock"
# gilt nicht mehr — mit `[patch.crates-io]` führt das Lock keinen
# checksum-Eintrag für windows-capture.)
SHA256="0f9460c7b82f6b7d314d85b45610481f26a1159a42dadf1e13a329041553e060"
URL="https://static.crates.io/crates/windows-capture/windows-capture-${VERSION}.crate"

hier="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ziel="$hier/vendor/windows-capture"
patch_dir="$hier/patches"

tarball="$hier/vendor/windows-capture-${VERSION}.crate"
mkdir -p "$hier/vendor"

if [ ! -f "$tarball" ]; then
    curl -fsSL --retry 3 -o "$tarball" "$URL"
fi
ist="$(sha256sum "$tarball" | cut -d' ' -f1)"
if [ "$ist" != "$SHA256" ]; then
    echo "windows-capture-${VERSION}.crate: SHA256 $ist, erwartet $SHA256" >&2
    rm -f "$tarball"
    exit 1
fi

# Frisch auspacken — ein zweiter Lauf darf nicht denselben Patch ein zweites
# Mal anwenden (dieselbe Erkenntnis wie in `gepatchter-klon.sh`).
rm -rf "$ziel"
tar -xzf "$tarball" -C "$hier/vendor"
mv "$hier/vendor/windows-capture-${VERSION}" "$ziel"

# NUR AUF WINDOWS LAUFFAEHIG (Stand 2026-08-15). Das crates.io-Tarball liefert
# `src/capture.rs` mit CRLF-Zeilenenden, die Patches hier haben LF — `git apply`
# scheitert deshalb auf Linux/macOS mit „patch does not apply", waehrend es auf
# Windows (autocrlf) durchgeht. Wer den Zweig auf einer Nicht-Windows-Maschine
# herstellen will, muss die Zeilenenden angleichen; fuer den Bau des Sidecars
# selbst ist das ohne Belang, der laeuft ohnehin nur auf Windows.
#
# Wegwerf-Repo NUR fürs Anwenden: ohne eigenes `.git` entdeckt `git apply`
# das umgebende Pulse-Repo, und weil `vendor/` dort gitignored ist,
# ÜBERSPRINGT es die Dateien wortlos („Skipped patch") — der Lauf sah
# erfolgreich aus und der Zweig war trotzdem ungepatcht. Genau so am
# 2026-08-13 passiert; `--check` meldete dabei ebenfalls Erfolg.
git init -q "$ziel"

anzahl=0
for p in "$patch_dir"/*.patch; do
    [ -e "$p" ] || continue
    # `--check` zuerst: ein nicht passender Patch soll benannt scheitern statt
    # halb angewandt liegenzubleiben.
    if ! git -C "$ziel" apply --check "$p" 2>/dev/null; then
        echo "Patch passt nicht auf ${VERSION}: $(basename "$p")" >&2
        echo "Wurde die Abhängigkeit angehoben? Dann den Patch nachziehen." >&2
        exit 1
    fi
    git -C "$ziel" apply "$p"
    echo "  angewandt: $(basename "$p")"
    anzahl=$((anzahl + 1))
done
rm -rf "$ziel/.git"

# Zeitstempel einfrieren — sonst baut die CI den Zweig bei JEDEM Lauf neu.
#
# Cargo entscheidet fuer Pfad-Abhaengigkeiten an der mtime, ob eine Kiste neu
# uebersetzt werden muss. Das frische Auspacken oben (das bleiben MUSS, sonst
# griffe ein Patch doppelt) setzt sie auf "jetzt" — der Zweig sieht also
# geaendert aus, obwohl Version und Patches dieselben sind, und windows-capture
# samt allem, was dagegen linkt, wird neu uebersetzt. Ein fester Zeitpunkt
# macht das Ergebnis byte- UND zeitgleich; nur der Inhalt entscheidet dann.
find "$ziel" -exec touch -h -d '2020-01-01T00:00:00Z' {} + 2>/dev/null || true

echo "windows-capture ${VERSION} + ${anzahl} Pulse-Patches liegen in $ziel"
echo "Gegenprobe:  cd $hier && cargo build --release"
