# Design-Vereinheitlichung — Bestandsaufnahme

Erhoben am 2026-07-19 über `web/src` (308 `.svelte`-Dateien, davon 72 Vendor unter
`lib/components/ui/`). Reine Ist-Aufnahme plus Vorschlag zur Reihenfolge — noch
nichts umgebaut.

---

## Die Wurzel: zwei parallele Token-Systeme

`web/src/app.css` definiert **zwei** Farbvokabulare für dieselben Rohwerte:
das shadcn-Set (`--foreground`, `--muted-foreground`, `--card`, …) und ein
eigenes Alias-Set (`--color-text-bright`, `--color-bg-hover`, …, L14–36).

In der Praxis hat das Eigen-Set gewonnen, das shadcn-Set ist fast tot:

| Eigen-Token | Treffer | shadcn-Äquivalent | Treffer |
|---|---|---|---|
| `text-text-muted` | 637 | `text-muted-foreground` | 56 |
| `text-text-bright` | 328 | `text-foreground` | 6 |
| `bg-bg-hover` | 261 | `bg-accent` | – |
| `bg-bg-input` | 176 | `bg-input` | – |
| `text-text-base` | 134 | `text-foreground` | 6 |
| `bg-bg-panel` | 14 | `bg-card` | 12 |

`border-border` (282) ist der einzige shadcn-Token mit echter Verbreitung.

**Der Vendor-Code unter `ui/` spricht durchgängig shadcn, der App-Code spricht
das Eigen-Set.** Zwei Vokabulare für identische Werte — das ist die eigentliche
Ursache dafür, dass Baukasten und App auseinanderlaufen. Es erklärt auch den
Button-Befund unten.

## Der Baukasten passt nicht mehr zur App

- **302 rohe `<button>` gegen 146 Verwendungen der Button-Komponente** (2:1),
  verteilt auf 126 bzw. 76 Dateien; 23 Dateien mischen beides.
- Die Komponente erzwingt in ihrer Basis **`rounded-full`**. Von den rohen
  Buttons nutzen **120 von 145** `rounded-md`/`lg`/`xl`.
- Die Komponente kennt `destructive` **nur als zarte Tönung**; die App benutzt an
  mehreren Stellen einen **voll gefüllten** roten Button, den es dort nicht gibt.
- `default` ist in der Komponente ein **Farbverlauf mit Schatten**; die App
  verwendet flaches `bg-primary`.

**Folge:** Ein stumpfes Umstellen der rohen Buttons auf die Komponente wäre kein
Vereinheitlichen, sondern ein Redesign — überall Pillen statt Rechtecke.

**Empfehlung: erst die Komponente an die App anpassen, dann migrieren.** Die App
ist die De-facto-Designsprache (Mehrheitsverhältnis 2:1, in sich stimmig: flach,
`rounded-md`, klare Farben); die Komponente ist der kaum angefasste
shadcn-Auslieferungszustand.

---

## Befunde nach Wirkung sortiert

### 1. Acht native `window.confirm()` (höchste Sichtbarkeit, kleinster Aufwand)

Ein Systemdialog des Betriebssystems mitten in der Oberfläche. Fundstellen:
`components/popoverActions.ts:269` und `:287` · `settings/SettingsKeyboard.svelte:87`
und `:108` · `DropboxView.svelte:81` · `dropbox/DropboxViewModel.svelte.ts:485` ·
`admin/AdminCommunities.svelte:95` · `friends/FriendList.svelte:103` ·
`routes/app/guilds/[guildId]/channels/[channelId]/+page.svelte:468` ·
`routes/app/@me/[[dmChannelId]]/+page.svelte:233`

Für dieselbe Frage existieren parallel **drei** Antworten: `alert-dialog` aus dem
Baukasten (15 Dateien), `window.confirm` (8), und ein „armed"-Zweiklick-Button,
der beim ersten Klick die Beschriftung wechselt
(`PopoverActions.svelte:259-277` Kick, `:279-297` Ban).

### 2. Statusfarben ohne Tokens

Es gibt **nur `--destructive`**. Für Erfolg und Warnung existiert **kein Token**,
also wird jedes Mal von Hand gemischt:

- **Fehler**: `text-red-400` (69), `text-red-300` (12), `text-red-200` (6),
  `text-red-500` (4), `text-rose-400` (3) — zusammen ~185 Palettenklassen gegen
  23 `text-destructive`
- **Erfolg**: zwei konkurrierende Grün-Familien — `emerald-*` (49) und `green-*` (7)
- **Warnung**: drei Familien — `amber-*` (55), `yellow-*` (4), `orange-*` (2)

Badge-Muster werden dabei jeweils neu erfunden, mit vier verschiedenen
Deckkraft-/Ton-Kombinationen für dieselbe Sache: `settings/SessionsSection.svelte:130`
· `admin/AdminSmtp.svelte:159` · `account/SelfHostApplication.svelte:114` ·
`account/BootstrapConsumedPanel.svelte:16`

Hartkodierte Hex-Farben sind dagegen **kein** Problem (nur 39, fast alle legitim
in Datengeneratoren wie `utils/nameColor.ts`).

### 3. Wiederkehrende Zustände ohne gemeinsame Komponente

- **Leerer Zustand**: **11 Varianten**, keine `EmptyState`-Komponente. Größen
  `text-xs`/`text-sm`, sechs verschiedene Innenabstände, mal mittig mal
  linksbündig. Kein einziger hat Icon oder Handlungsangebot.
- **Ladezustand**: **4 grundverschiedene Sprachen** — reine Textzeile (17
  Stellen, selbst in drei Größen), Spinner (4 Größen/Icons), Skeleton (2 Stellen,
  ohne gemeinsame Komponente), Button-Beschriftungswechsel (15 Stellen mit
  8 verschiedenen Zustandsvariablen: `busy`, `saving`, `isSaving`, `bulkBusy`, …).
- **Fehlermeldung am Feld**: 33 `{#if error}`-Blöcke, drei Farben, drei Größen,
  wechselnde Klassenreihenfolge. Die `alert`-Komponente wird **null Mal**
  außerhalb von `ui/` benutzt.

### 4. Buttons — konkrete Widersprüche

- **Abbrechen in fünf Ausprägungen**: mit Rahmen (`AdminInstancesActive:201`),
  ohne (`DropboxRenameDialog:38`), gefüllt (`ReportMessageDialog:208`), als
  Textlink (`LoginMfaForm:200`), kleiner mit Rahmen (`BootstrapConsumedPanel:26`).
  Im Dialog-Footer zusätzlich `variant="ghost"` vs. `"secondary"` vs.
  `AlertDialog.Cancel` vs. roher Button.
- **Löschen in drei Farbquellen**: `text-destructive` (Token) ·
  `text-red-400` (Palette) · `bg-red-600` (fest) — teils im selben Bereich.
- **Sechs Eckenradien** (`rounded-md` 59, bare `rounded` 24, `xl` 22, `full` 21,
  `lg` 15, `2xl` 4) und **sechs Icon-Innenabstände** (`p-1.5` 21, `p-1` 20,
  `p-2` 6, `p-0.5` 5, `p-2.5` 4, `p-3` 3).
- **Kein einziger roher Button setzt eine feste Höhe.** Die Höhe entsteht überall
  implizit aus `py-*` + `text-*` — deshalb stehen nebeneinanderliegende Buttons
  oft minimal unterschiedlich hoch. Das ist der Effekt, den man sieht, ohne ihn
  benennen zu können.
- `AdminInstancesActive.svelte:201` und `AdminComplaintsList.svelte:365` tragen
  dieselbe Klassenliste, nur anders sortiert — Copy-Paste über zwei Generationen.

### 5. Formulare

- **51 Dateien mit rohem `<input>`** (122 Treffer) gegen 33 mit der Komponente.
  Mindestens **5 verschiedene Klassenketten** allein für Text-Eingaben, die sich
  in Hintergrund (`bg-bg-input`/`bg-bg-hover`/`bg-bg-chat`/`bg-transparent`),
  Radius und Innenabstand unterscheiden.
- **32 Dateien mit rohem `<label>`** (66 Treffer) gegen 33 mit der Komponente;
  sieben Dateien mischen beides in sich.
- **Keine visuelle Pflichtfeld-Markierung** irgendwo — nur HTML-`required`.

### 6. Typografie

- **Abschnittsüberschriften laufen zwischen Bereichen auseinander**: Settings
  nutzt überwiegend `text-lg` (14 Dateien), Admin überwiegend `text-base`
  (20 Dateien), beide mit Ausreißern. Zwei Ansichten desselben Features:
  `admin/AuditLogViewer.svelte:83` (`text-lg`) gegen
  `admin/AdminAuditLog.svelte:80` (`text-base`).
- **88 Pixel-Overrides an der Skala vorbei**: `text-[10px]` (53), `text-[11px]`
  (25), `text-[15px]` (8), `text-[0.65rem]` (4), `text-[9px]` (2) — fünf
  Ad-hoc-Stufen zwischen und unter `text-xs`/`text-sm`.
- **Hilfetexte fast hälftig geteilt**: `text-sm` (76) gegen `text-xs` (57), ohne
  erkennbare Regel.

### 7. Radien und Abstände auf Flächen

Für **dieselbe Flächenart** (Panel mit `border-border`) werden vier Stufen
parallel benutzt: `rounded-xl` (79), `rounded-2xl` (56), `rounded-lg` (46),
`rounded-md` (30). Dazu 56 bare `rounded` als meist unbeabsichtigte fünfte Stufe.
Der Token `--radius` (app.css:377) steuert nur die Vendor-Komponenten; App-Code
setzt Radien unabhängig davon.

Panel-Innenabstände über vier Stufen ohne Muster (`p-3` 65, `p-4` 53, `p-5` 23,
`p-8` 16). Bei `space-y` ist die **halbschrittige** `space-y-1.5` (44) die
häufigste Stufe — ein Zeichen für Feintuning von Hand statt Skala.

### 8. Icons — hier ist alles in Ordnung

Genau **eine** Bibliothek (`@lucide/svelte`, Deep-Import pro Icon), keine zweite
Sammlung, keine wilden Inline-SVGs (die vier in `brand-icons/` sind Marken-Logos,
die Lucide nicht führt — sauber gekapselt). Größensyntax fast durchgängig
`size-*` mit nur **9 Ausreißern** in alter `h-4 w-4`-Schreibweise gegen ~412.

Hier besteht kein Handlungsbedarf außer den neun Ausreißern.

---

## Vorgeschlagene Reihenfolge

Nach Verhältnis von sichtbarer Wirkung zu Aufwand, jede Etappe einzeln
abnehmbar:

| # | Etappe | Aufwand | Sichtbarkeit |
|---|---|---|---|
| 1 | `window.confirm` → `alert-dialog` (8 Stellen), „armed"-Buttons vereinheitlichen | klein | hoch |
| 2 | Tokens für Erfolg/Warnung **ergänzen**, dann Palettenklassen migrieren | mittel | hoch |
| 3 | Button-Komponente an die App anpassen (`rounded-md`-Basis, solide destructive-Variante, flaches Primär), **danach** rohe Buttons in Etappen migrieren | groß | hoch |
| 4 | `EmptyState`, `LoadingState`, `FieldError` als gemeinsame Komponenten anlegen und migrieren | mittel | mittel |
| 5 | Eingaben/Labels auf die Komponenten ziehen | mittel | mittel |
| 6 | Typografie-Regel festlegen (h2/h3/Hilfetext) und Pixel-Overrides einsammeln | mittel | niedrig |
| 7 | Radien-/Abstandsregel für Flächen festlegen | mittel | niedrig |
| 8 | Neun Icon-Ausreißer auf `size-*` | winzig | keine |

Etappen 1 und 2 sind eindeutige Fehler — dort gibt es nichts zu entscheiden.
Ab Etappe 3 sind es Festlegungen, die vorher abgestimmt sein wollen.

## Warum das in Etappen gehört

Bei einem reinen Optik-Umbau gibt es **kein Testnetz**: `pnpm check` findet
kaputtes TypeScript, kein verrutschtes Layout, und Playwright deckt nur einen
Bruchteil ab. Die Kontrolle ist das Auge — und das funktioniert bei einer
überschaubaren Etappe, nicht bei 300 geänderten Dateien in einem Commit.
