# Mobile Voice/Text Card-Stack — Design

**Datum:** 2026-06-03
**Status:** Approved (Brainstorming) → Implementierung
**Scope:** Frontend (`web/`), mobile Ansicht. Kein Backend, keine neuen Dependencies.

## Problem

Auf Mobil ist das Verhältnis von Voice- und Text-Kanal unintuitiv. Man kann mit
einem Voice-Kanal verbunden sein, sieht aber beim Öffnen eines Text-Kanals nur
noch den Chat — der Voice-Kanal verschwindet komplett aus dem Bild
(`+page.svelte`: `{#if isVoiceChannel}VoiceChannelView{:else}ChatView`). Es fehlt
das visuelle Signal „du bist noch im Voice-Kanal, der Text liegt nur darüber".
Zusätzlich ist der einzige Weg zurück zur Kanal-Liste das (unbeschriftete)
aktive Server-Icon — es gibt keinen sichtbaren Hinweis.

## Lösung (Karten-Stapel)

Solange man **mit einem Voice-Kanal verbunden** ist und einen **Text-Kanal**
derselben Community ansieht, wird der Inhalt als Karten-Stapel dargestellt:

- **Untere Karte:** der verbundene Voice-Kanal (`VoiceChannelView`), als
  abgerundete Karte mit eigenem Schatten, oben aus dem Stapel herausschauend.
- **Obere Karte:** der Text-Kanal (`ChatView`), versetzt darüber, mit runden
  oberen Ecken, Schatten nach unten und einer Griff-Leiste (Sheet-Optik).

Das vermittelt Tiefe: „eine Karte über dem Voice-Kanal, mit Schattierung
darunter".

### Auslöser (genau)

Stapel-Ansicht **nur** wenn **alle** zutreffen:
1. `viewport.isMobile`
2. `voice.connected` (mit einem Voice-Kanal verbunden)
3. der verbundene Voice-Kanal (`voice.channelId`) liegt in der **aktuell
   angesehenen Community** (`guildId`)
4. der angesehene Kanal ist ein **Text-Kanal** (`activeChannel.type === 0`)

Trifft eines nicht zu → **exakt das heutige Verhalten** (kein Eingriff):
- Desktop: unverändert (Drei-Spalten).
- Nicht im Voice: Text füllt, Voice-Kanal zeigt Join-Screen voll.
- Im Voice, aber andere Community gebrowst: kein Stapel; der Call bleibt über die
  bestehende `VoiceControlBar` unten erreichbar (Cross-Community-Stapel ist
  bewusst v2).
- Angesehener Kanal == verbundener Voice-Kanal: voller Voice (kein Stapel).

### Zurück zum vollen Voice-Kanal

Zwei gleichwertige Wege, beide enden in `goto(<Voice-Kanal-URL>)` (dann ist
Bedingung 4 falsch → voller Voice):
- **Tippen** auf den oben sichtbaren Voice-Peek (Header/Teilnehmer der unteren
  Karte).
- **Runterwischen** der oberen Karte an der Griff-Leiste: Pointer-Events mit
  Drag-Follow (`translateY` folgt dem Finger), Schwelle ~80 px → navigieren;
  darunter → Zurück-Feder. Reine Svelte-Transitions + Pointer-Handler, **keine
  neue Dependency**.

### Eingabefeld-Anforderung (hart)

Das Text-Eingabefeld (`MessageInput`, unten in `ChatView`) **muss oberhalb des
`VoiceControlBar`-Docks** liegen, sonst ist keine Eingabe möglich. Wird dadurch
erfüllt, dass die obere Karte im **normalen Flex-Fluss** des Inhalts-Containers
lebt, der **über** der Control-Bar-Zeile endet (die Control-Bar ist in
`+layout.svelte` eine eigene `shrink-0`-Zeile unter der Panel-Zeile). Die Karte
darf **kein `h-full`** erzwingen (sonst wird `MessageInput` aus dem sichtbaren
Bereich geschoben — im Prototyp verifiziert).

## Architektur / Komponenten

- **Neue Komponente `web/src/lib/components/MobileVoiceStack.svelte`** kapselt das
  Layering + die Zurück-Geste. Hält `+page.svelte` unter der Größen-Policy
  (Components ≤ 250 Z.). Props:
  - `voiceChannel: Channel` — der verbundene Voice-Kanal (Quelle:
    `guilds.channelsByGuild[guildId].find(c => c.id === voice.channelId)`).
  - Snippet/Children für die obere (Chat-)Karte ODER direkter Import von
    `ChatView` mit durchgereichten Props (Entscheidung im Plan).
  - `onReturnToVoice: () => void` — Callback (= `goto(voiceChannel-URL)`).
- **`+page.svelte`** entscheidet via abgeleitetem `showVoiceStack` (die 4
  Bedingungen oben), ob `MobileVoiceStack` statt des heutigen
  `ChatView`-Zweigs gerendert wird. Der bestehende Voice-/Chat-/Error-Zweig
  bleibt für alle anderen Fälle unverändert.
- **Layout innerhalb des Stacks:** ein relativer Container (füllt die
  Inhalts-Zeile, endet über dem Dock). Untere Karte absolut/abgerundet,
  oben rausschauend. Obere Karte absolut `inset-x` + `bottom-0` + `top-[offset]`,
  interne Flex-Spalte (Header → `flex-1` Nachrichten → `MessageInput`) → Eingabe
  pinnt an Karten-Unterkante, die über dem Dock liegt.

## Verhalten unverändert (Regression-Schutz)

- Endpoint-/Routen-Verhalten, `data-testid`s und Response-Models bleiben
  identisch. Kanal-Wechsel weiterhin über die Kanal-Liste (Drawer via
  Server-Icon). Anderer Text-Kanal → Inhalt der oberen Karte wechselt.
- `VoiceControlBar` bleibt wie heute die persistente Steuerleiste unten.

## Tests

- `cd web && pnpm check && pnpm build` → 0 Errors / 0 Warnings.
- Playwright-E2E für die Wisch-Geste + echten LiveKit-Connect ist unrealistisch
  (kein realer Voice-Pfad im E2E). Soweit machbar: ein Test, der im gestackten
  Zustand die DOM-Präsenz beider Layer (`voice-channel-view` + `ChatView`) und
  des neuen Stack-Containers prüft und dass ein Tipp auf den Voice-Peek zur
  Voice-Kanal-URL navigiert (Voice-State ggf. gemockt). Der Gesten-Pfad +
  Optik = **manueller Geräte-Test** (dokumentiert).
- Kein Vitest/Unit (existiert im Projekt nicht).

## Bewusst ausgeklammert (YAGNI / v2)

- Cross-Community-Stapel.
- „Hamburger"-Affordance zum Öffnen der Kanal-Liste aus der Inhalts-Ansicht
  (separates, unabhängiges UX-Thema).
- Stapel für reine Text→Text-Navigation (nicht gewünscht).
