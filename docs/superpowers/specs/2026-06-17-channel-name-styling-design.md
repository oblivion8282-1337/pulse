# Kanalnamen einfärben (Channel Name Styling)

**Datum:** 2026-06-17
**Branch:** feat/name-gradient-editor
**Status:** Design abgenommen, bereit für Implementierungsplan

## Ziel

Kanäle in der Seitenleiste sehen aktuell alle gleich aus (gleiche Farbe, nur `#`-
bzw. Lautsprecher-Icon unterscheidet Text- von Sprachkanal). Es soll möglich sein,
**einzelne Kanäle gezielt einzufärben** — manuell, pro Kanal — um sie hervorzuheben
und die Orientierung zu erleichtern.

Das Feature ist **kein** automatischer Typ-Unterschied („alle Sprachkanäle grün").
Es ist ein manuelles Highlight-/Theming-Werkzeug, das die bereits existierende
Username-Gradient-Mechanik wiederverwendet.

## Nicht-Ziele

- Keine automatische Unterscheidung Text- vs. Sprachkanal (bewusst verworfen).
- Keine pro-Benutzer-Einfärbung von Kanälen — die Farbe ist eine Eigenschaft des
  Kanals, für alle Mitglieder gleich.
- Keine Animationen / bewegte Verläufe.

## Wiederverwendete Grundlage (Username-Gradient)

Das Username-Feature liefert die komplette Mechanik, die hier gespiegelt wird:

- **Editor:** `web/src/lib/components/settings/NameColorEditor.svelte` — Color-Ramp-
  Bar mit zwei Farbgriffen, „Farbe verwenden"-Toggle, „Verlauf verwenden"-Toggle und
  vier Richtungs-Buttons (90°/135°/180°/45°).
- **CSS-Helfer:** `web/src/lib/utils/nameColor.ts`
  - `gradientTextStyle(c1, c2, angle)` → Inline-Style mit `linear-gradient(...)` +
    `background-clip: text` + transparenter Schrift.
  - `sanitizeProfileColor()` (Hex-Regex) und `sanitizeGradientAngle()` (0–360-Clamp).
- **Datenmodell-Vorbild:** `User.profile_color` / `profile_color_secondary` /
  `profile_gradient_angle` (auth-svc) + Spiegel in `CachedUserProfile` (chat-gateway).
- **Validierung:** Hex-only Regex + Winkel 0–360 in
  `services/auth/src/dcc_auth/schemas_profile.py` (gegen CSS-Injection).

## Datenmodell

Drei neue, nullable Spalten an der **`channels`**-Tabelle (chat-gateway, da Kanäle
dort leben — kein auth-svc-Bezug):

| Spalte | Typ | Bedeutung |
|---|---|---|
| `name_color` | `String(32)`, nullable | Primärfarbe als Hex (`#rrggbb`). NULL = keine Farbe (Standardgrau wie heute). |
| `name_color_secondary` | `String(32)`, nullable | Zweite Farbe. NULL = einfarbig; gesetzt = Verlauf von `name_color` → `name_color_secondary`. |
| `name_gradient_angle` | `SmallInteger`, nullable | Winkel 0–360. NULL = 90° (links→rechts). |

- Alle nullable → SQLite-Test-kompatibel, keine Backfill nötig (NULL = heutiges
  Verhalten).
- Alembic-Migration in `services/chat-gateway/alembic/versions/` (Revision-ID
  ≤ 32 Zeichen beachten).

## Frontend

### Typen & API

- `Channel`-Typ in `web/src/lib/api/types.ts` um `name_color?`,
  `name_color_secondary?`, `name_gradient_angle?` erweitern (string|null bzw.
  number|null), exakt parallel zum `User`-Typ.
- Update-Endpunkt: Die bestehende Kanal-Update-Route (dieselbe, die Umbenennen
  bedient) nimmt die drei neuen Felder entgegen. Berechtigung: `MANAGE_CHANNELS`
  (identisch zum Umbenennen). Hex- und Winkel-Validierung serverseitig wie beim
  Profil.
- Änderung wird wie andere Kanal-Updates per WebSocket an die Mitglieder
  gebroadcastet, damit die Farbe live erscheint.

### Editor

- `NameColorEditor.svelte` so verallgemeinern, dass er entkoppelte Werte
  (color1/color2/angle/enabled) über Props + Callback bedient, statt direkt den
  Profil-Store zu schreiben. Beide Aufrufer (Profil-Einstellungen, Kanal-
  Einstellungen) nutzen dieselbe Komponente.
- Falls die Komponente dadurch über die Größen-Policy (Svelte ≤ 250 Z.) wächst:
  Logik in einen kleinen Helfer auslagern.
- **Presets:** Eine kleine Reihe vorgefertigter Farb-/Verlauf-Presets zum Anklicken
  (z. B. 6–8 Stück: einfarbige Akzente + ein paar Verläufe). Beim Klick werden
  color1/color2/angle/enabled gesetzt. Presets als Konstante im Editor bzw. in
  `nameColor.ts`. Presets sind für Profil und Kanal nutzbar.
- Der Editor erscheint im Kanal-Bearbeiten-Dialog (dort, wo umbenannt wird).

### Rendering

Der Kanalname wird überall mit `gradientTextStyle()` (bzw. einfarbig) gerendert,
wo er heute steht:

1. **Seitenleiste** — `web/src/lib/components/ChannelList.svelte` (Text- und
   Sprachkanal-Items).
2. **Chat-Titel oben** — die Kopfzeile, die den aktuellen Kanalnamen zeigt.
3. **Schnell-Wechsler (Strg+K)** — `web/src/lib/components/QuickSwitcher.svelte`.

Ein kleiner Helfer analog `nameStyle()` (z. B. `channelNameStyle(channel)`) in
`nameColor.ts` kapselt: keine Farbe → `''`; nur color1 → `color: c1`; color1+color2
→ `gradientTextStyle(...)`. Aktiv-/Unread-Zustände müssen weiterhin funktionieren:
bei gesetztem Gradient gewinnt die Kanalfarbe über die Standard-Aktiv-Textfarbe;
das Aktiv-Hintergrund-Highlight (`accent-soft`) bleibt unverändert.

## Sicherheit

- Nur Hex-Farben (Regex), nur ganzzahlige Winkel 0–360 — identisch zum Profil,
  keine freie CSS-Eingabe.
- Berechtigung `MANAGE_CHANNELS` serverseitig erzwungen (nicht nur UI).

## Tests

- Backend: Migration + Update-Route mit Farb-/Winkel-Validierung und
  Permission-Check (pytest, `services/chat-gateway/tests/`).
- Frontend: `pnpm check` + `pnpm build` grün; `channelNameStyle()`-Logik so
  strukturieren, dass sie offensichtlich korrekt ist (Editor-Preview nutzt
  denselben Pfad → WYSIWYG).
- E2E (manuell/optional): Kanal einfärben, Reload, Farbe bleibt; in Seitenleiste +
  Titel + Schnell-Wechsler sichtbar.

## Changelog

User-facing → Eintrag in `web/static/changelog.json` nötig (Stilvorschläge dem
User vorlegen, keine Emojis).

## Offene Detailfragen für den Plan

- Genaue Preset-Palette (welche 6–8 Farben/Verläufe).
- Ob die Kanalfarbe auch im aktiven Zustand voll greift oder dort leicht gedämpft
  wird (Lesbarkeit auf `accent-soft`-Hintergrund) — im Plan visuell prüfen.
