#!/bin/bash
# Halten die Schranken vor dem KMS-Helfer? Zwei Proben, beide mit Kontrolle.
#
# Messakte: profiles/hdr-2026-08-08-kms-helfer-linux.json (M2 und M4).
#
#   A) Ein FREMDER Benutzer am Socket — erst mit den echten Rechten, dann mit
#      absichtlich aufgerissenen. Die zweite Stufe ist die eigentliche Probe:
#      ohne sie waere nur die Datei-Schranke belegt, nicht die im Programm.
#   B) Der Weg durch die ECHTE Flatpak-Sandbox, mit Gegenprobe ohne die
#      Manifest-Zeile.
#
# **Diese Probe setzt Rechte herunter** (`/run/user/<uid>` auf 0711) und stellt
# sie am Ende wieder her — auch bei Abbruch, dafuer sorgt das `trap`. Nicht
# unbeaufsichtigt und nicht auf einer fremden Maschine laufen lassen.
#
# Voraussetzung: der Helfer ist eingerichtet
# (`sudo scripts/pulse-kms-helfer-einrichten.sh`), `sudo` ohne Rueckfrage,
# und fuer B eine installierte `com.howispulse.Pulse`.
set -u

HIER=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
UID_=$(id -u)
LAUFZEIT=${XDG_RUNTIME_DIR:-/run/user/$UID_}
D="$LAUFZEIT/pulse-hq"
S="$D/kms.sock"
HELFER=${PULSE_KMS_HELFER:-/usr/local/libexec/pulse-kms-helfer}
AUSGANG=${1:-}
LOG=$(mktemp)

# Der Client muss fuer einen FREMDEN Benutzer lesbar sein — im Quellbaum ist er
# das in der Regel nicht.
CLIENT=$(mktemp /tmp/kms-helfer-client.XXXXXX.py)
cp "$HIER/kms-helfer-client.py" "$CLIENT"
chmod 644 "$CLIENT"

[ -x "$HELFER" ] || {
	echo "Der Helfer ist nicht eingerichtet ($HELFER)."
	echo "Einmalig: sudo scripts/pulse-kms-helfer-einrichten.sh"
	exit 1
}
if [ -z "$AUSGANG" ]; then
	echo "Aufruf: $0 <Ausgang, z.B. DP-1>"
	exit 1
fi

ALT_LAUFZEIT=$(stat -c %a "$LAUFZEIT")
aufraeumen() {
	sudo -n chmod "$ALT_LAUFZEIT" "$LAUFZEIT" 2>/dev/null
	[ -d "$D" ] && chmod 0700 "$D"
	[ -S "$S" ] && chmod 0600 "$S"
	kill %1 2>/dev/null
	rm -f "$CLIENT" "$LOG"
}
trap aufraeumen EXIT

rm -f "$S"
"$HELFER" --socket "$S" 2>"$LOG" &
sleep 0.5

echo "=== A0  ich selbst, echte Rechte (Kontrolle — muss ein Bild bekommen)"
python3 "$CLIENT" "$S" "$AUSGANG"

echo
echo "=== A1  fremder Benutzer, echte Rechte ($(stat -c %a "$LAUFZEIT")/$(stat -c %a "$D")/$(stat -c %a "$S"))"
sudo -n -u nobody python3 "$CLIENT" "$S" "$AUSGANG"

echo
echo "=== A2  fremder Benutzer, Rechte absichtlich aufgerissen"
sudo -n chmod 0711 "$LAUFZEIT"
chmod 0711 "$D"
chmod 0666 "$S"
echo "    jetzt: $(stat -c %a "$LAUFZEIT")/$(stat -c %a "$D")/$(stat -c %a "$S")"
sudo -n -u nobody python3 "$CLIENT" "$S" "$AUSGANG"

echo
echo "=== A3  ich selbst bei DENSELBEN Rechten (Kontrolle — sonst waere A2 nur ein kaputter Aufbau)"
python3 "$CLIENT" "$S" "$AUSGANG"

sudo -n chmod "$ALT_LAUFZEIT" "$LAUFZEIT"
chmod 0700 "$D"
chmod 0600 "$S"
echo "    wiederhergestellt: $(stat -c %a "$LAUFZEIT")/$(stat -c %a "$D")/$(stat -c %a "$S")"

echo
echo "=== Meldungen des Helfers:"
cat "$LOG"

if ! command -v flatpak >/dev/null || ! flatpak info com.howispulse.Pulse >/dev/null 2>&1; then
	echo
	echo "(B uebersprungen: com.howispulse.Pulse ist nicht installiert)"
	exit 0
fi

echo
echo "=== B1  aus der Flatpak-Sandbox heraus, MIT der Manifest-Zeile"
# Als Laufzeit-Ausnahme nachgestellt, solange die installierte App aelter ist
# als der Zweig. Im Manifest steht dieselbe Zeile.
cp "$CLIENT" "$D/client.py"
flatpak run --filesystem=xdg-run/pulse-hq:create --command=python3 com.howispulse.Pulse \
	"$D/client.py" "$S" "$AUSGANG"

echo
echo "=== B2  Gegenprobe: OHNE die Zeile darf die Sandbox den Socket nicht sehen"
flatpak run --command=sh com.howispulse.Pulse -c "ls '$S' 2>&1 | tail -1"
rm -f "$D/client.py"
