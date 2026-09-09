# Schriften der Landingpage (`/landing.html`)

Beide Schriften werden von der Cloud-Instanz selbst ausgeliefert, damit kein
Besucher-Browser Google Fonts kontaktiert. Variable Schnitte, Latin-Subset,
beide aus fontsource-Paketen (dieselben Bauten wie bei Google Fonts):

- `plus-jakarta-sans-latin-wght.woff2` ist **byteidentisch** mit
  `files/plus-jakarta-sans-latin-wght-normal.woff2` aus
  `@fontsource-variable/plus-jakarta-sans` 5.2.8 — dem Paket, das die App
  ohnehin in `web/package.json` führt (`sha256sum` beider Dateien vergleichen).
- `jetbrains-mono-latin-wght.woff2` stammt aus
  `https://cdn.jsdelivr.net/npm/@fontsource-variable/jetbrains-mono@5.2.6/files/jetbrains-mono-latin-wght-normal.woff2`
  (kein Paket im Repo, deshalb hier die Quelle samt Prüfsumme):
  SHA-256 `18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e`.

| Datei | Schrift | Urheber | Lizenz |
|---|---|---|---|
| `plus-jakarta-sans-latin-wght.woff2` | Plus Jakarta Sans (variabel, 200–800) | Copyright 2020 The Plus Jakarta Sans Project Authors, https://github.com/tokotype/PlusJakartaSans | SIL Open Font License 1.1 |
| `jetbrains-mono-latin-wght.woff2` | JetBrains Mono (variabel, 100–800) | Copyright 2020 The JetBrains Mono Project Authors, https://github.com/JetBrains/JetBrainsMono | SIL Open Font License 1.1 |

Der vollständige Lizenztext der SIL Open Font License 1.1 steht in
`streaming/pulse-player/assets/fonts/LICENSE.md` (dieselbe Lizenz, dieselbe
Schrift Plus Jakarta Sans) und unter https://openfontlicense.org.
