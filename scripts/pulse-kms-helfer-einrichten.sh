#!/bin/sh
# Richtet den Pulse-KMS-Helfer ein — das einzige Stueck Pulse mit erhoehten
# Rechten. Einmal ausfuehren, mit Passwort; danach kann Pulse unter Linux HDR
# senden.
#
# WOZU: Der Kernel gibt die Bildpuffer eines Bildschirmausgangs (die
# GEM-Handles aus DRM_IOCTL_MODE_GETFB2) nur an DRM-Master oder an Traeger von
# CAP_SYS_ADMIN heraus. Ein Flatpak kann diese Faehigkeit nicht tragen: die
# Sandbox setzt no_new_privs, gesetzte Datei-Faehigkeiten verfallen beim
# Betreten. Also haelt sie ein kleines Programm ausserhalb der Sandbox.
#
# WARUM setcap UND NICHT setuid root: `setuid root` gaebe dem Programm alle
# Faehigkeiten des Systems und eine zweite Kennung dazu; `cap_sys_admin+ep`
# gibt genau die eine, an der der Kernel diese ioctl festmacht, und laesst die
# Kennung des Nutzers unangetastet. gpu-screen-recorder macht es ebenso
# (extra/meson_post_install.sh).
#
# Mehrfach ausfuehren ist unschaedlich: das Ziel wird ersetzt, die Faehigkeit
# neu gesetzt. Wieder loswerden: dieses Skript mit --entfernen.

set -eu

ZIEL_DIR=/usr/local/libexec
ZIEL="$ZIEL_DIR/pulse-kms-helfer"
SKRIPT_ZIEL="$ZIEL_DIR/pulse-kms-helfer-einrichten"

meldung() { printf '%s\n' "$*" >&2; }

fehler() {
	meldung "Fehler: $*"
	exit 1
}

entfernen() {
	entfernt=0
	for f in "$ZIEL" "$SKRIPT_ZIEL"; do
		if [ -e "$f" ]; then
			rm -f -- "$f" || fehler "$f liess sich nicht entfernen"
			meldung "entfernt: $f"
			entfernt=1
		fi
	done
	# Das Verzeichnis gehoert nicht uns — nur weg, wenn wir es leer
	# zuruecklassen. `rmdir` scheitert von selbst, wenn noch etwas darin liegt.
	rmdir "$ZIEL_DIR" 2>/dev/null || true
	[ "$entfernt" = 1 ] || meldung "es war nichts installiert"
	meldung "Der Pulse-KMS-Helfer ist entfernt. Pulse laeuft weiter; nur HDR"
	meldung "faellt damit wieder weg."
	exit 0
}

# --- Argumente --------------------------------------------------------------
QUELLE=""
while [ $# -gt 0 ]; do
	case "$1" in
	--entfernen) ENTFERNEN=1 ;;
	--binary)
		shift
		QUELLE="${1:-}"
		;;
	--hilfe | -h)
		cat <<'ENDE'
pulse-kms-helfer-einrichten [--binary <pfad>] [--entfernen]

  (ohne Argumente)  richtet den Helfer ein (kopieren + Berechtigung setzen)
  --entfernen       nimmt ihn vollstaendig wieder weg
  --binary <pfad>   nimmt dieses Programm statt des selbst gefundenen

Braucht root (sudo). Mehrfach ausfuehrbar.
ENDE
		exit 0
		;;
	*) fehler "unbekanntes Argument: $1 (--hilfe zeigt die erlaubten)" ;;
	esac
	shift
done

[ "$(id -u)" = 0 ] || fehler "bitte mit sudo ausfuehren"

# Nicht als `[ … ] && entfernen` schreiben: unter `set -e` beendet die falsche
# Seite dieser Verkettung das ganze Skript mit Rueckgabewert 1.
if [ "${ENTFERNEN:-0}" = 1 ]; then
	entfernen
fi

# --- Quelle finden ----------------------------------------------------------
# Kein geratener Flatpak-Pfad: das Skript liegt NEBEN dem Programm, das es
# installiert (im Flatpak unter /app/libexec, im Quellbaum wird der Bau-Pfad
# geprueft). Wer den Pfad selbst kennt, gibt ihn mit --binary.
SKRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
if [ -z "$QUELLE" ]; then
	for k in \
		"$SKRIPT_DIR/pulse-kms-helfer" \
		"$SKRIPT_DIR/../streaming/linux-hq-sidecar/target/release/pulse-kms-helfer"; do
		[ -f "$k" ] && QUELLE="$k" && break
	done
fi
[ -n "$QUELLE" ] || fehler "der Helfer wurde nicht gefunden.
Im Quellbaum zuerst bauen:  cd streaming/linux-hq-sidecar && cargo build --release
Sonst den Pfad angeben:     --binary <pfad>"
[ -f "$QUELLE" ] || fehler "$QUELLE gibt es nicht"

# --- Quelle pruefen ---------------------------------------------------------
# Hier wird gleich eine Systemberechtigung erteilt. Was nicht plausibel ist,
# wird NICHT installiert — lieber ein Abbruch mit Grund als ein beliebiges
# Programm mit CAP_SYS_ADMIN.
[ -x "$QUELLE" ] || fehler "$QUELLE ist nicht ausfuehrbar"
case "$(head -c 4 "$QUELLE" | od -An -tx1 | tr -d ' \n')" in
7f454c46) ;;
*) fehler "$QUELLE ist kein ausfuehrbares Programm (ELF)" ;;
esac
# Es muss sich selbst als der Helfer zu erkennen geben. Das ist die Probe, die
# ein zufaellig gleichnamiges Programm nicht besteht.
AUSKUNFT=$("$QUELLE" --fassung 2>/dev/null) || fehler "$QUELLE laesst sich nicht befragen"
case "$AUSKUNFT" in
"pulse-kms-helfer Protokollfassung "*) ;;
*) fehler "$QUELLE meldet sich nicht als Pulse-KMS-Helfer" ;;
esac

command -v setcap >/dev/null 2>&1 ||
	fehler "setcap fehlt. Es steckt im Paket libcap (Debian/Ubuntu: libcap2-bin, Fedora: libcap, Arch: libcap)."

# --- Einrichten -------------------------------------------------------------
install -d -m 0755 "$ZIEL_DIR"
# Erst daneben legen, dann umbenennen: ein Abbruch mitten im Kopieren liesse
# sonst ein halbes Programm mit gesetzter Berechtigung zurueck.
TMP="$ZIEL.neu.$$"
trap 'rm -f "$TMP"' EXIT
install -m 0755 "$QUELLE" "$TMP"
setcap cap_sys_admin+ep "$TMP" || fehler "setcap ist fehlgeschlagen (Dateisystem mit nosuid oder ohne Erweiterungsattribute?)"
mv -f "$TMP" "$ZIEL"
trap - EXIT

# Das Skript selbst mitkopieren, damit --entfernen auch dann noch erreichbar
# ist, wenn Pulse laengst deinstalliert wurde.
install -m 0755 "$0" "$SKRIPT_ZIEL" 2>/dev/null || true

meldung "Eingerichtet: $ZIEL ($AUSKUNFT)"
meldung "Berechtigung: $(getcap "$ZIEL" 2>/dev/null || echo 'cap_sys_admin+ep')"
meldung ""
meldung "HDR-Streams in Pulse funktionieren ab sofort ohne weitere Abfrage."
meldung "Wieder entfernen:  sudo $SKRIPT_ZIEL --entfernen"
