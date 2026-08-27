#!/usr/bin/env bash
# Cargo-Teil des Test-Gates — aus ship.sh herausgelöst, Inhalt unverändert.
#
# Erwartet die Liste der geänderten Pfade als $1 (eine pro Zeile), so wie sie
# `gate.sh` aus dem Vergleich mit origin/main bildet. Getrennt von `gate.sh`,
# weil die Begründungen hier lang sind (und es wert: jede einzelne steht für
# einen Fall, in dem Tests in KEINEM Gate liefen) — zusammen wäre die Datei
# über der Größen-Policy.
set -euo pipefail

changed="${1:-}"
# Die gemeinsamen Kisten (`streaming/pulse-*`) liefen in KEINEM Gate — weder
# hier noch in ci.yml —, und `cargo test` in einem Programm führt die Tests
# seiner Pfad-Abhängigkeiten nicht mit. Seit 2026-08-22 trägt
# pulse-fernsteuerung die Sitzungs-Zustandsmaschine der Fernsteuerung; ihre
# Tests sind die schärfsten im Repo und liefen bis dahin nirgends.
#
# Ohne FFmpeg-Schranke, weil diese Kisten abhängigkeitsfrei sind und in
# Sekunden bauen. Zwei Ausnahmen: pulse-player trägt denselben Namensstamm
# (`streaming/pulse-*`), hängt aber an der gepinnten FFmpeg und wird weiter
# unten mit FFMPEG_DIR/LD_LIBRARY_PATH getestet — hier ausdrücklich
# ausgenommen, sonst liefe es hier ein zweites Mal, diesmal ohne die
# nötige Umgebung, und bräche den Bau eines unveränderten Crates.
#
# **pulse-whip lief bis zum 2026-08-27 in KEINEM Gate**, und die Begründung
# dafür stimmte nicht. Sie lautete: ihr `cargo test` löse webrtc von
# crates.io auf statt „über den gepatchten Zweig, den Player und die
# Sidecars tatsächlich ausliefern". Nachgesehen: `[patch.crates-io]` für
# webrtc steht NUR in `pulse-player/Cargo.toml` (auf `vendor/webrtc-rs`).
# Die drei Sidecars führen schlicht `webrtc = "0.17"` von crates.io — und
# ausser ihnen hängt niemand an pulse-whip. Der Gate-Lauf prüfte also
# genau die ausgelieferte Abhängigkeit, nicht eine andere.
#
# Der zweite Einwand (214 Kisten im Abhängigkeitsbaum) bleibt richtig und
# ist trotzdem kein Grund: der Baum wird für pulse-player ohnehin gebaut,
# und ein Lauf nach einer Änderung an der Kiste selbst kostet gemessen 1 s
# (2026-08-27, warmer Cache). Bezahlt wird nur der erste Kaltbau, wie bei
# jedem Crate hier.
#
# Was dahinter lag: 31 Tests, die genau das festhalten, wofür es diesen
# Sendeweg gibt — dass `ccm fir`/`nack pli` wirklich im Angebot stehen, dass
# `stereo=1` es hinausschafft, dass die H.264-Stufe die gerechnete ist. Jeder
# einzelne hält einen Fehler fest, der schon einmal da war.
#
# `krypto/pulse-krypto` ist seit dem 2026-08-28 dabei und steht bewusst in
# derselben Schleife statt in einer eigenen: es ist eine gemeinsame Kiste wie
# die anderen — ohne Fremdbau, ohne FFmpeg, `cargo test` genügt. Wäre das
# Muster hier auf `streaming/` beschränkt geblieben, hätte der Krypto-Kern am
# Tag seiner Entstehung 11 Tests gehabt, die in KEINEM Gate laufen — dieselbe
# Fehlerklasse, die dieser Block überhaupt erst begründet hat.
for kiste in $(echo "$changed" | sed -n \
  -e 's|^\(streaming/pulse-[a-z-]*\)/.*|\1|p' \
  -e 's|^\(krypto/pulse-[a-z-]*\)/.*|\1|p' | sort -u); do
  [ "$kiste" = "streaming/pulse-player" ] && continue
  [ -f "$kiste/Cargo.toml" ] || continue
  # `${kiste}` mit Klammern, und das ist kein Schoenheitsfehler: macOS
  # liefert bis heute bash 3.2 aus, und die zaehlt das erste Byte des
  # folgenden UTF-8-Zeichens zum Variablennamen. `$kiste…` wird dort zu
  # `kiste\xe2` und stirbt unter `set -u` mit „unbound variable" — mitten im
  # Test-Gate, also genau dann, wenn jemand landen will.
  echo "  Cargo-Tests ${kiste}…"
  ( cd "$kiste" && cargo test -q ) \
    || { echo "✗ Cargo-Tests $kiste ROT — abgebrochen." >&2; exit 1; }
done

# Cargo-Tests der beiden Crates, die auf Linux WIRKLICH bauen: pulse-player
# (415 Tests) und linux-hq-sidecar (101). Sie liefen bis zum 2026-08-19 in
# keinem Gate — mit demselben Ergebnis wie bei den Node-Unit-Tests davor: im
# Player lag ein roter Test monatelang unbemerkt, und ein roter Test meldet
# keine Regression mehr. win-hq-sidecar bleibt draussen, das baut auf Linux
# nicht; die mac-Kisten laufen weiter unten, aber nur auf macOS.
#
# Nur bei Änderung am jeweiligen Crate — ein Kaltbau kostet Minuten, und die
# allermeisten Pushes fassen kein Rust an.
#
# **Warum FFMPEG_DIR und LD_LIBRARY_PATH:** beide Crates hängen an der
# gepinnten FFmpeg n8.1. Ohne FFMPEG_DIR zieht `ffmpeg-next` die zu neue
# System-FFmpeg und bricht an nicht abgedeckten Enum-Werten ab; ohne
# LD_LIBRARY_PATH übersetzt es zwar, aber die Testbinaries finden
# libavcodec.so.62 nicht und sterben mit Exit 127. Beides sieht wie ein
# kaputter Test aus und ist keiner.
# **Drei Kandidaten, nicht einer.** Bis zum 2026-08-26 stand hier nur der
# Cache-Pfad — auf einer Maschine, die FFmpeg über
# `streaming/pulse-player/scripts/fetch-ffmpeg-linux.sh` in den Baum geholt
# hat (der übliche Weg laut `streaming/pulse-player/README.md`), zeigte das
# Gate deshalb bei JEDER Rust-Änderung „FFmpeg fehlt — Cargo-Tests
# ÜBERSPRUNGEN" und lief weiter. Eine Warnung, die im Rauschen untergeht, und
# 415 + 101 Tests, die niemand fährt. Dieselbe Fehlerklasse wie bei den
# Node-Unit-Tests (2026-08-17) und den mac-Kisten (2026-08-23).
ffmpeg_prefix=""
for _kandidat in \
  "${PULSE_FFMPEG_DIR:-}" \
  "${XDG_CACHE_HOME:-$HOME/.cache}/pulse/ffmpeg/prefix" \
  "$(git rev-parse --show-toplevel)/streaming/pulse-player/ffmpeg-dist/n8.1-lgpl-shared"
do
  [ -n "$_kandidat" ] && [ -d "$_kandidat/lib" ] && { ffmpeg_prefix="$_kandidat"; break; }
done
# Leer lassen wäre falsch: die Zweige unten prüfen `-d "$ffmpeg_prefix/lib"`
# und sollen bei keinem Treffer in die WARNUNG laufen, nicht in einen Bau mit
# leerem FFMPEG_DIR (der zöge die zu neue System-FFmpeg).
ffmpeg_prefix="${ffmpeg_prefix:-/nicht-vorhanden}"
# **Auf dem Mac liegt FFmpeg woanders**, und das ist im CLAUDE.md so
# beschrieben: der Player baut dort über `PKG_CONFIG_PATH` auf
# `~/src/ffmpeg-openssl`, nicht über den gepinnten Linux-Vorrat. Ohne diesen
# Zweig meldete das Gate am 2026-08-23 „FFmpeg fehlt — Cargo-Tests
# ÜBERSPRUNGEN" und liess die 385 Player-Tests aus, obwohl der Player auf
# diesem Zweig geänderten Code trug und über den Windows-Installer und das
# DMG ausgeliefert wird. Dieselbe Linux-Annahme wie bei den Sidecars eine
# Ebene höher, nur leiser: sie warnt wenigstens, statt zu schweigen.
mac_pkgconfig=""
if [ ! -d "$ffmpeg_prefix/lib" ] && [ "$(uname -s)" = "Darwin" ]; then
  for kandidat in "${PULSE_FFMPEG_PKGCONFIG:-}" "$HOME/src/ffmpeg-openssl/lib/pkgconfig"; do
    [ -n "$kandidat" ] && [ -d "$kandidat" ] && { mac_pkgconfig="$kandidat"; break; }
  done
fi
rust_crates=""
echo "$changed" | grep -q '^streaming/pulse-player/' && rust_crates="$rust_crates streaming/pulse-player"
echo "$changed" | grep -q '^streaming/linux-hq-sidecar/' && rust_crates="$rust_crates streaming/linux-hq-sidecar"
if [ -n "$rust_crates" ]; then
  if [ -n "$mac_pkgconfig" ]; then
    for crate in $rust_crates; do
      # Klammern aus demselben Grund wie oben (bash 3.2 auf macOS).
      echo "  Cargo-Tests ${crate} (macOS-FFmpeg)…"
      ( cd "$crate" && PKG_CONFIG_PATH="$mac_pkgconfig" cargo test -q ) \
        || { echo "✗ Cargo-Tests $crate ROT — abgebrochen." >&2; exit 1; }
    done
  elif [ ! -d "$ffmpeg_prefix/lib" ]; then
    echo "⚠  Rust-Crates geändert, aber die gepinnte FFmpeg fehlt ($ffmpeg_prefix)." >&2
    echo "   Cargo-Tests ÜBERSPRUNGEN — sie laufen also nicht. Bau sie mit" >&2
    echo "   scripts/hq-bauen.sh, oder setze PULSE_FFMPEG_DIR auf einen eigenen Bau." >&2
  else
    for crate in $rust_crates; do
      # Klammern aus demselben Grund wie oben (bash 3.2 auf macOS).
      echo "  Cargo-Tests ${crate}…"
      ( cd "$crate" && FFMPEG_DIR="$ffmpeg_prefix" LD_LIBRARY_PATH="$ffmpeg_prefix/lib" cargo test -q ) \
        || { echo "✗ Cargo-Tests $crate ROT — abgebrochen." >&2; exit 1; }
    done
  fi
fi
# --- Die macOS-Kisten, und nur auf macOS ---
#
# **Hier stand bis zum 2026-08-23 nichts**, mit der Begründung „die bauen
# hier nicht (Windows-/macOS-Bibliotheken)". Für Windows stimmt das; für den
# mac-Sidecar war es eine Linux-Annahme, die auf einem Mac schlicht falsch
# ist — dort baut er in unter einer Sekunde. Ergebnis: 134 Tests des
# mac-Sidecars und 43 des mac-Labors liefen in KEINEM Gate, weder lokal noch
# in `mac-build.yml` (das nur `cargo build --release` fährt). Sie liefen,
# wenn jemand daran dachte.
#
# Genau das Muster, das dieses Projekt schon zweimal bezahlt hat: ein nicht
# ausgeführter Test sieht in der Ausgabe genauso aus wie ein grüner.
#
# Auf Linux wird gesagt, dass NICHT geprüft wurde — Schweigen läse sich wie
# „geprüft".
mac_crates=""
echo "$changed" | grep -q '^streaming/mac-hq-sidecar/' && mac_crates="$mac_crates streaming/mac-hq-sidecar"
echo "$changed" | grep -q '^streaming/mac-hq-labor/' && mac_crates="$mac_crates streaming/mac-hq-labor"
if [ -n "$mac_crates" ]; then
  if [ "$(uname -s)" = "Darwin" ]; then
    for crate in $mac_crates; do
      # Klammern aus demselben Grund wie oben (bash 3.2 auf macOS).
      echo "  Cargo-Tests ${crate}…"
      ( cd "$crate" && cargo test -q ) \
        || { echo "✗ Cargo-Tests $crate ROT — abgebrochen." >&2; exit 1; }
    done
  else
    echo "⚠  macOS-Kisten geändert ($mac_crates), aber diese Maschine ist kein Mac." >&2
    echo "   Ihre Tests laufen hier NICHT — vor dem Landen auf einem Mac nachfahren." >&2
  fi
fi
