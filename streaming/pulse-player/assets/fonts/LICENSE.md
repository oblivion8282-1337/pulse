# Herkunft und Lizenz der Schrift

`PlusJakartaSans-Regular.ttf` und `-SemiBold.ttf` sind **Plus Jakarta Sans**,
dieselbe Schrift, die die Web-App benutzt (`--font-sans` in `web/src/app.css`).
Damit steht in der Leiste des Player-Fensters derselbe Text wie in der App.

## Wie sie entstanden sind

Aus `@fontsource-variable/plus-jakarta-sans` (liegt in `web/node_modules/`).
Das Paket liefert nur `.woff2`; der Schrift-Zeichner im Player braucht `.ttf`:

```bash
python3 - <<'PY'
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
f = TTFont("…/files/plus-jakarta-sans-latin-wght-normal.woff2")
f.flavor = None
f.save("/tmp/variabel.ttf")
for gewicht, name in ((400, "Regular"), (600, "SemiBold")):
    g = TTFont("/tmp/variabel.ttf")
    instancer.instantiateVariableFont(g, {"wght": gewicht}, inplace=True)
    g.save(f"PlusJakartaSans-{name}.ttf")
PY
```

**Warum feste Schnitte statt der variablen Datei:** So haengt das Schriftbild
nicht davon ab, welche Achsenstellung die Schrift-Bibliothek des Players von
sich aus waehlt. 400 und 600 sind die beiden Staerken, die die Leiste braucht.

## Lizenz

Plus Jakarta Sans steht unter der **SIL Open Font License 1.1** — permissiv,
Einbetten und Weitergabe ausdruecklich erlaubt, mit Namensnennung. Voller Text:
<https://github.com/tokotype/PlusJakartaSans/blob/master/OFL.txt>

Copyright 2020 The Plus Jakarta Sans Project Authors
(<https://github.com/tokotype/PlusJakartaSans>)
