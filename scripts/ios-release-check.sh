#!/usr/bin/env bash
# Release-Vorprüfung der iOS-Hülle (Punkt 14 der iOS-Liste).
#
# WARUM ALS SKRIPT. Dieselbe Liste stand als Prosa in
# `docs/plans/ios-roadmap.md`, und sie veraltete genau so, wie dieses Repo es
# an anderer Stelle schon teuer gelernt hat: sie nannte ZWEI eigene
# Swift-Plugins, während vier im Baum lagen (2026-10-08). Die beiden fehlenden
# hätte ein `cap sync` lautlos aus `packageClassList` geworfen — alles baut
# durch, und erst am Gerät fällt auf, dass Audio-Steuerung, Lagen-Riegel,
# Wachhalten oder Bewertungsfrage nichts tun.
#
# Deshalb LEITET dieses Skript die Plugin-Liste aus dem Quellcode AB, statt sie
# zu behaupten. Eine neue Swift-Datei mit `CAPBridgedPlugin` wird damit
# automatisch mitgeprüft, ohne dass jemand eine Liste nachzieht.
#
# Kein Gate in `gate.sh`: diese Prüfung gilt vor einem STORE-/TestFlight-Bau,
# nicht vor jedem Commit. Die geprüfte Datei `mobile/capacitor.config.json`
# steht im Alltag absichtlich auf einer Dev-URL (so arbeiten wir), ein
# Alltags-Gate wäre dauerhaft rot und damit wirkungslos.
set -u

cd "$(dirname "$0")/.."
IOS=mobile/ios/App/App
fehler=0
meld() { printf '  %s %s\n' "$1" "$2"; }
schlecht() { meld "✗" "$1"; fehler=$((fehler + 1)); }
gut() { meld "✓" "$1"; }

echo "── 1. Hülle zeigt auf die Produktion ──"
url=$(python3 -c "import json;print(json.load(open('mobile/capacitor.config.json'))['server']['url'])" 2>/dev/null)
# Fehlt der Schlüssel, ist das KORREKT — Capacitors Vorgabe ist `false`.
# Eine erste Fassung verlangte ihn ausdrücklich und hätte die saubere Datei rot
# gemeldet; ein Prüfskript, das Richtiges beanstandet, wird abgeschaltet.
klar=$(python3 -c "import json;print(json.load(open('mobile/capacitor.config.json'))['server'].get('cleartext', False))" 2>/dev/null)
[ "$url" = "https://howispulse.com/app" ] && gut "server.url = $url" || schlecht "server.url = ${url:-?} (erwartet https://howispulse.com/app)"
[ "$klar" = "False" ] && gut "cleartext ist aus" || schlecht "cleartext = ${klar:-?} (erwartet false oder weggelassen)"

echo "── 2. Eigene Swift-Plugins in packageClassList ──"
# Aus dem Quellcode: jede Datei mit CAPBridgedPlugin, Klassenname aus @objc(...)
eigene=$(grep -l "CAPBridgedPlugin" "$IOS"/*.swift 2>/dev/null \
  | xargs -r grep -ho '@objc([A-Za-z0-9_]*)' \
  | sed 's/@objc(//; s/)//' | sort -u)
if [ -z "$eigene" ]; then
  schlecht "keine eigenen Plugins gefunden — stimmt der Pfad $IOS noch?"
else
  liste=$(python3 -c "import json;print(' '.join(json.load(open('$IOS/capacitor.config.json'))['packageClassList']))" 2>/dev/null)
  if [ -z "$liste" ]; then
    schlecht "$IOS/capacitor.config.json fehlt oder hat keine packageClassList (die Datei ist gitignored — auf einer frischen Maschine ist sie IMMER unvollständig)"
  else
    for k in $eigene; do
      case " $liste " in
        *" $k "*) gut "$k" ;;
        *) schlecht "$k fehlt in packageClassList — das Plugin tut am Gerät nichts" ;;
      esac
    done
  fi
fi

echo "── 3. Store-Pflichtangaben ──"
[ -f "$IOS/PrivacyInfo.xcprivacy" ] && gut "PrivacyInfo.xcprivacy" || schlecht "PrivacyInfo.xcprivacy fehlt (App-Store-Pflicht)"
grep -q "NSLocalNetworkUsageDescription" "$IOS/Info.plist" \
  && gut "NSLocalNetworkUsageDescription" \
  || schlecht "NSLocalNetworkUsageDescription fehlt (Self-Host im Heimnetz wird still blockiert)"

echo "── 4. Nichts Lokales im Bundle ──"
git check-ignore -q web/.cert 2>/dev/null \
  && gut "web/.cert ist gitignored" \
  || schlecht "web/.cert ist NICHT gitignored — mkcert-Zertifikat darf nie mitreisen"

echo
if [ "$fehler" -eq 0 ]; then
  echo "✓ Release-Vorprüfung grün."
else
  echo "✗ $fehler Punkt(e) offen — NICHT bauen."
fi
exit "$fehler"
