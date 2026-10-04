# Handoff: Pulse — Mobile & Tablet „chat-first" Redesign

> **Aktuelle** Mobile-Design-Referenz (eingespielt 2026-08-07). Löst das ältere `../pulse-responsive.html` (2026-05-12) ab.

## Overview
Neugestaltung der **mobilen und Tablet-Oberfläche** von Pulse mit einem klaren Ziel:
Pulse soll sich zuerst wie eine **Chat-App** anfühlen, nicht wie Discords
„Rail-in-Rail-in-Rail". Die permanente Guild-Rail entfällt auf Mobil; Navigation
läuft über **vier Tabs** (Bottom-Bar auf dem Phone, schlanke Icon-Leiste links auf
dem Tablet):

- **Chats** — nur private Nachrichten (DMs), Messenger-Prinzip
- **Räume** — Communities (Server) → Kanäle → Kanal-Chat
- **Freunde** — cloud-globale Freundesliste, Anfragen, Hinzufügen
- **Du** — Profil, Status, Einstellungen

Voice hat bewusst **keinen** Tab: Einstieg über einen Sprachkanal, Dauerpräsenz
über das bestehende `VoiceControlBar`-Dock.

## About the Design Files
Die Datei in diesem Bundle (`pulse-mobile-chatfirst.dc.html`) ist eine **Design-Referenz in
HTML/CSS** — ein statischer Prototyp, der Aussehen und Verhalten zeigt, **kein**
produktiver Code zum 1:1-Kopieren. Aufgabe ist, diese Entwürfe in der bestehenden
Pulse-Umgebung (**SvelteKit + Svelte 5 Runes + Tailwind v4 + shadcn-svelte**)
mit den etablierten Mustern nachzubauen. Alle Farben, Radien, Schrift und Abstände
stammen aus `web/src/app.css` — die Recreation nutzt weiterhin die vorhandenen
Tokens/Komponenten, nicht die Inline-Styles des Prototyps.

Der Prototyp ist als **Design-Canvas** organisiert: pro „Turn" ein Abschnitt,
neueste oben. Jede Option hat eine ID (`3a`, `20b`, …), auf die sich der Text
bezieht.

## Fidelity
**High-fidelity.** Finale Farben, Typografie (Plus Jakarta Sans), Abstände,
Radien und Interaktions-Zustände — abgeleitet aus dem echten `app.css` und den
bestehenden Komponenten. Pixelgenau nachbauen mit den vorhandenen Tailwind-Tokens
(`bg-bg-*`, `text-text-*`, `rounded-*`, `--radius-*`), nicht mit den Prototyp-Klassen.

---

## Navigations-Architektur (der Kern der Änderung)

**Heute** (`web/src/routes/app/guilds/[guildId]/channels/[channelId]/+page.svelte`):
`GuildRail` (immer sichtbar, auch mobil, `w-20`) + `ChannelList` (Drawer via
`navDrawer`) + `ChatView`. Auf Mobil frisst die Rail dauerhaft ~80px.

**Neu:**
- **Phone:** Bottom-Tab-Bar (neue Komponente `MobileTabBar`) mit Chats/Räume/
  Freunde/Du. Jeder Tab ist ein List-Screen; Detail (Chat/Kanal) wird als eigener
  Screen aufgeschoben (Zurück-Chevron **und** System-Back-Geste), Bottom-Bar dort
  ausgeblendet.
- **Tablet:** dieselben vier als **vertikale Icon-Leiste links** (neue Komponente
  `TabletNavRail`, ~78px) + Master-Detail (Liste + Detail nebeneinander).
- Die alte `GuildRail` wird auf Mobil/Tablet **nicht** mehr dauerhaft gezeigt;
  ihre Community-Icons wandern in den Räume-Tab. Auf Desktop (`lg:`) kann das
  bestehende 3-Spalten-Layout bleiben.
- `navDrawer`-Store wird überflüssig für Mobil (kein Edge-Drawer mehr → keine
  Kollision mit der Edge-Back-Geste).

Prototyp-Referenz: `3a` (Bottom-Bar), `20a`/`20b`/`21a`/`21b` (Tablet Master-Detail).

---

## Screens / Views

### 1. Chats (nur DMs) — `#6a`, `#7a`, `#20a`
- **Zweck:** private 1:1-Nachrichten. **Keine** `#`Kanäle hier.
- **Quelle:** `DMChannelList.svelte` / Route `/app/@me`.
- **Liste:** Zeilen = Personen (Avatar 46px rund + Präsenz-Punkt, Name,
  letzte Nachricht, Zeit rechts, Ungelesen-Zähler-Pille). Compose-FAB unten
  rechts (52px, Accent-Verlauf) → neues Gespräch.
- **PM geöffnet:** Header = Zurück-Chevron + Avatar 30px + Name + „online"
  (grün) + •••. Composer-Placeholder `@name`.
- **⚠ Neue Design-Entscheidung — Sprechblasen:** PMs sind **rechts/links**
  ausgerichtet (WhatsApp-Stil), NICHT der linksbündige `MessageItem`-Stil.
  Eigene Nachrichten rechts (`--grad` = `linear-gradient(135deg,#2563eb,#3b82f6)`,
  weiße Schrift), Gegenüber links (`bg-bg-input`/`rgba(255,255,255,.07)`).
  Aufeinanderfolgende Nachrichten gruppiert, Uhrzeit am Gruppenende, keine
  In-Thread-Avatare. **Nur für DMs** — Community-Kanäle behalten `MessageItem`
  (dort zählen Autor-Name/-Farbe). → Neue Komponente `DMBubble` / DM-Zweig in
  `ChatView` wenn `headerKind === 'dm'`.
  (Verworfen: `8a`/`8b` stärkere Gruppierung — User bleibt bei `7a`.)

### 2. Räume (Communities) — `#9a`, `#9b`, `#9c`, `#21a`, `#21b`
- **Phone-Drilldown:** Raum-Grid (`9a`) → Kanäle des Raums (`9b`, = `ChannelList`
  full-screen) → Kanal-Chat (`9c`, = `ChatView`, linksbündig). Listen-Ebenen
  behalten die Tab-Bar, der Chat blendet sie aus.
- **Kanal-Wechsler:** im Kanal-Chat ist der Titel („PH  #allgemein ⌄") antippbar
  → **Bottom-Sheet** mit allen Kanälen des Raums (`5c`). Ersetzt den permanenten
  Drawer. → Neue Komponente `ChannelSwitcherSheet` (Inhalt = `ChannelList`).
- **Tablet:** Master-Detail — Community-Liste (`21a`) → mittlere Spalte wird zur
  Kanalliste (‹ zurück) + Chat rechts (`21b`).
- **Raum-Übersicht (`9b` Kopf):** Raum-Name + Einladen (`UserPlus`) + Verwalten
  (`Cog`), Text-/Sprachkanäle mit Ungelesen-Punkt/-Zähler und Voice-Präsenz —
  1:1 aus `ChannelList.svelte`.

### 3. Freunde — `#10a`, `#10b`, `#10c`
- **Quelle:** `/app/friends`, `friends.svelte`, `friendRequests.svelte`,
  `InviteByUsername.svelte`.
- **Liste (`10a`):** nach Präsenz sortiert (online → abwesend → offline), Status
  als Untertext, Schnell-Button „Nachricht" (öffnet DM im Chats-Tab). Segmented
  „Online / Alle / Ausstehend".
- **Ausstehend (`10b`):** eingehende Anfragen mit Annehmen/Ablehnen (treibt das
  Bar-Badge), gesendete darunter.
- **Hinzufügen (`10c`):** per Username (`InviteByUsername`) + Vorschläge aus
  gemeinsamen Räumen.

### 4. Du (Profil/Einstellungen) — `#14a`, `#14b`, `#14c`, `#15a`, `#15b`, `#16a`, `#16b`
- **Übersicht (`14a`/`15a`):** Profilblock (Avatar 56px, Name, @Username,
  Status-Chip), gruppierte Einstellungen mit aktuellem Wert rechts, „Abmelden"
  in Rot.
- **⚠ Mobil ausblenden (`15a`):** Desktop-/Electron-only Sektionen gehören auf
  Mobil weg — **Bildschirm teilen** (GSR-Sidecar), **Tastenkürzel**, **Im Tray
  behalten**, **räuml.-Klang-Positionierer** (schon per `viewport` gegatet),
  **Kompatibilität/Self-Host-Desktop**. Empfehlung: `settings-registry`
  (`web/src/lib/settings-registry/`) pro Sektion ein `platform`-Flag
  (`'mobile' | 'desktop' | 'all'`) geben und clientseitig filtern.
  „Benachrichtigungen" auf Mobil nach oben.
- **Status-Sheet (`14c`):** Online / Abwesend / Bitte nicht stören / Unsichtbar.
- **Detail: Erscheinungsbild (`14b`):** Theme-Karten Hell/Dunkel/System (=
  `SettingsAppearance.svelte`) + Sprache.
- **Detail: Audio/Video mobil (`15b`):** nur Mikrofon-Pegel, Rausch-/Echo-/
  Auto-Gain, Kamera. Kein Screenshare/HQ-Encoder.
- **Benachrichtigungen (`16a`/`16b`):** aus `SettingsNotifications.svelte` —
  Push-Toggle + Aktive-Geräte, „Benachrichtigen bei" (Erwähnungen/DMs/
  Freundschaftsanfragen), OS-Berechtigungs-Prompt.

### 5. Voice / HQ-Stream — `#17a`, `#17c`, `#18a`, `#22a`, `#23a`, `#23b`, `#24a`, `#24b`, `#25a`, `#25b`
- **Quelle:** `VoiceChannelView.svelte`, `VoiceControlBar.svelte`,
  `MobileVoiceStack.svelte`, `StreamGrid`, `CameraTile`.
- **Controls (`18a`, entschieden):** runde **56px**-Buttons, **einzeilig**.
  Reihe = Mic · Taub · Kamera · Auflegen; **Lautsprecher** als Chip in der
  Statuszeile (Android-`audioRoute`). Auf Tablet passt Lautsprecher zurück in
  die Reihe (`22a`/`22b`). Front/Rück-Wechsel sitzt auf der **eigenen** Kachel,
  nicht in der Reihe (`23a`).
- **Teilnehmer (`17a`):** Kacheln mit Sprech-Ring (grün), stumm = rotes Mic.
- **Kamera an (`23a`/`23b`):** Kacheln werden Video-Feeds (`CameraTile`),
  Kamera-Button aktiv (blau), cam-aus bleibt Avatar-Kachel.
- **Gepinnter Feed (`24a`/`24b`):** ein Feed groß + Thumbnail-Streifen,
  „Angepinnt"-Badge + Vollbild-Button.
- **Vollbild (`25a`/`25b`):** Querformat, randlos, Controls als Glas-Pille,
  LIVE-Badge + Stats beim HQ-Stream.
- **`MobileVoiceStack` (`17c`):** unverändert — Voice-Karte peekt oben, Chat
  davor, nach unten wischen = zurück.
- Screenshare & Watch-Party bleiben **mobil ausgeblendet** (bereits so im Code:
  `!viewport.isMobile`).

### 6. Auth — `#19a`, `#19b`, `#19c`, `#20d`
- **Quelle:** `routes/login`, `routes/register`, `AuthBrandPanel.svelte`.
- Mobil: nur die zentrierte Karte (Brand-Panel ist bereits `hidden md:flex`).
- Login: E-Mail/Username + Passwort + „Passwort vergessen" + Passkey (nur
  Browser, `webauthnSupported() && !isElectron()`) + Registrieren-Link +
  `AppDownloadLinks`. 2FA als eigener Schritt (`LoginMfaForm`, `19c`).
- Register: Username/E-Mail/Anzeigename/Passwort (min. 8); Invite-Feld nur bei
  geschlossenen Instanzen.
- Tablet/Desktop: Brand-Panel-Split (`20d`).

### 7. Entdecken — `#26a`, `#26b`
- Community-Verzeichnis: Suche, „per Link/Adresse beitreten" (`c/handle` /
  Invite → `joinByHost`/`joinByInvite`), Kategorie-Chips, öffentliche Communities
  als Karten (Banner, Icon, Online/Mitglieder, Beitreten). Erreichbar aus dem
  Räume-Tab Empty-State.

### Profil / Moderation — `#11a`, `#11b`, `#12a`, `#12b`, `#13a`, `#13b`
- **Profil-Popover (`11a`/`11b`):** als Bottom-Sheet (`UserProfilePopover`);
  aus einem Raum zusätzlich Server-Nick + Rollen-Pills (Farben aus `nameColor`).
- **Rollen verwalten (`12a`):** Checkliste (`MemberQuickRoleMenu`) — ohne
  @everyone, nach Position, Anti-Eskalation sperrt Rollen mit höheren Rechten.
- **•••-Menü (`12b`):** Nachricht/Erwähnen, Rollen verwalten, Rauswerfen/Bannen/
  Melden (nur mit Berechtigung).
- **Bannen (`13a`):** zentrierter `AlertDialog`, destruktiv, optionaler Grund.
- **Melden (`13b`):** `ReportMessageDialog` — Grund-Auswahl + Details; DMs → Betreiberteam.

---

## Interactions & Behavior
- **Navigation:** Tab-Tap wechselt den Stack; Listen → Detail schiebt auf
  (Transition ~0.26s cubic-bezier(.3,.8,.3,1), wie im alten Drawer). Zurück =
  Chevron + Edge-Back-Geste.
- **Bottom-Sheets** (Kanal-Wechsler, Profil, Rollen, Status): von unten,
  `rounded-t-[22px]`, Scrim `rgba(0,0,0,.5)`, Grabber-Handle oben. Vgl.
  bestehendes `MessageActionSheet.svelte`.
- **Long-Press** auf Nachricht → `MessageActionSheet` (bestehend).
- **Modals** (Bannen/Melden): zentriert, Scrim `rgba(0,0,0,.58)`.
- **Voice-Vollbild:** Controls auto-hide bei Inaktivität.
- **Tap auf Kachel** = pinnen; Doppel-Tap/Vollbild-Button = Vollbild.

## Platform (iOS & Android) — `#4a`, `#4b`
- **Trefferflächen ≥ 48dp** durchgehend (deckt iOS 44pt + Android 48dp).
- **Safe-Areas:** Bottom-Bar + Voice-Dock über `var(--safe-bottom)`; oben
  `var(--safe-top)`. Beide Variablen existieren schon (`app.css`: `env()` +
  Android SystemBars-Plugin).
- Voice-Dock-Buttons auf 44px (nicht 38).
- Kein Edge-Drawer → kein Konflikt mit System-Back-Geste.

## State Management (bestehende Stores wiederverwenden)
- `directMessages.svelte`, `friends.svelte`, `friendRequests.svelte`,
  `guilds.svelte`, `serverGuilds.svelte`, `messages.svelte`, `readState.svelte`,
  `presence.svelte`, `voice/livekit.svelte`, `voicePresence.svelte`,
  `settings.svelte`, `viewport.svelte`.
- **Neu:** aktiver Tab-Zustand (Chats/Räume/Freunde/Du) + pro Tab ein
  Navigations-Stack (welcher Chat/Raum/Kanal offen). `navDrawer` entfällt mobil.

## Design Tokens (alle aus `web/src/app.css`, Dark-Variante im Prototyp)
- **Flächen:** `--panel-solid` `rgba(20,20,24,.92)`; `--panel-border`
  `rgba(255,255,255,.08)`; `--bg-input` `rgba(255,255,255,.035)`; `--input`
  `rgba(255,255,255,.1)`; `--hover` `rgba(255,255,255,.05)`.
- **Text:** `--text` `#f0f1f3`; `--text-dim` `#9ca3af`; `--text-faint` `#6b7280`.
- **Akzent:** `--primary`/`--brand` `#3b82f6`; `--accent-soft` `rgba(37,99,235,.2)`;
  Verlauf `linear-gradient(135deg,#2563eb,#3b82f6)` (`.accent-gradient`).
- **Status:** `--success` `#10b981`; Zähler/LIVE `#dc2626`; Warnung `#f59e0b`.
- **Radien:** Bedienelemente `--radius-md` 8px; Flächen `--radius-xl` 10px;
  Dialoge `--radius-2xl` 12px; Sheets 22px; Pillen 999px.
- **Schrift:** `Plus Jakarta Sans Variable`; Kleinstschrift `--text-2xs` 11px.
- **Kanal-/Namensfarben:** `nameColor.ts` (`channelNameStyle`, `nameStyle`).

## Assets
- Logo: `/pulse-mark.svg` (im Prototyp als konzentrische Kreise nachgezeichnet —
  echte Datei liegt in `web/static/`, für Pixelgenauigkeit verwenden).
- Icons: der Prototyp nutzt einfache Line-Glyphen; der Client nutzt
  **`@lucide/svelte`** — dort die passenden Lucide-Icons verwenden
  (`hash`, `users`, `volume-2`, `mic`/`mic-off`, `headphones`, `video`,
  `phone-off`, `paperclip`, `smile-plus`, `send-horizontal`, `search`,
  `message-circle`, `user`, `bell`, `settings`, `fingerprint`, `shield`, `flag`,
  `pin`, `chevron-left/right/down`, …).

## Files
- `pulse-mobile-chatfirst.dc.html` — der vollständige Prototyp (alle Turns/Screens).
  Öffnet direkt im Browser; Turns von oben (neueste) nach unten lesen.

## Offene Punkte / Entscheidungen
- **Freunde vs. Aktivität-Tab:** aktuell „Freunde" (mit Anfragen-Badge).
  Alternative war ein „Aktivität"-Tab (`3b`) — noch nicht final entschieden.
- **Lese-Häkchen** in DMs (`7b`) nur umsetzen, wenn Zustellstatus für DMs
  existiert — sonst weglassen.
- Community-Liste auf Tablet: aktuell Drilldown (Liste ↔ Kanäle); optional
  dauerhafte schmale Icon-Spalte.
