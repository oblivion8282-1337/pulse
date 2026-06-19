# Watch-Party läuft im Hintergrund weiter (mit Ton)

**Datum:** 2026-06-19
**Branch:** `feat/watch-party-background` (von `main`)

## Problem

Auf `main` hängt die Watch-Party-Kachel am *Ansehen* des Voice-Kanals: sie wird in
`StreamGrid` (innerhalb `VoiceChannelView`) gerendert. Navigiert man auf einen
Text-Kanal, unmountet die Kachel → der Player (YouTube/Twitch-iframe bzw. `<video>`)
wird zerstört → **Bild und Ton stoppen lokal**. Die Party endet zwar *nicht*
server-seitig (ein `inVoiceChannel`-Guard unterdrückt `watch_leave`, solange man im
Voice bleibt), aber der Nutzer sieht/hört nichts mehr.

**Ziel:** Solange man im Voice-Kanal bleibt, soll die Party beim Weg-Navigieren
**nahtlos weiterlaufen** (Ton + Bild), ohne Neuladen.

## Lösung (gewählt: „Groß im Kanal, Ecke beim Weggehen, nahtlos")

Der Player wird **genau einmal dauerhaft** gemountet, außerhalb der seiten-spezifischen
Ansicht, und beim Navigieren **nie** zerstört. Er wechselt nur seine Position:

- **Voice-Kanal wird angesehen** → der feste Player liegt über einem leeren
  Platzhalter (Anker) im Voice-Grid → sieht groß aus wie heute.
- **Anderswo** (Text-Kanal / andere Community), aber noch im Voice → der Player
  schrumpft zu einem **festen kleinen Eck-Fenster unten rechts**, Ton läuft weiter.
  Klick → zurück zum Voice-Kanal.

Weil derselbe DOM-Knoten durchgehend gemountet bleibt, gibt es **kein Neuladen** →
Ton/Bild laufen nahtlos.

## Architektur

Drei kleine Einheiten, klar getrennt:

1. **`watchBackground.svelte.ts`** (Store): hält pro offener Party (a) die Anker-
   Position (`DOMRect | null`) und (b) registriert/misst den Anker. Liefert die
   Liste der im verbundenen Voice-Kanal laufenden Partys. Single source of truth,
   keine Reaktiv-Schleifen.
2. **`WatchBackgroundHost.svelte`** (einmal in `app/+layout.svelte` gemountet,
   außerhalb des Routen-Inhalts): rendert pro Party **einen** `WatchPartyTile` in
   einem `position: fixed`-Rahmen. Position = Anker-Rect (docked) **oder** feste
   Ecke (kein Anker sichtbar → Mini). Ein einzelner rAF-Ticker (nur aktiv, solange
   ≥1 Anker registriert ist) hält die Docked-Position auf dem Anker (folgt Resize/
   Sidebar/Teilnehmer-Änderungen); aktualisiert State nur bei echter Änderung.
3. **Anker in `StreamGrid`**: statt der Kachel rendert das Grid einen leeren,
   gemessenen Platzhalter (`use:action` registriert ihn beim Store). So bleibt das
   Grid-Layout (Größe, Reihenfolge mit anderen Kacheln) exakt wie heute, aber der
   echte Player lebt im persistenten Host.

`WatchPartyTile` wird **unverändert wiederverwendet** (Player-Auswahl, Sync,
Host-Steuerung, Chat). Lebensdauer ist an die **Voice-Verbindung** gebunden
(`voiceState.connected` + `channelId`), nicht an die Route.

## Verhalten / Datenfluss

- Host startet Party → `watch_started`-Ack öffnet die Kachel (wie heute, über den
  Store statt `openedTiles`).
- Im Voice-Kanal: `StreamGrid` rendert einen Anker → Host legt den festen Player
  darüber (docked).
- Navigiert weg: Anker verschwindet (Grid unmountet) → kein Anker-Rect → Host zeigt
  den Player als Mini-Eck-Fenster. **Der Player-Knoten bleibt gemountet** → kein
  Reload, Ton läuft weiter.
- Zurück zum Voice-Kanal: Anker re-registriert → docked.
- Voice verlassen (echter Disconnect) → `voiceState.connected=false` → Host räumt
  ab; Host-Party endet wie heute über `stopWatchParty`/`watch_leave`-Pfad.

## Bewusst weggelassen (YAGNI — das war der Bug-Ballast des alten PiP-Branches)

- Kein verschiebbares (drag) Fenster — feste Ecke.
- Kein Fokus-Modus / Filmstrip.
- Kein Abdocken in ein OS-Popup.
- Keine Detach/Picker/Handoff-im-Mini-Sonderfälle über das hinaus, was `WatchPartyTile`
  ohnehin schon kann.

## Mini-Fenster-Chrome

Das Eck-Fenster bekommt eine minimale Leiste: Klick auf die Fläche → zurück zum
Voice-Kanal; ein **X** (schließen = aus der Hintergrund-Anzeige nehmen: Viewer
`watch_leave`, Host nur ausblenden). Die volle `WatchPartyTile`-Steuerleiste bleibt
darunter erhalten und muss klickbar sein (Lehre aus dem alten Branch: Drag-Overlay
darf die Buttons nicht verdecken — hier gibt es gar kein Drag-Overlay).

## Test

- **Headless (Playwright, DOM-Wahrheit):** Party starten (echter App-Socket) →
  Anker da, Player docked → auf Text-Kanal navigieren → Player bleibt im DOM
  (gleicher Knoten, `data-pip=mini`), iframe/`<video>` NICHT neu erzeugt → zurück →
  docked. Plus: Buttons im Mini erreichbar (`elementFromPoint`).
- **Echtes Electron (User + ich so weit möglich):** Party starten → Text-Kanal →
  Ton läuft hörbar weiter → Eck-Fenster sichtbar → Klick bringt zurück. Erst dann
  gilt es als fertig.

## Risiken

- **Docked-Positions-Abgleich** (rAF folgt dem Anker): muss Resize/Sidebar-Toggle
  wirklich folgen (das war Symptom #4 im alten Branch). → im echten Electron testen.
- **Modul-Singletons über HMR:** Store als ein Singleton; bei Verdacht auf
  Doppel-Instanzen DOM-Wahrheit messen, nicht Store-Reads (Lehre aus heute).
