# Mobile- und Tablet-Redesign „chat-first" — Arbeitsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Handy und Tablet bekommen vier Bereiche (Chats, Räume, Freunde, Du)
statt der dauerhaften `GuildRail`; Desktop bleibt unangetastet.

**Architecture:** Die Bereiche sind echte SvelteKit-Routen, der Navigations-Stack
ist die URL — damit funktionieren System-Back-Geste und Benachrichtigungs-
Deeplinks ohne Zusatzcode. Eine einzige Layout-Regel in `app/+layout.svelte`
entscheidet anhand von `viewport` und einem importfreien Pfad-Modul, wer auf
welcher Bildschirmgröße sichtbar ist.

**Tech Stack:** SvelteKit (SPA, `ssr=false`), Svelte 5 Runes, Tailwind 4,
shadcn-svelte/bits-ui, Paraglide (de/en), FastAPI + SQLAlchemy[asyncio] +
Alembic (chat-Schema), pytest, Playwright, Nodes eingebauter Testläufer.

**Spec:** `docs/superpowers/specs/2026-08-22-mobile-chatfirst-design.md`

## Global Constraints

- **Desktop (`≥ lg`) bleibt unverändert.** Jede Regel gilt auf `< lg`.
- **Größen-Policy** (`PLAN.md` §12.1): Quelldateien ≤ 350 Zeilen (hart 500),
  Svelte-Komponenten ≤ 250. Ausgenommen: Tests, Migrationen,
  `lib/components/ui/`.
- **Keine neuen Abhängigkeiten** ohne Rückfrage.
- **Refactoring darf Verhalten nicht ändern** — Routen, Response-Modelle und
  `data-testid` bleiben identisch.
- **Alle sichtbaren Texte** durch `web/messages/{de,en}.json`, Keys
  **append-only** anhängen (nicht sortieren). Das gilt auch für die vier
  Bereichs-Namen.
- **Keine Emojis** — nirgends. Changelog und Commit-Messages mit **echten
  Umlauten** (ä/ö/ü/ß).
- **Snowflake-IDs sind Strings** über die API.
- **Nie Stream-Keys oder Tokens loggen.**
- **Testfähige Module dürfen keinen erweiterungslosen Laufzeit-Import haben**
  (`from './nachbar'`) — Node löst ihn nicht auf.
- **Ein Commit je Phase**, ein einziger PR am Ende. Kein Push ohne Freigabe.
- **Tokens aus `web/src/app.css`** verwenden (`bg-bg-*`, `text-text-*`,
  `rounded-*`), nicht die Inline-Styles des Prototyps.

### Maße aus dem Canvas (verbindlich)

| Element | Wert |
|---|---|
| Bereichs-Leiste | Höhe 60 px, `padding:0 6px 12px`, `border-top` 1 px `--panel-border`, Hintergrund `--panel-solid` |
| Bereichs-Eintrag | Symbol 23 px, Label 11 px/600, Abstand 3 px, `padding:6px 14px`, `rounded-[12px]`, aktiv `--primary`, sonst `--text-faint` |
| Badge an der Leiste | `min-w-16px h-16px`, `top:-4px right:-8px`, `--count`, 10 px/800 |
| Compose-FAB | 52 × 52, `rounded-[16px]`, `--grad`, `right:16px`, Schatten `0 10px 22px -6px rgba(37,99,235,.7)` |
| Chat-Zeile | Avatar 46 px, Abstand 12 px, `padding:10px`, `rounded-[14px]`, Präsenzpunkt 13 px mit 3 px Rand |
| Ungelesen-Pille | `min-w-20px h-20px`, `rounded-full`, `--count`, 11 px/800 |
| Listenkopf | Titel 22 px/800, `padding:14px 16px 8px`, Symbol 22 px |
| Segment-Chips | 13 px/600, `padding:6px 13px`, `rounded-full`, aktiv `--accent-soft` auf `#bcd6ff` |
| Voice-Dock-Knöpfe | 44 × 44 (heute 38) |
| Tablet-Leiste | Breite 78 px |
| Sprechblasen | außen 20 px, innen an der Sprech-Seite 7 px, Gruppenabstand 2 px |
| Übergang | ~0,26 s `cubic-bezier(.3,.8,.3,1)` |

---

## Dateiplan

**Neu:**

| Datei | Verantwortung |
|---|---|
| `web/src/lib/navigation/tabs.ts` | Reine Rechnung: Pfad → aktiver Bereich, Pfad → Detail-Screen ja/nein. Importfrei. |
| `web/src/lib/components/mobile/MobileTabBar.svelte` | Bottom-Leiste, vier Ziele, Badges. |
| `web/src/lib/components/mobile/TabletNavRail.svelte` | 78-px-Symbolspalte für `md`–`lg`. |
| `web/src/lib/components/mobile/ChannelSwitcherSheet.svelte` | Kanal-Wechsler von unten. |
| `web/src/lib/components/mobile/MobileRoomGrid.svelte` | Community-Kacheln, nach Server gruppiert. |
| `web/src/lib/components/DMBubble.svelte` | Eine DM-Sprechblase samt Gruppierungslogik. |
| `web/src/routes/app/rooms/+page.svelte` | Räume-Liste. |
| `web/src/routes/app/rooms/[guildId]/+page.svelte` | Kanäle einer Community. |
| `web/src/routes/app/me/+page.svelte` | Du-Übersicht. |
| `web/src/routes/app/me/[section]/+page.svelte` | Einstellungs-Detail. |
| `web/src/routes/app/discover/+page.svelte` | Entdecken. |
| `web/test/tabs.test.ts` | Fälle für `tabs.ts`. |

**Aufgeteilt:** `web/src/lib/components/ChannelList.svelte` (819 Z.) → Kopf,
Liste, Kanalzeile.

**Geändert:** `app/+layout.svelte` (Layout-Regel), `GuildRail.svelte`
(`hidden lg:flex`), `ChatView.svelte` (DM-Zweig), `DMChannelList.svelte`
(Vorschauzeile), `VoiceControlBar.svelte` (Knopfgrößen, Lautsprecher-Chip),
`settingsTabs.ts` (restliche Auszeichnungen), `routes/dms.py` (Vorschaufelder),
`routes/public_community.py` (`GET /c`), `models/guilds.py` (`listed`,
`category`), `GuildPublicAddressEditor.svelte` (Schalter).

---

## Task 1: Pfad-Rechnung `tabs.ts`

**Files:**
- Create: `web/src/lib/navigation/tabs.ts`
- Test: `web/test/tabs.test.ts`

**Interfaces:**
- Produces: `type TabId = 'chats' | 'rooms' | 'friends' | 'me'`;
  `aktiverBereich(pfad: string): TabId | null`;
  `istDetailScreen(pfad: string): boolean`;
  `BEREICHE: readonly { id: TabId; href: string }[]`.

- [ ] **Step 1: Testdatei schreiben**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aktiverBereich, istDetailScreen } from '../src/lib/navigation/tabs.ts';

test('Listen-Pfade treffen ihren Bereich', () => {
  assert.equal(aktiverBereich('/app/@me'), 'chats');
  assert.equal(aktiverBereich('/app/rooms'), 'rooms');
  assert.equal(aktiverBereich('/app/friends'), 'friends');
  assert.equal(aktiverBereich('/app/me'), 'me');
});

test('Kanal-Route gehoert zu Raeume, nicht zu Chats', () => {
  assert.equal(aktiverBereich('/app/guilds/12/channels/34'), 'rooms');
});

test('Entdecken haengt am Raeume-Bereich', () => {
  assert.equal(aktiverBereich('/app/discover'), 'rooms');
});

test('Unbekanntes gibt null', () => {
  assert.equal(aktiverBereich('/app/admin'), null);
  assert.equal(aktiverBereich('/login'), null);
});

test('Listen sind keine Detail-Screens', () => {
  for (const p of ['/app/@me', '/app/rooms', '/app/friends', '/app/me']) {
    assert.equal(istDetailScreen(p), false, p);
  }
});

test('Detail-Screens werden erkannt', () => {
  assert.equal(istDetailScreen('/app/@me/34'), true);
  assert.equal(istDetailScreen('/app/rooms/12'), true);
  assert.equal(istDetailScreen('/app/guilds/12/channels/34'), true);
  assert.equal(istDetailScreen('/app/me/appearance'), true);
});

test('Nachlaufender Schraegstrich aendert nichts', () => {
  assert.equal(aktiverBereich('/app/rooms/'), 'rooms');
  assert.equal(istDetailScreen('/app/rooms/'), false);
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `cd web && pnpm test:unit`
Expected: FAIL — Modul `tabs.ts` existiert nicht.

- [ ] **Step 3: `tabs.ts` schreiben**

Reine Rechnung, **keine Imports**. `aktiverBereich` normalisiert den Pfad
(nachlaufenden Schrägstrich entfernen), prüft die Detail-Präfixe vor den
Listen-Präfixen, ordnet `/app/guilds/**` und `/app/discover` dem Bereich
`rooms` zu. `istDetailScreen` ist wahr, sobald hinter dem Listen-Pfad noch ein
nicht-leeres Segment steht.

- [ ] **Step 4: Test laufen lassen, grün bestätigen**

Run: `cd web && pnpm test:unit`
Expected: PASS.

- [ ] **Step 5: Nicht committen** — geht mit Task 4 zusammen in den Phasen-Commit.

---

## Task 2: `ChannelList` aufteilen

**Files:**
- Modify: `web/src/lib/components/ChannelList.svelte` (819 Z.)
- Create: `web/src/lib/components/channels/ChannelListHeader.svelte`
- Create: `web/src/lib/components/channels/ChannelRow.svelte`
- Create: `web/src/lib/components/channels/ChannelSections.svelte`

**Interfaces:**
- Produces: `ChannelRow` mit Props `{ channel, guildId, active, kompakt }`;
  `ChannelSections` mit `{ guildId, onSelect }`. Beide werden in Task 8
  (Wechsler-Sheet) und Task 9 (Tablet-Spalte) wiederverwendet.

- [ ] **Step 1: Ausgangslage festhalten**

Run: `cd web && pnpm exec playwright test --grep "channel" --reporter=line`
Notieren, was grün ist — das ist die Messlatte.

- [ ] **Step 2: Kopf herauslösen** — Community-Name, Einladen, Verwalten nach
  `ChannelListHeader.svelte`. `data-testid` unverändert übernehmen.

- [ ] **Step 3: Kanalzeile herauslösen** — eine Zeile (Symbol, Name,
  Ungelesen-Punkt/-Zähler, Voice-Präsenz) nach `ChannelRow.svelte`. Prop
  `kompakt` steuert nur Polsterung, nichts sonst.

- [ ] **Step 4: Abschnitte herauslösen** — Text- und Sprachkanal-Gruppen nach
  `ChannelSections.svelte`.

- [ ] **Step 5: Zeilenzahl prüfen**

Run: `wc -l web/src/lib/components/ChannelList.svelte web/src/lib/components/channels/*.svelte`
Expected: jede Datei ≤ 250 Zeilen.

- [ ] **Step 6: Gegenprobe**

Run: `cd web && pnpm check && pnpm exec playwright test --grep "channel" --reporter=line`
Expected: dieselben Tests grün wie in Step 1. **Rot heißt: der Code ist kaputt,
nicht der Test.**

---

## Task 3: Bereichs-Leiste und Tablet-Spalte

**Files:**
- Create: `web/src/lib/components/mobile/MobileTabBar.svelte`
- Create: `web/src/lib/components/mobile/TabletNavRail.svelte`
- Modify: `web/messages/de.json`, `web/messages/en.json`

**Interfaces:**
- Consumes: `aktiverBereich`, `BEREICHE` aus Task 1.
- Produces: beide Komponenten ohne Props; sie lesen `page.url.pathname` selbst.

- [ ] **Step 1: Katalog-Keys anhängen** (append-only, ans Ende)

`nav_tab_chats`, `nav_tab_rooms`, `nav_tab_friends`, `nav_tab_me` —
de: „Chats", „Räume", „Freunde", „Du"; en: „Chats", „Rooms", „Friends", „You".

- [ ] **Step 2: `MobileTabBar` bauen** — Maße aus den Global Constraints.
  Badge an *Freunde* aus `friendRequests` (eingehende), an *Chats* aus
  `readState` × `directMessages`. Unterer Rand `pb-[var(--safe-bottom)]`.
  Jeder Eintrag ist ein `<a>` mit `data-testid="tab-<id>"`, Trefferfläche
  ≥ 48 dp.

- [ ] **Step 3: `TabletNavRail` bauen** — dieselben vier, 78 px breit, Symbol
  über Label, gleiche Badges, gleiche `data-testid`.

- [ ] **Step 4: Übersetzung prüfen**

Run: `cd web && pnpm check`
Expected: keine Fehler, keine fehlenden Katalog-Keys.

---

## Task 4: Routen und Layout-Regel

**Files:**
- Modify: `web/src/routes/app/+layout.svelte`
- Modify: `web/src/lib/components/GuildRail.svelte`
- Create: `web/src/routes/app/rooms/+page.svelte` (Platzhalter-Liste)
- Create: `web/src/routes/app/me/+page.svelte` (Platzhalter-Liste)

**Interfaces:**
- Consumes: `MobileTabBar`, `TabletNavRail` (Task 3), `tabs.ts` (Task 1).

- [ ] **Step 1: `GuildRail` auf `hidden lg:flex` setzen.**

- [ ] **Step 2: Layout-Regel einbauen** — in `app/+layout.svelte`, unterhalb
  des bestehenden `{@render children}`-Blocks:

```
< md   : MobileTabBar, außer istDetailScreen(pfad)
md–lg  : TabletNavRail links
>= lg  : nichts davon
```

Die Leiste sitzt **unter** dem Voice-Dock (das Dock behält seinen Platz über
ihr, wie im Canvas 3a).

- [ ] **Step 3: Zwei dünne Routen anlegen**, damit die Leiste überall ein Ziel
  hat: `/app/rooms` und `/app/me` mit je einer schlichten Liste. Inhalt kommt in
  Task 7 und 10.

- [ ] **Step 4: Prüfen**

Run: `cd web && pnpm check && pnpm build && pnpm test:unit`
Expected: alles grün.

- [ ] **Step 5: Am Bildschirm ansehen** — Browser auf 390 × 844 stellen:
  Leiste unten sichtbar, GuildRail weg, im offenen Chat Leiste weg,
  Zurück-Pfeil führt zurück, Browser-Zurück ebenso.

- [ ] **Step 6: Phase 1 committen**

```bash
git add web/src/lib/navigation web/test/tabs.test.ts \
        web/src/lib/components/mobile web/src/lib/components/channels \
        web/src/lib/components/ChannelList.svelte \
        web/src/lib/components/GuildRail.svelte \
        web/src/routes/app/+layout.svelte web/src/routes/app/rooms \
        web/src/routes/app/me web/messages
git commit -m "feat(mobile): chat-first Fundament — vier Bereiche statt GuildRail"
```

---

## Task 5: DM-Vorschautext am Server

**Files:**
- Modify: `services/chat-gateway/src/dcc_chat_gateway/routes/dms.py:48`
- Modify: `services/chat-gateway/src/dcc_chat_gateway/schemas.py`
- Test: `services/chat-gateway/tests/test_dms.py`

**Interfaces:**
- Produces: DM-Listeneintrag zusätzlich mit `last_message_preview: str | null`,
  `last_message_author_id: str | null`, `last_message_at: str | null`.

- [ ] **Step 1: Fehlschlagende Tests schreiben**

```python
async def test_dm_liste_traegt_vorschautext(client, seed_dm_mit_nachricht):
    r = await client.get("/dms")
    eintrag = r.json()[0]
    assert eintrag["last_message_preview"] == "Hallo Welt"
    assert eintrag["last_message_author_id"] is not None
    assert eintrag["last_message_at"] is not None


async def test_vorschau_wird_auf_80_zeichen_gekuerzt(client, seed_dm_lange_nachricht):
    r = await client.get("/dms")
    assert len(r.json()[0]["last_message_preview"]) <= 80


async def test_zeilenumbrueche_werden_zu_leerzeichen(client, seed_dm_mehrzeilig):
    assert "\n" not in (await client.get("/dms")).json()[0]["last_message_preview"]


async def test_anhang_ohne_text_wird_zum_marker(client, seed_dm_nur_bild):
    assert (await client.get("/dms")).json()[0]["last_message_preview"] == "__image__"


async def test_geloeschte_letzte_nachricht_gibt_null(client, seed_dm_geloescht):
    assert (await client.get("/dms")).json()[0]["last_message_preview"] is None
```

- [ ] **Step 2: Laufen lassen, Fehlschlag bestätigen**

Run: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest services/chat-gateway/tests/test_dms.py -q`
Expected: FAIL — Schlüssel fehlt.

- [ ] **Step 3: Umsetzen** — die Listen-Abfrage lädt die letzte Nachricht mit;
  Vorschau auf 80 Zeichen gekürzt, `\n`/`\r` zu Leerzeichen, Anhang ohne Text →
  `"__image__"` bei Bild-Mimetype, sonst `"__file__"`. **Dateiname geht nicht
  mit.**

- [ ] **Step 4: Laufen lassen, grün bestätigen**

Run: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest services/chat-gateway/tests -q`
Expected: PASS, keine Regression.

---

## Task 6: Chats-Bereich

**Files:**
- Modify: `web/src/lib/components/DMChannelList.svelte`
- Create: `web/src/lib/components/DMBubble.svelte`
- Modify: `web/src/lib/components/ChatView.svelte`
- Modify: `web/src/lib/stores/directMessages.svelte.ts` (neue Felder)
- Modify: `web/messages/{de,en}.json`

**Interfaces:**
- Consumes: die drei Felder aus Task 5.
- Produces: `DMBubble` mit `{ message, eigen, ersteDerGruppe, letzteDerGruppe }`.

- [ ] **Step 1: Katalog-Keys anhängen** — `dm_preview_image` („Bild"/„Image"),
  `dm_preview_file` („Datei"/„File"), `dm_preview_own_prefix` („Du: "/„You: ").

- [ ] **Step 2: Liste aufwerten** — Avatar 46 px mit Präsenzpunkt, Name,
  Vorschauzeile, Uhrzeit rechts, Ungelesen-Pille; Maße aus den Global
  Constraints. Compose-FAB unten rechts, über der Bereichs-Leiste.

- [ ] **Step 3: `DMBubble` bauen** — eigene Nachrichten rechts auf `--grad` in
  Weiß, fremde links auf `--bg-input`. Ecken: außen 20 px, innen an der
  Sprech-Seite 7 px. Gruppenabstand 2 px, Uhrzeit nur bei `letzteDerGruppe`,
  keine Avatare.

- [ ] **Step 4: `ChatView` verzweigen** — `headerKind === 'dm'` rendert
  `DMBubble`, alles andere unverändert `MessageItem`. **Community-Kanäle dürfen
  sich nicht ändern.**

- [ ] **Step 5: Prüfen**

Run: `cd web && pnpm check && pnpm build && pnpm test:unit`
Und: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest -q`

- [ ] **Step 6: Am Bildschirm ansehen** — eine DM und ein Community-Kanal
  nebeneinander: Blasen nur in der DM, der Kanal unverändert.

- [ ] **Step 7: Phase 2 committen**

```bash
git commit -am "feat(mobile): Chats-Bereich — Vorschauzeile und DM-Sprechblasen"
```

---

## Task 7: Räume-Bereich

**Files:**
- Create: `web/src/lib/components/mobile/MobileRoomGrid.svelte`
- Create: `web/src/lib/components/mobile/ChannelSwitcherSheet.svelte`
- Modify: `web/src/routes/app/rooms/+page.svelte`
- Create: `web/src/routes/app/rooms/[guildId]/+page.svelte`
- Modify: `web/src/routes/app/guilds/[guildId]/channels/[channelId]/+page.svelte`

**Interfaces:**
- Consumes: `ChannelSections`, `ChannelListHeader` (Task 2).

- [ ] **Step 1: Kachel-Grid bauen** — je Community Icon, Name, Online-Zahl,
  Ungelesen-Punkt. Mehrere Pulse-Server → je Server eine Zwischenüberschrift aus
  `serverGuilds`. Leerzustand verweist auf `/app/discover`.

- [ ] **Step 2: Kanalliste als Route** — `/app/rooms/[guildId]` rendert
  `ChannelListHeader` + `ChannelSections`; ein Kanal-Tipp navigiert auf die
  **bestehende** Kanal-Route.

- [ ] **Step 3: Wechsler-Sheet bauen** — von unten, `rounded-t-[22px]`, Scrim
  `rgba(0,0,0,.5)`, Grabber oben; Inhalt `ChannelSections`. Muster:
  `MessageActionSheet.svelte`.

- [ ] **Step 4: Titel antippbar machen** — im Kanal-Chat auf `< lg` öffnet der
  Titel das Sheet. `navDrawer` wird auf `< lg` nicht mehr verwendet.

- [ ] **Step 5: Prüfen**

Run: `cd web && pnpm check && pnpm build`

- [ ] **Step 6: Am Bildschirm ansehen** — Räume → Community → Kanal → zurück,
  jeweils mit Pfeil und mit Browser-Zurück; Titel-Tipp öffnet und schließt das
  Sheet.

- [ ] **Step 7: Phase 3 committen**

```bash
git commit -am "feat(mobile): Raeume-Bereich — Kacheln, Kanalliste, Wechsler-Sheet"
```

---

## Task 8: Freunde-Bereich

**Files:**
- Modify: `web/src/routes/app/friends/+page.svelte`
- Modify: `web/messages/{de,en}.json`

- [ ] **Step 1: Segmentierte Umschaltung** Online / Alle / Ausstehend, Chips
  nach den Maßen der Global Constraints.

- [ ] **Step 2: Liste nach Präsenz sortieren** (online → abwesend → offline),
  Status als Untertext, je Zeile ein Nachricht-Knopf, der die DM öffnet und in
  den Chats-Bereich wechselt.

- [ ] **Step 3: Ausstehend** — eingehende Anfragen mit Annehmen/Ablehnen,
  gesendete darunter. Dieselbe Quelle wie das Badge an der Bereichs-Leiste.

- [ ] **Step 4: Hinzufügen** — bestehendes `InviteByUsername` einbetten.

- [ ] **Step 5: Prüfen und committen**

Run: `cd web && pnpm check && pnpm build`
```bash
git commit -am "feat(mobile): Freunde-Bereich mit Praesenz-Sortierung und Anfragen"
```

---

## Task 9: Du-Bereich

**Files:**
- Modify: `web/src/routes/app/me/+page.svelte`
- Create: `web/src/routes/app/me/[section]/+page.svelte`
- Modify: `web/src/lib/components/settingsTabs.ts`
- Modify: `web/messages/{de,en}.json`

**Interfaces:**
- Consumes: `getSettingsTabs()` und dieselbe `visibleTabs`-Rechnung wie
  `SettingsDialog.svelte` — **keine zweite danebenstellen.**

- [ ] **Step 1: Die Rechnung teilen** — die `visibleTabs`-Filterung aus
  `SettingsDialog.svelte` in `settingsTabs.ts` ziehen (`sichtbareReiter(...)`),
  Dialog und `/app/me` rufen dieselbe Funktion.

- [ ] **Step 2: Übersicht bauen** — Profilblock (Avatar 56 px, Name,
  `@username`, Status-Chip), gruppierte Einträge mit aktuellem Wert rechts,
  „Abmelden" in Rot.

- [ ] **Step 3: Status-Sheet** — Online / Abwesend / Bitte nicht stören /
  Unsichtbar.

- [ ] **Step 4: Detail-Route** — `/app/me/[section]` rendert die vorhandenen
  `Settings*`-Komponenten, aufgeschoben mit Zurück-Pfeil.

- [ ] **Step 5: Restliche Computer-Bereiche auszeichnen** — prüfen, welche
  Reiter auf dem Handy nichts tun, und `desktopOnly` ergänzen.
  `notifications` auf Mobil nach oben.

- [ ] **Step 6: Prüfen und committen**

Run: `cd web && pnpm check && pnpm build`
```bash
git commit -am "feat(mobile): Du-Bereich mit Profil, Status und Einstellungen"
```

---

## Task 10: Sprache und Video

**Files:**
- Modify: `web/src/lib/components/VoiceControlBar.svelte`
- Modify: `web/src/lib/components/VoiceChannelView.svelte`
- Modify: `web/src/lib/components/StreamGrid.svelte`

- [ ] **Step 1: Knopfreihe** — vier runde 56-px-Knöpfe (Mikrofon, Taub, Kamera,
  Auflegen), garantiert einzeilig. Voice-Dock-Knöpfe von 38 auf 44 px.

- [ ] **Step 2: Lautsprecher-Chip** — aus der Reihe in die Statuszeile darüber
  (Android-`audioRoute`). Auf `md`+ zurück in die Reihe.

- [ ] **Step 3: Video-Kacheln** — Kamera an → `CameraTile`, Sprech-Ring grün,
  stumm rotes Mikrofon, Front/Rück-Wechsel auf der eigenen Kachel.

- [ ] **Step 4: Pin und Vollbild** — Kachel-Tipp pinnt groß mit
  Thumbnail-Streifen; Vollbild quer, randlos, Controls als Glas-Pille mit
  Auto-Ausblenden.

- [ ] **Step 5: Prüfen und committen** — Bildschirm teilen und Watch-Party
  müssen mobil weiterhin ausgeblendet sein.

Run: `cd web && pnpm check && pnpm build`
```bash
git commit -am "feat(mobile): Sprache und Video — einzeilige Knopfreihe, Kacheln, Vollbild"
```

---

## Task 11: Blätter von unten

**Files:**
- Modify: `web/src/lib/components/UserProfilePopover.svelte`
- Modify: `web/src/lib/components/MemberQuickRoleMenu.svelte`

- [ ] **Step 1: Profil als Sheet** auf `< lg`; aus einer Community zusätzlich
  Server-Nick und Rollen-Pills (Farben aus `nameColor.ts`).

- [ ] **Step 2: Rollen-Checkliste im Sheet** — ohne `@everyone`, nach Position;
  **die bestehende Anti-Eskalations-Sperre bleibt unangetastet.**

- [ ] **Step 3: `•••`-Menü** — Nachricht/Erwähnen, Rollen verwalten,
  Rauswerfen/Bannen/Melden, je nach Berechtigung.

- [ ] **Step 4: Bannen und Melden bleiben zentrierte Dialoge.** Nicht zu Sheets
  umbauen.

- [ ] **Step 5: Prüfen und committen**

Run: `cd web && pnpm check && pnpm build`
```bash
git commit -am "feat(mobile): Profil, Rollen und Moderation als Blaetter von unten"
```

---

## Task 12: Entdecken — Server

**Files:**
- Modify: `services/chat-gateway/src/dcc_chat_gateway/models/guilds.py`
- Create: `services/chat-gateway/alembic/versions/<rev>_guild_listed_category.py`
- Modify: `services/chat-gateway/src/dcc_chat_gateway/routes/public_community.py`
- Test: `services/chat-gateway/tests/test_public_community.py`

**Interfaces:**
- Produces: `GET /c?q=&category=&limit=&cursor=` → Einträge mit `handle`,
  `name`, `icon_url`, `description`, `category`, `member_count`, `online_count`.

- [ ] **Step 1: Fehlschlagende Tests schreiben**

```python
async def test_verzeichnis_zeigt_nur_gelistete(client, seed_public_nicht_gelistet):
    r = await client.get("/c")
    assert r.json()["items"] == []


async def test_gelistete_erscheint(client, seed_public_gelistet):
    assert (await client.get("/c")).json()["items"][0]["handle"] == "pulse-hq"


async def test_private_erscheint_nie(client, seed_privat_aber_listed):
    assert (await client.get("/c")).json()["items"] == []


async def test_kategorie_filtert(client, seed_zwei_kategorien):
    r = await client.get("/c", params={"category": "gaming"})
    assert {e["category"] for e in r.json()["items"]} == {"gaming"}


async def test_suche_trifft_namen(client, seed_public_gelistet):
    assert (await client.get("/c", params={"q": "pulse"})).json()["items"]


async def test_ohne_anmeldung_401(anon_client):
    assert (await anon_client.get("/c")).status_code == 401


async def test_seitengroesse_gedeckelt(client, seed_viele):
    assert len((await client.get("/c", params={"limit": 500})).json()["items"]) <= 50
```

- [ ] **Step 2: Laufen lassen, Fehlschlag bestätigen**

Run: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest services/chat-gateway/tests/test_public_community.py -q`

- [ ] **Step 3: Migration schreiben** — `listed BOOLEAN NOT NULL DEFAULT false`,
  `category VARCHAR(16) NULL`. **Kein Backfill.** Revision-ID ≤ 32 Zeichen.

- [ ] **Step 4: Endpunkt umsetzen** — `CurrentUser` verlangt, `is_public AND
  listed`, Seitengröße serverseitig auf 50 gedeckelt, Kategorien fest:
  `gaming | music | tech | creative | other`.

- [ ] **Step 5: Laufen lassen, grün bestätigen**

Run: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest services/chat-gateway/tests -q`

---

## Task 13: Entdecken — Bildschirm und Schalter

**Files:**
- Create: `web/src/routes/app/discover/+page.svelte`
- Modify: `web/src/lib/components/settings/GuildPublicAddressEditor.svelte`
- Modify: `web/src/lib/api/chat.ts`
- Modify: `web/messages/{de,en}.json`

- [ ] **Step 1: Schalter „Im Verzeichnis zeigen"** im
  `GuildPublicAddressEditor` — verlangt `MANAGE_GUILD`, **nur bedienbar wenn
  `is_public` an ist**, Vorgabe aus. Dazu die Kategorie-Auswahl.

- [ ] **Step 2: Entdecken-Bildschirm** — Suchfeld, Feld „per Link oder Adresse
  beitreten" gegen `joinByHost`/`joinByInvite`, Kategorie-Chips, Karten mit
  Banner, Icon, Zahlen und Beitreten-Knopf.

- [ ] **Step 3: Prüfen und committen**

Run: `cd web && pnpm check && pnpm build` und der volle pytest-Lauf.
```bash
git commit -am "feat(mobile): Entdecken — Verzeichnis oeffentlicher Communities"
```

---

## Task 14: Tablet

**Files:**
- Modify: `web/src/routes/app/+layout.svelte`
- Modify: die Listen-Routen aus Task 6–9

- [ ] **Step 1: `TabletNavRail` scharf schalten** für `md`–`lg`.

- [ ] **Step 2: Master-Detail** — auf `md`–`lg` zeigen die Listen-Routen Liste
  **und** Detail nebeneinander; bei den Räumen wird die mittlere Spalte zur
  Kanalliste mit Zurück-Pfeil zu den Communities.

- [ ] **Step 3: Lautsprecher zurück in die Knopfreihe** auf `md`+.

- [ ] **Step 4: Prüfen und committen**

Run: `cd web && pnpm check && pnpm build`
```bash
git commit -am "feat(tablet): Symbolspalte und Master-Detail"
```

---

## Task 15: Feinschliff

- [ ] **Step 1: Sprachkataloge vollständig** — beide Dateien gegeneinander
  prüfen, kein hartkodiertes Deutsch mehr in den neuen Dateien.

- [ ] **Step 2: Durchgang Trefferflächen** — jede neue tippbare Fläche ≥ 48 dp.

- [ ] **Step 3: Durchgang Safe-Areas** — Bereichs-Leiste und Voice-Dock über
  `var(--safe-bottom)`, Kopfzeilen unter `var(--safe-top)`.

- [ ] **Step 4: Changelog-Eintrag** oben in `web/static/changelog.json`,
  `id: "2026-08-22"`, Stil sachlich, **keine Emojis, echte Umlaute**.

- [ ] **Step 5: Volles Gate**

Run: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest -q`
Run: `cd web && pnpm check && pnpm build && pnpm test:unit`
Run: `cd web && pnpm exec playwright test`
Expected: alles grün. `admin.spec` flakt unter Last — wandert der Fehlschlag
zwischen Läufen, erst einzeln nachfahren, dann urteilen.

- [ ] **Step 6: Committen und dem Nutzer vorlegen.** **Kein Push ohne
  Freigabe.**

---

## Selbstprüfung des Plans

**Spec-Abdeckung:** §3 Navigation → Task 1, 3, 4. §3.4 `ChannelList` → Task 2.
§4.1 Vorschautext → Task 5. §4.2 Verzeichnis → Task 12, 13. §5.1 Chats →
Task 6. §5.2 Räume → Task 7. §5.3 Freunde → Task 8. §5.4 Du → Task 9.
§5.5 Sprache → Task 10. §5.6 Entdecken → Task 13. §5.7 Profil/Moderation →
Task 11. §6 Plattform → Task 3, 15. §7 Zustand → kein eigener Task (nichts
Neues). §8 Wörter → Task 3, 15. §10 Prüfen → in jedem Task.

**Offen und bewusst so:** der Name des zweiten Bereichs (§8) wird am fertigen
Bildschirm entschieden; bis dahin steht „Räume" im Katalog.
