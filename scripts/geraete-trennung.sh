#!/usr/bin/env bash
# Geräte-Trennungs-Gate — die durchsetzbare Fassung der Regel „Mobile-Design
# vermischt sich nicht mit Desktop".
#
# Der Hintergrund: Mobile-Verhalten lebte als Viewport-Ifs und `md:`-Klassen
# INNERHALB geteilter Komponenten. Jede Mobile-Änderung berührte dieselben
# Zeilen, die Desktop rendert — und umgekehrt (Folge: die Serie „fix(web): …
# am Handy kaputt" und der 22-Dateien-Merge vom 2026-09-05). Die Regel dagegen:
#
#   1. **Die Geräte-Entscheidung fällt an EINEM Ort pro Bildschirm** — in der
#      Route (+layout bzw. +page) oder in `lib/components/mobile/`. Die wählt
#      die Komponenten-Variante; geteilte Komponenten bekommen ihr Verhalten
#      als Props, ohne selbst zu fragen, auf welchem Gerät sie laufen.
#   2. **Keine CSS-Breakpoint-Varianten** (`md:`, `lg:`, `max-md:` …) mehr.
#      Seit „Ansicht folgt dem Gerät" (2026-09-04, `geraetKlasse.ts`) hängt
#      die Anordnung an der GERÄTEKLASSE — ein Breakpoint an der Fensterbreite
#      baut still die Anordnung der falschen Klasse. Feinjustierung der Größe
#      innerhalb einer Klasse braucht keinen Breakpoint, sondern konkrete
#      Werte oder einen vom Route-Kontext gereichten Prop.
#
# Erlaubte Orte für `viewport.*`: `web/src/routes/**` (Kompositions-Punkte),
# `web/src/lib/components/mobile/**` (bedingungslos mobile Komponenten) und
# der Store selbst. Alles andere ist eine Verletzung — die hier gelistet und
# (über gate.sh) beim Landen blockiert wird.
#
# Aufruf:
#   bash scripts/geraete-trennung.sh           # prüfen, Verletzungen listen
set -euo pipefail

fail=0

# ── 1. viewport.* außerhalb der erlaubten Orte ───────────────────────────────
echo "── viewport.* außerhalb von routes/, components/mobile/, Store ──"
# Ausnahmen, jede mit Begründung — bewusst HIER im Skript statt still im Code,
# damit jede Ausnahme im Review auffällt. Neue Einträge nur mit Grund.
AUSNAHMEN=(
  # WS-Handler: globale Benachrichtigungs-Politik (Toast nur am Rechner) —
  # sie hängt in keinem UI-Baum, Props von einer Route sind hier unmöglich.
  web/src/lib/ws/handlers/chat.ts
  web/src/lib/ws/handlers/postfachBenachrichtigung.ts
  # Reiter-Auswahl: reine Datenfunktion ohne Mount-Punkt im Routenbaum.
  web/src/lib/components/settings/reiterAuswahl.svelte.ts
  # PiP-Fenster des Watch-Streams: schwebt ÜBER den Routen, es gibt keinen
  # Mount-Punkt, an dem eine Variante gewählt werden könnte — der Zeigertyp
  # (Finger vs Maus) ist hier selbst Teil des Verhaltens.
  web/src/lib/watch/WatchBackgroundFrame.svelte
)
ausnahmen_regex="$(printf '%s|' "${AUSNAHMEN[@]}" | sed 's/|$//; s/\./\\./g')"
# git ls-files statt find: Forward-Slashes auch unter Windows (Backslash-Pfade
# brechen xargs/sed still — die Falle stand hier schon einmal).
treffer="$(git ls-files 'web/src/**/*.svelte' 'web/src/**/*.ts' \
  | grep -vE '^web/src/(routes/|lib/components/mobile/|lib/stores/(viewport|geraetKlasse))' \
  | grep -vE "^($ausnahmen_regex)$" \
  | xargs -r grep -lnE 'viewport\.(isMobile|isTablet|isDesktop|geraet|zeigerGrob|width|height)' || true)"
if [ -n "$treffer" ]; then
  echo "$treffer" | sed 's/^/  ✗ /'
  echo "  → Die Geräte-Frage gehört der Route: Variante dort wählen und der"
  echo "    Komponente als Prop reichen, oder nach components/mobile/ ziehen."
  fail=1
else
  echo "  ✓ keine"
fi

# ── 2. Breakpoint-Varianten in Svelte-Dateien ───────────────────────────────
echo "── Breakpoint-Varianten (sm:/md:/lg:/xl:/2xl:/max-*:) in web/src ──"
# Auch .ts: Tailwind-Klassen stehen teils in Konstanten (z. B. channels/stil.ts).
bptreffer="$(git ls-files 'web/src/**/*.svelte' 'web/src/**/*.ts' \
  | grep -vE '^web/src/(tests/|lib/stores/geraetKlasse)' \
  | xargs -r grep -lnE '(^|[^a-zA-Z0-9-])(sm|md|lg|xl|2xl|max-sm|max-md|max-lg|max-xl):[a-zA-Z[]' || true)"
if [ -n "$bptreffer" ]; then
  echo "$bptreffer" | sed 's/^/  ✗ /'
  echo "  → Basis-Klasse = Handy-Wert behalten, Desktop-Wert ohne Präfix setzen"
  echo "    (nur-desktop-Komponenten) oder als Prop/Variante ausdrücken (geteilt)."
  fail=1
else
  echo "  ✓ keine"
fi

# ── 3. @media-Blöcke in Svelte-Style-Sections ───────────────────────────────
echo "── @media-Blöcke in Svelte-Komponenten ──"
mediatreffer="$(git ls-files 'web/src/**/*.svelte' \
  | xargs -r grep -lnE '@media[^{]*(min-width|max-width)' || true)"
if [ -n "$mediatreffer" ]; then
  echo "$mediatreffer" | sed 's/^/  ✗ /'
  fail=1
else
  echo "  ✓ keine"
fi

if [ "$fail" = 1 ]; then
  echo "✗ Geräte-Trennung verletzt — s. Liste oben." >&2
  exit 1
fi
echo "✓ Geräte-Trennung grün."
