#!/usr/bin/env bash
# Tippbare Flächen ohne zugänglichen Namen (iOS-Liste Punkt 38, VoiceOver-Basis).
#
# WAS ES PRÜFT. Jede `<button>`/`<Button>` in den mobilen Komponenten und den
# App-Routen muss einen Namen haben: sichtbaren Text, einen
# Nachrichtenaufruf (`{m.…}`) im Inhalt, oder `aria-label`/`aria-labelledby`/
# `title` am Tag. Ein Knopf, der nur ein Symbol enthält, ist für VoiceOver
# sonst „Taste" — und nichts weiter.
#
# WARUM NICHT ALS PLAYWRIGHT-TEST. Ein E2E-Lauf bräuchte den lokalen Stack und
# hängt in keinem Gate (s. CLAUDE.md: „Playwright hängt in KEINEM Gate"), wäre
# also genau die Sorte Prüfung, die aussieht wie grün, weil sie nie läuft.
# Dieses Skript läuft überall in einer Sekunde.
#
# WAS ES NICHT KANN. Es liest Markup, nicht den Barrierefreiheits-Baum: ein
# `aria-label` mit sinnlosem Inhalt besteht, und ein Name, der erst zur
# Laufzeit aus einer Variablen entsteht, kann es nicht beurteilen. Es findet
# die Klasse Fehler „gar kein Name", nicht „schlechter Name".
set -u
cd "$(dirname "$0")/.."

python3 - "$@" <<'PY'
import pathlib, re, sys

def tag_ende(s, start):
    """Erstes '>' das NICHT zu '=>' gehört und nicht in {} steckt."""
    tiefe = 0
    for i in range(start, len(s)):
        c = s[i]
        if c == '{':
            tiefe += 1
        elif c == '}':
            tiefe -= 1
        elif c == '>' and tiefe == 0 and s[i - 1] != '=':
            return i
    return -1

ORTE = ["web/src/lib/components/mobile", "web/src/routes/app"]
treffer = []
geprueft = 0
for ort in ORTE:
    for p in sorted(pathlib.Path(ort).rglob("*.svelte")):
        s = p.read_text()
        for m in re.finditer(r"<(button|Button)\b", s):
            geprueft += 1
            ende = tag_ende(s, m.start())
            if ende < 0:
                continue
            tag = s[m.start():ende + 1]
            if any(a in tag for a in ("aria-label", "aria-labelledby", "title=")):
                continue
            schluss = s.find(f"</{m.group(1)}>", ende)
            inhalt = s[ende + 1:schluss] if schluss > 0 else ""
            if "{m." in inhalt:
                continue
            if re.search(r"[A-Za-zÄÖÜäöüß]{3}", re.sub(r"<[^>]*>", "", inhalt)):
                continue
            treffer.append(f"{p}:{s[:m.start()].count(chr(10)) + 1}")

print(f"── Tippbare Flächen ohne zugänglichen Namen ({geprueft} geprüft) ──")
if treffer:
    for t in treffer:
        print(f"  ✗ {t}")
    print(f"\n✗ {len(treffer)} ohne Namen — VoiceOver liest dort nur „Taste\".")
    sys.exit(1)
print("  ✓ keine")
print("\n✓ VoiceOver-Basis grün.")
PY
