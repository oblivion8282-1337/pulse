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
# nötige Umgebung, und bräche den Bau eines unveränderten Crates. Und
# pulse-whip: die zieht webrtc, tokio und anyhow (214 Kisten im
# Abhängigkeitsbaum gegen 1 bei pulse-fernsteuerung), ist also weder
# abhängigkeitsfrei noch schnell — und ihr `cargo test` löste webrtc von
# crates.io auf, nicht über den gepatchten Zweig, den Player und die
# Sidecars tatsächlich ausliefern; das Gate prüfte damit eine andere
# Abhängigkeit als die ausgelieferte. pulse-whip bleibt deshalb aussen vor
# und läuft weiterhin in KEINEM Gate — eine offene Rechnung, kein Versehen.
for kiste in $(echo "$changed" | sed -n 's|^\(streaming/pulse-[a-z-]*\)/.*|\1|p' | sort -u); do
  [ "$kiste" = "streaming/pulse-player" ] && continue
  [ "$kiste" = "streaming/pulse-whip" ] && continue
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
ffmpeg_prefix="${PULSE_FFMPEG_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/pulse/ffmpeg/prefix}"
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
