# Mobile- und Tablet-Redesign „chat-first" — Design

**Datum:** 2026-08-22
**Zweig:** `feat/mobile-chatfirst` (von `main`)
**Quelle:** Design-Canvas `Pulse Mobile.dc.html` im Claude-Design-Projekt
`498e4ab1-e7b9-49ff-9ba6-3f0483a9152b`, plus das dortige
`design_handoff_mobile_chatfirst/README.md`.

---

## 1. Ziel

Pulse soll sich auf Handy und Tablet zuerst wie eine **Chat-App** anfühlen und
nicht wie Discords „Rail-in-Rail-in-Rail". Die dauerhaft sichtbare `GuildRail`
(80 px) entfällt auf beiden Größen; Navigation läuft über **vier Bereiche** —
Chats, Räume, Freunde, Du.

**Desktop (`≥ lg`) bleibt unverändert.** Kein Bildschirm, kein Store und keine
Route des heutigen Drei-Spalten-Layouts wird in seinem Desktop-Verhalten
angefasst. Jede Regel in diesem Dokument ist auf `< lg` beschränkt, sofern nicht
ausdrücklich anders vermerkt.

Voice bekommt bewusst **keinen** Bereich: Einstieg über einen Sprachkanal,
Dauerpräsenz über das bestehende `VoiceControlBar`-Dock, das `app/+layout.svelte`
auf Mobil bereits über der Bereichs-Leiste rendert.

### Nicht-Ziele

- Kein Umbau des Desktop-Layouts.
- Keine Änderung am Nachrichten-, Voice- oder Streaming-Protokoll.
- Keine neue Abhängigkeit.
- Kein zweiter, mobiler Chat-Bildschirm neben `ChatView`.

---

## 2. Ausgangslage

Auf `main` existiert nichts davon: kein `lib/components/mobile/`, keine
Bereichs-Leiste, `GuildRail` ist auch auf dem Handy dauerhaft sichtbar.

Der Zweig `feat/mobile-chatfirst-redesign` (20.07.2026, 5 Commits, ~1230 Zeilen)
enthält eine frühere Fassung der Bereiche 1–3. Er liegt 857 Commits hinter `main`.
**Entscheidung: nicht übernehmen** — es wird gegen den heutigen Stand neu gebaut.
Der Zweig bleibt als Nachschlagewerk stehen und darf nach dem Merge dieser Arbeit
gelöscht werden.

Vorhanden und wiederverwendbar (alle geprüft):
`ChannelList` (819 Z.), `ChatView` (333), `DMChannelList` (130),
`MessageActionSheet` (148), `MessageItem` (294), `MessageList` (431),
`VoiceControlBar` (297), `VoiceChannelView` (274), `MobileVoiceStack` (89),
`UserProfilePopover` (191), `MemberQuickRoleMenu` (95), `ReportMessageDialog` (218),
`InviteByUsername` (78), `AuthBrandPanel` (165), `StreamGrid` (197), `CameraTile` (64).

`app/+layout.svelte` ist eine reine Hülle mit `{@render children}`; die Routen
tragen den Inhalt. `--safe-top` / `--safe-bottom` werden dort bereits benutzt.

---

## 3. Navigations-Architektur

**Gewählter Weg: die Bereiche sind echte Routen.**

Verworfen wurden (a) ein eigener Navigations-Stack im Store — verdoppelt das
Routing, bricht Deeplinks und verlangt eigenes Abfangen der System-Back-Geste,
genau die Stelle, an der der alte Edge-Drawer bereits kollidierte; und (b) eine
getrennte Routen-Gruppe `/m/` — jeder Bildschirm doppelt, läuft mit der Zeit
auseinander.

### 3.1 Routen

| Bereich | Liste | Detail |
|---|---|---|
| Chats | `/app/@me` *(vorhanden)* | `/app/@me/[dmChannelId]` *(vorhanden)* |
| Räume | `/app/rooms` **neu** | `/app/rooms/[guildId]` **neu** → `/app/guilds/[guildId]/channels/[channelId]` *(vorhanden)* |
| Freunde | `/app/friends` *(vorhanden)* | — |
| Du | `/app/me` **neu** | `/app/me/[section]` **neu** |
| Entdecken | `/app/discover` **neu** | — |

`/app/rooms/[guildId]` rendert die Kanalliste einer Community. Ein Kanal-Tipp
führt auf die **bestehende** Kanal-Route — keine Gabelung, ein Chat-Bildschirm
für alle Größen.

Der „Stack je Bereich" ist die URL. Zurück = History. Damit funktionieren die
Android-System-Back-Geste und `navigateToFromNotification()` ohne Zusatzcode.

### 3.2 Neue Bausteine

- `web/src/lib/components/mobile/MobileTabBar.svelte` — Bottom-Bar, vier Ziele.
  Badge an *Freunde* (offene Anfragen aus `friendRequests`) und *Chats*
  (ungelesene DMs aus `readState` × `directMessages`). Nur `< md`.
- `web/src/lib/components/mobile/TabletNavRail.svelte` — dieselben vier als
  78-px-Icon-Spalte. Nur `md`–`lg`.
- `web/src/lib/navigation/tabs.ts` — **importfreies** Modul: leitet aus einem
  Pfad den aktiven Bereich und die Antwort „ist das ein Detail-Screen?" ab.
  Importfrei, damit `pnpm test:unit` (Nodes Läufer) es prüfen kann — die Falle
  aus `CLAUDE.md`: eine geprüfte Datei darf keinen erweiterungslosen
  Laufzeit-Import haben.

### 3.3 Die Layout-Regel

In `app/+layout.svelte`, abgeleitet aus `tabs.ts` + `viewport`:

```
< md   : MobileTabBar sichtbar, außer auf einem Detail-Screen
md–lg  : TabletNavRail links, Inhalt als Liste + Detail nebeneinander
>= lg  : nichts davon — heutiges Drei-Spalten-Layout unverändert
```

`GuildRail` bekommt `hidden lg:flex`. Der `navDrawer`-Store wird auf `< lg`
nicht mehr benutzt; damit ist der Bildschirmrand frei für System-Back.

### 3.4 Aufräumen im Zuge der Arbeit

`ChannelList.svelte` hat **819 Zeilen** — über der harten Grenze von 500
(`PLAN.md` §12.1) — und wird an drei Stellen gebraucht (Vollbild-Liste,
Wechsler-Sheet, Tablet-Spalte). Sie wird aufgeteilt in Kopf, Liste und
Kanalzeile, sodass alle drei Stellen dieselbe Zeile teilen. **Kein
Verhaltenswechsel**: Routen, Response-Formen und `data-testid` bleiben
identisch (`CLAUDE.md`: bricht ein Test nach dem Refactor, ist der Code kaputt,
nicht der Test).

---

## 4. Backend-Erweiterungen

### 4.1 DM-Vorschautext

Heute liefert `routes/dms.py` nur `last_message_id`; der Canvas zeigt in jeder
Chats-Zeile einen Ausschnitt der letzten Nachricht.

Die DM-Listen-Antwort trägt künftig zusätzlich:

- `last_message_preview: str | null` — auf **80 Zeichen** gekürzt, ohne
  Zeilenumbrüche.
- `last_message_author_id: str | null` — für ein vorangestelltes „Du: ".
- `last_message_at: str | null` — ISO-Zeitstempel für die Uhrzeit rechts.

Nachricht ohne Text, aber mit Anhang → die Vorschau ist einer von zwei festen
Markern, `"__image__"` oder `"__file__"`, die das Frontend über den
Sprachkatalog auflöst („Bild", „Datei"). Der **Dateiname geht nicht mit** —
unnötiger Metadaten-Abfluss in eine Liste, die auch andere Geräte des Kontos
sehen. Gelöschte letzte Nachricht → `null`, die Zeile fällt auf den heutigen
Zustand zurück.

Sichtbarkeit ist durch die DM-Mitgliedschaft bereits gedeckt: wer die Liste
lesen darf, darf die Nachricht lesen. Kein neuer Rechte-Pfad.

### 4.2 Verzeichnis öffentlicher Communities

Vorhanden ist nur `GET /c/{handle}` (Vorschau) und `POST /c/{handle}/join` in
`routes/public_community.py`; `Guild` hat bereits `is_public` und `handle`.

**Neu:** `GET /c` — durchsuchbares Verzeichnis.

Zwei Felder auf `Guild` (eine Migration im `chat`-Schema):

- `listed: bool`, **Vorgabe `false`**.
- `category: str | null` aus einer festen Liste im Code:
  `gaming | music | tech | creative | other`.

**`listed` ist bewusst getrennt von `is_public`.** Eine öffentliche Adresse
bedeutet „wer den Link kennt, kommt rein"; ein durchsuchbares Verzeichnis
bedeutet „ich möchte gefunden werden". Das sind verschiedene Zustimmungen.
Bestehende öffentliche Communities werden durch die Migration **nicht**
gelistet — die Spalte kommt mit `false` an, ohne Backfill. Der Schalter sitzt im
bestehenden `GuildPublicAddressEditor.svelte` und verlangt `MANAGE_GUILD`; er
ist nur bedienbar, wenn `is_public` bereits an ist (ohne öffentliche Adresse
gibt es nichts zu listen).

`GET /c` nimmt `q` (Freitext über Name und Beschreibung), `category` und
Blätter-Parameter; es liefert je Eintrag Handle, Name, Icon, Beschreibung,
Kategorie, Mitgliederzahl und Online-Zahl. **Nur Zeilen mit
`is_public AND listed`** — dieselbe Nicht-Existenz-Antwort wie
`_public_guild_or_404` für alles andere, damit die Liste kein Werkzeug wird, um
private Communities zu erraten.

**Der Endpunkt verlangt eine Anmeldung** — `CurrentUser`, genau wie die
bestehende Vorschau `GET /c/{handle}`. Das ist kein zusätzlicher Riegel, sondern
der vorhandene: der chat-gateway hat **keinen** Ratenbegrenzer (`slowapi` läuft
nur im auth-svc, in-process), ein anonymes Verzeichnis wäre also ein
unbegrenzt abfragbarer Endpunkt. Die Seitengröße wird zusätzlich serverseitig
gedeckelt.

---

## 5. Bildschirme

Auszeichnungen wie `#7a` verweisen auf die Optionen im Canvas. Alle Farben,
Radien, Schriftgrößen und Abstände kommen aus `web/src/app.css` und den
vorhandenen Tailwind-Tokens — **nicht** aus den Inline-Styles des Prototyps.

### 5.1 Chats — `#6a`, `#7a`

Zeile: Avatar 46 px rund mit Präsenzpunkt, Name, Vorschauzeile (§4.1), Uhrzeit
rechts, Ungelesen-Pille. Compose-FAB unten rechts (52 px, Akzent-Verlauf).

Geöffnetes Gespräch: Kopf = Zurück-Chevron, Avatar 30 px, Name, Präsenztext,
`•••`. Composer-Platzhalter `@name`.

**Sprechblasen nur in DMs.** Eigene Nachrichten rechts im Akzent-Verlauf, weiße
Schrift; Gegenüber links auf `bg-bg-input`. Aufeinanderfolgende Nachrichten
gruppiert (2 px Abstand, innere Ecken auf der Sprech-Seite 7 px, außen 20 px),
Uhrzeit nur am Gruppenende, keine In-Thread-Avatare. Neue Komponente
`DMBubble.svelte`; `ChatView` verzweigt bei `headerKind === 'dm'`.

**Community-Kanäle behalten `MessageItem`** — dort tragen Autorname und -farbe
die Orientierung, Blasen würden schaden. (Canvas `8a`/`8b`, stärkere
Gruppierung, wurde verworfen; es bleibt bei `7a`.)

**Lese-Häkchen (`7b`) entfallen** — es gibt keinen Zustellstatus für DMs, und
einen zu erfinden ist nicht Teil dieser Arbeit.

### 5.2 Räume — `#3c`, `#9a`, `#9b`, `#9c`, `#5c`

`/app/rooms`: Kachel-Grid je Community (Icon, Name, Online-Zahl,
Ungelesen-Punkt). Bei mehreren Pulse-Servern je Server eine Zwischenüberschrift,
Quelle `serverGuilds`. Leerzustand verweist auf Entdecken.

`/app/rooms/[guildId]`: die aufgeteilte `ChannelList` als Vollbild — Kopf mit
Community-Name, Einladen (`user-plus`) und Verwalten (`cog`), darunter Text- und
Sprachkanäle mit Ungelesen-Punkt und Voice-Präsenz.

Kanal-Chat: der Titel („PH #allgemein ⌄") ist antippbar und öffnet
`ChannelSwitcherSheet.svelte` — ein Bottom-Sheet mit allen Kanälen der
Community. **Ersetzt den permanenten Drawer auf `< lg`.**

Listen-Ebenen behalten die Bereichs-Leiste, der Chat blendet sie aus.

### 5.3 Freunde — `#10a`, `#10b`, `#10c`

Bestehende `/app/friends` wird mobil neu aufgebaut: Segmentierte Umschaltung
Online / Alle / Ausstehend; Sortierung nach Präsenz; je Zeile ein
Nachricht-Knopf, der die DM öffnet und in den Chats-Bereich wechselt. Unter
„Ausstehend" eingehende Anfragen mit Annehmen/Ablehnen (Quelle des Badges an der
Bereichs-Leiste), gesendete darunter. Hinzufügen über das bestehende
`InviteByUsername`.

### 5.4 Du — `#14a`, `#14b`, `#14c`, `#15a`, `#15b`, `#16a`, `#16b`

`/app/me`: Profilblock (Avatar 56 px, Name, `@username`, Status-Chip), darunter
gruppierte Einstellungs-Einträge mit aktuellem Wert rechts, „Abmelden" in Rot.
Status-Sheet mit Online / Abwesend / Bitte nicht stören / Unsichtbar.
`/app/me/[section]` schiebt den jeweiligen Einstellungs-Bildschirm auf und
rendert **die vorhandenen** `Settings*`-Komponenten.

**Korrektur zum Handoff-Dokument.** Dieses empfiehlt, der `settings-registry`
ein `platform`-Flag zu geben. Das ist die falsche Stelle: `settings-registry/`
hält *Zustand*, nicht Oberfläche. Der Filter existiert bereits in
`web/src/lib/components/settingsTabs.ts` (`desktopOnly`, `browserOnly`,
`electronOnly`, `standplatzGate`), und `SettingsDialog.svelte` wertet
`desktopOnly` schon heute gegen `viewport.isMobile` aus — **Bildschirm teilen
und Tastenkürzel sind auf Mobil also längst ausgeblendet.**

Zu tun bleibt: die verbliebenen reinen Computer-Bereiche gleich auszeichnen,
„Benachrichtigungen" auf Mobil nach oben ziehen, und `/app/me` dieselbe
`visibleTabs`-Rechnung benutzen lassen wie der Dialog — **nicht** eine zweite
danebenstellen.

### 5.5 Sprache und Video — `#17a`, `#17c`, `#18a`, `#23a`, `#24a`, `#25a`

Teilnehmerkacheln mit Sprech-Ring (grün) und rotem Mikrofon bei stumm. Runde
**56-px**-Knöpfe, garantiert **einzeilig**: Mikrofon · Taub · Kamera · Auflegen.

**Der Lautsprecher wandert aus der Reihe** in die Statuszeile darüber (Chip,
Android-`audioRoute`). Grund: fünf 56-px-Knöpfe brechen auf schmalen Geräten um
oder müssten unter die Mindest-Trefferfläche schrumpfen. Auf dem Tablet ist der
Platz da, dort sitzt er wieder in der Reihe. Der Front/Rück-Wechsel der Kamera
sitzt auf der **eigenen Kachel**, nicht in der Reihe.

Kamera an → Kachel wird `CameraTile`. Kachel antippen → gepinnt groß, Rest als
Thumbnail-Streifen. Von dort ins Vollbild: Querformat, randlos, Controls als
Glas-Pille, die bei Inaktivität ausblendet.

`MobileVoiceStack` bleibt unverändert. Bildschirm teilen und Watch-Party bleiben
mobil ausgeblendet (heute schon `!viewport.isMobile`).

### 5.6 Entdecken — `#26a`

Suchfeld, Feld „per Link oder Adresse beitreten" (gegen `joinByHost` /
`joinByInvite`), Kategorie-Chips, darunter die Karten aus `GET /c` mit
Beitreten-Knopf. Erreichbar aus dem Räume-Bereich.

### 5.7 Profil und Moderation — `#11a`–`#13b`

`UserProfilePopover` wird auf `< lg` als Bottom-Sheet dargestellt; aus einer
Community zusätzlich Server-Nick und Rollen-Pills (Farben aus `nameColor.ts`).
`MemberQuickRoleMenu` als Checkliste im Sheet (ohne `@everyone`, nach Position;
die bestehende Anti-Eskalations-Sperre bleibt unangetastet). Das `•••`-Menü
zeigt Nachricht/Erwähnen, Rollen verwalten, Rauswerfen/Bannen/Melden —
je nach Berechtigung.

**Bannen und Melden bleiben zentrierte Dialoge**, keine Sheets: eine
destruktive Aktion soll nicht dort liegen, wo der Daumen ohnehin ruht.

---

## 6. Interaktion und Plattform — `#4a`, `#4b`

- **Trefferflächen ≥ 48 dp durchgehend** (deckt iOS 44 pt und Android 48 dp).
  Gilt auch für optisch kleinere Symbole — die unsichtbare Fläche zählt.
  Voice-Dock-Knöpfe steigen von 38 auf 44 px.
- **Safe-Areas:** Bereichs-Leiste und Voice-Dock über `var(--safe-bottom)`, oben
  `var(--safe-top)`. Beide existieren bereits in `app.css`.
- **Kein Edge-Drawer** → kein Konflikt mit der System-Back-Geste.
- **Übergänge:** aufschiebende Bildschirme ~0,26 s
  `cubic-bezier(.3,.8,.3,1)`; Sheets fahren von unten, `rounded-t-[22px]`,
  Scrim `rgba(0,0,0,.5)`, Grabber oben (Muster: bestehendes
  `MessageActionSheet.svelte`). Modals zentriert, Scrim `rgba(0,0,0,.58)`.
- **Long-Press** auf eine Nachricht → bestehendes `MessageActionSheet`.

---

## 7. Zustand

Wiederverwendet ohne Änderung: `directMessages`, `friends`, `friendRequests`,
`guilds`, `serverGuilds`, `messages`, `readState`, `presence`, `voice/livekit`,
`voicePresence`, `settings`, `viewport`.

**Neu kommt kein Navigations-Store hinzu** — der Zustand „welcher Bereich, wie
tief" steht in der URL. `tabs.ts` leitet ihn ab; das ist reine Rechnung ohne
Speicher.

---

## 8. Wörter

Alle sichtbaren Texte gehen durch den Paraglide-Katalog (`web/messages/de.json`,
`en.json`), **auch die vier Bereichs-Namen**. Damit ist eine spätere Umbenennung
eine Katalogzeile.

Offen und bewusst am fertigen Bildschirm zu entscheiden: **wie der zweite
Bereich heißt.** Der Canvas sagt „Räume", die App sagt sonst überall
„Community" für dieselbe Sache (`CLAUDE.md`: Discord-„Guild" = „Community" im
UI). Zwei Wörter für eine Sache ist der wahrscheinlichere Stolperstein, nicht
die Wahl selbst. Die technische Adresse bleibt in jedem Fall `rooms`.

---

## 9. Phasen

Ein Commit je Phase auf `feat/mobile-chatfirst`. **Ein einziger PR am Ende** —
nichts Halbfertiges erreicht Nutzer. Nach Phase 3 steht bereits etwas
Benutzbares.

1. **Fundament** — `MobileTabBar`, `TabletNavRail` (Gerüst), `tabs.ts`, Routen
   `/app/rooms`, `/app/me`, Layout-Regel, `GuildRail` auf `hidden lg:flex`,
   Aufteilung von `ChannelList`.
2. **Chats** — DM-Vorschautext (Backend + Migration), aufgewertete Liste,
   `DMBubble` und der DM-Zweig in `ChatView`.
3. **Räume** — Kachel-Grid, Kanalliste, `ChannelSwitcherSheet`.
4. **Freunde**
5. **Du** — `/app/me`, Status-Sheet, Detail-Bildschirme, Plattform-Filter
   vervollständigen.
6. **Sprache und Video** — Knopfreihe, Lautsprecher-Chip, Video-Kacheln, Pin,
   Vollbild.
7. **Sheets** — Profil, Rollen, Mitglied-Menü, Bannen, Melden.
8. **Entdecken** — `listed` + `category` + `GET /c` + Bildschirm + Schalter im
   `GuildPublicAddressEditor`.
9. **Tablet** — `TabletNavRail` scharf, Master-Detail über alle Bereiche.
10. **Feinschliff** — beide Sprachkataloge vollständig, Durchgang über
    Safe-Areas und Trefferflächen, Changelog-Eintrag.

---

## 10. Prüfen

- **Backend:** `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest -q`
  nach jeder Phase, die den Server berührt (2, 8). Neue Tests: Vorschau-Kürzung
  und Anhang-Marker; Verzeichnis-Filter (`listed=false` erscheint nicht,
  `is_public=false` erscheint nicht), Kategorie- und Suchfilter.
- **Frontend:** `pnpm check`, `pnpm build`, `pnpm test:unit` je Phase.
  `tabs.ts` bekommt eigene Fälle (aktiver Bereich je Pfad; Detail-Screen ja/nein
  inklusive der Grenzfälle `/app/@me` ohne Kennung und `/app/rooms/[guildId]`).
- **Playwright** am Ende des Durchgangs, nicht je Phase.
- **Nicht automatisierbar** und vom Nutzer zu prüfen: Anfühlen der Übergänge,
  System-Back-Geste, Daumenreichweite, Kerbe und Home-Balken auf echtem Gerät.
  Zu jeder Phase wird benannt, was anzuschauen ist.
- Vor dem PR: das volle Gate aus `scripts/ship.sh`.

---

## 11. Risiken

- **`ChannelList`-Aufteilung** ist der einzige Eingriff in gemeinsam genutzten
  Code. Absicherung: keine Verhaltensänderung, `data-testid` unverändert,
  Playwright läuft gegen den Desktop-Pfad.
- **`GuildRail` auf `hidden lg:flex`** könnte Tests treffen, die sie unter
  1024 px erwarten. Wird in Phase 1 mitgezogen.
- **Zwei Wörter für eine Sache** (Räume/Community) — bewusst offen, §8.
- **Verzeichnis-Sichtbarkeit** ist der einzige Punkt mit Datenschutz-Gewicht.
  Absicherung: Vorgabe `false`, kein Backfill, eigener Schalter, Test gegen
  `listed=false`.
