# Watch-Party Host-Handoff — Design

**Datum:** 2026-06-02
**Status:** Design abgenommen, bereit für Implementierungsplan
**Betrifft:** Watch-Party-Schiene (chat-gateway + web)

## Problem

Heute ist die Watch-Party **Single-Host**: genau ein User kontrolliert play/pause/seek,
alle anderen sind Viewer. Verliert der Host die Verbindung oder verlässt er den
Voice-Channel, **endet die Party für alle** (`cleanup_on_disconnect` → `delete_state`).
Ein Host-WLAN-Drop bei Minute 90 killt den Film für die ganze Runde. Es gibt keinen
Host-Wechsel.

Zwei verwandte Review-Befunde hängen mit dran:
- **Reconnect-Zombie (#2):** `hosted_parties` ist ein per-Socket-Set. Nach einem
  WS-Reconnect ist der Channel nicht mehr drin → `cleanup_on_disconnect` feuert nie
  wieder → Party bleibt bis zur 6h-TTL als Geist stehen.
- **Multi-Tab-Host-Konflikt (#3):** Zwei echte Tabs desselben Users werten beide
  `isHost` über `host_user_id`-Match → beide broadcasten Control.

## Ziel & gewählte Anforderungen

Aus dem Brainstorming festgeklopft:

1. **Kontroll-Modell:** Single-Host bleibt, mit **Auto-Promote** — beim Wegfall des
   Hosts wählt der Server automatisch einen Nachfolger.
2. **Trigger (alle vier):**
   - Host-Disconnect (WS weg)
   - Host verlässt Voice-Channel
   - Host schließt die Party-Kachel
   - Host gibt explizit ab (inkl. gezielt an eine bestimmte Person)
3. **Promotions-Ziel:** der **älteste verbliebene Watcher** (längste Zugehörigkeit
   zur Party).
4. **Leere Watcher-Menge:** Party **sofort beenden** (entspricht heutigem Verhalten;
   der Solo-Host-Reconnect-Edge ist bewusst akzeptiert — bei null Zuschauern schaut eh
   niemand weiter).
5. **Explizites Handoff-UI mit Personen-Picker** in v1 (nicht nur „an nächsten").

## Kern-Erkenntnis

Weil „Host schließt die Kachel" ein Trigger ist, muss der Server wissen, **wer die
Party-Kachel gerade gemountet hat** — reine Voice-Presence reicht nicht. Der
`WatchPartyTile` (und damit der Player) wird nur gemountet, wenn ein Viewer die Kachel
aktiv geöffnet hat (`openedTiles.isOpenParty`, Default leer, „no auto-mount"). Nur wer
die Kachel offen hat, kann Heartbeats senden und taugt als Host.

Daraus folgt eine **Watcher-Menge** pro Party. Trigger 1–3 reduzieren sich alle auf
„der Host verlässt die Watcher-Menge"; nur Trigger 4 braucht Extra-Mechanik
(gezieltes Target).

## Gewählter Ansatz: Server-autoritative Watcher-Menge, Server promotet

Verworfene Alternativen:
- **Voice-Presence wiederverwenden + Client auto-mountet:** kann Trigger 3 (Kachel zu)
  gar nicht erkennen; das Voice-Set ist ungeordnet (kein Join-Zeitstempel) → „ältester"
  nicht bestimmbar; ploppt jemandem ungefragt ein Video auf.
- **Client-seitige Wahl, Server validiert Claims:** Clients brauchen die volle
  Watcher-Liste trotzdem; verteilte Wahl ist race-anfällig und schwerer zu testen.

## Architektur & Datenmodell

**Kernentscheidung: Die Watcher-Menge lebt in-process im `ConnectionManager`, nicht in
Redis.** Sie hat genau einen Schreiber (das Gateway selbst — anders als voice/stream-Sets,
die LiveKit/MediaMTX-Webhooks aus fremden Prozessen füllen) und wird nur im Moment des
Host-Wegfalls konsultiert, immer auf dem Pod, auf dem der wegfallende Host-Socket hängt.
Exakt das Muster vom bestehenden per-Socket-`hosted_parties`. Kein neuer Redis-Key, keine
TTL-/Self-Heal-Verwaltung, keine Serialisierung. Das Cross-Pod-Limit wird bewusst
übernommen (deckt sich mit den dokumentierten Single-Pod-Annahmen der Watch-Schiene).

Zwei Strukturen:

### 1. Watcher-Registry im Manager

Neue kleine Mixin `_WatchRegistryMixin` in `pubsub.py` (analog zu den bestehenden
Mixins), Teil der `ConnectionManager`-Komposition.

```
_watchers: dict[channel_id: str, dict[user_id: str, WatcherEntry]]
WatcherEntry = { joined_at: int(ms), sockets: set[WebSocket] }
```

- **User-Granularität mit Socket-Refcount** → Multi-Tab-korrekt: zwei Tabs desselben
  Users = ein Watcher-Eintrag; erst wenn der letzte Socket geht, fällt der User raus.
- `joined_at` wird beim Re-Join (zweiter Tab / Reconnect) **nicht** zurückgesetzt →
  Promotions-Reihenfolge stabil.
- Methoden, alle unter `self._lock`:
  - `watch_join(cid, uid, ws)` — Eintrag sicherstellen, Socket adden, `joined_at` nur
    setzen wenn neu.
  - `watch_leave(cid, uid, ws) -> user_fully_left: bool` — Socket entfernen; wenn
    Eintrag leer, User droppen und `True` zurückgeben.
  - `next_host(cid, exclude_uid) -> uid | None` — User mit kleinstem `joined_at`,
    `exclude_uid` ausgenommen.

### 2. Per-Socket-Set `watched_parties`

Im `WSOpContext` (Spiegel zu `hosted_parties`): treibt nur die
Disconnect-Cleanup-Iteration (welche Channels muss dieser Socket beim Trennen
verlassen). Die Registry bleibt die Wahrheit für Ordnung/Promotion.

**Host-State bleibt unverändert in Redis** (`watch:channel-<id>`, `host_user_id`).
Promotion = `host_user_id` umschreiben via `write_state`. Die Registry sagt nur *wer*,
der Redis-State bleibt die übertragene Wahrheit für `ready`-Seed und REST.

## Protokoll

### Neue WS-Ops

Registriert in `ws_ops_handlers.py` (`@register_ws_op`), implementiert in `ws_watch.py`
(bzw. `promote_or_end` / Handoff ggf. in eigener Datei, s. Größen-Policy).

| Op | Payload | Wirkung |
|---|---|---|
| `watch_join` | `{channel_id}` | Socket tritt der Watcher-Registry bei. Prüft Channel-Membership (never-trust-client). Idempotent. `watch_start` ruft das intern mit auf → Host ist immer Watcher. |
| `watch_leave` | `{channel_id}` | Socket verlässt die Registry. War der User der Host **und** voll raus → Promotion. Idempotent. |
| `watch_handoff` | `{channel_id, target_user_id?}` | Host-only. Mit Target → gezielt promoten (Target muss in Registry sein). Ohne Target → nächster Ältester. Host bleibt danach als Viewer in der Registry. |

### Watcher-Liste-Broadcast (für den Picker + „X schauen zu"-Count)

Bei jeder Registry-Änderung, die das User-Set ändert (Join/Leave), broadcastet der
Manager `{op: "watch_watchers", channel_id, user_ids: [...]}` — **direkt per `_fan_out`,
view-channel-gefiltert, kein Redis** (konsistent zur in-process-Registry). Der
Join-Broadcast enthält die volle Liste → hydratisiert jeden Empfänger inkl. des gerade
Reconnecteten, ohne den `ready`-Frame anzufassen.

### Promotions-Kern

Funktion `promote_or_end(redis, manager, channel_id, departing_uid)`, **komplett unter
`manager._lock`** und mit **Re-Check von `host_user_id` nach Lock-Erwerb** (entschärft
das TOCTOU des read→write-Musters für den Handoff-Pfad):

1. `read_state`; ist `None` → fertig (keine Party).
2. `state.host_user_id != departing_uid` → wegfallender User war nur Viewer → keine
   Promotion, return.
3. `next = manager.next_host(channel_id, exclude=departing_uid)`.
4. `next is None` → `delete_state` (Party endet).
5. sonst → State umschreiben & übergeben:
   - `position = expectedPosition(state, now)` (frische Extrapolation)
   - `is_playing` unverändert
   - `host_user_id = next`
   - `updated_at = now`
   - → `write_state`

Der neue Host sieht via `watch:events` `isHost` flippen → sein Heartbeat-`$effect`
startet von selbst; sein Player ist als Ex-Viewer schon ~an der Position → **kein
sichtbarer Sprung**.

### Trigger-Mapping

- **Disconnect** → `cleanup_on_disconnect` iteriert `watched_parties`, ruft pro Channel
  die Leave-Logik + `promote_or_end`. **Behebt nebenbei den Reconnect-Zombie (#2):** die
  neue Connection re-joint beim Tile-Mount, ihr `watched_parties` wird neu befüllt →
  Cleanup feuert künftig wieder.
- **Channel verlassen** → Client-`resetChannel` unmountet den Tile → `watch_leave`.
  Kein Voice-Webhook-Hook nötig.
- **Kachel schließen** → Tile-`onDestroy` → `watch_leave`.
- **Explizit** → `watch_handoff`.

**Multi-Tab-Host (#3):** Da Host-Identität jetzt user-granular über die Registry läuft
und der State user-keyed ist, bleiben zwei Tabs desselben Users ein Host — kein
Self-Konflikt auf Registry-Ebene. (Beide Tabs senden weiter Heartbeats solange beide den
Tile offen haben — das ist ein eigener, kleinerer Punkt, **nicht** Teil dieses Designs.)

## Frontend

### `WatchPartyTile.svelte`

- **Mount → `gateway.sendWatchJoin(channelId)`**, `onDestroy → sendWatchLeave(channelId)`.
  Einzige Join/Leave-Quelle — deckt Kachel-schließen, Channel-wechsel und Unmount bei
  Party-Ende ab.
- **Neuer-Host-Toast:** `$effect` auf `party.host_user_id`; wird es zu mir und war's
  vorher nicht → Toast „Du steuerst jetzt die Watchparty". `prevHostId` als plain `let`,
  damit es beim Start-als-Host nicht fälschlich feuert.
- **Host-Controls → „Kontrolle abgeben"-Menü** (im `controlsExtra`-Snippet, host-only,
  neben Stop): Dropdown mit den aktuellen Watchern (aus neuem Store, minus ich) + Option
  „Automatisch (Nächster)". Auswahl → `gateway.sendWatchHandoff(channelId, targetUserId?)`.
  Leere Watcher-Liste → nur „Automatisch" (disabled) bzw. nur Stop.

### Neuer Store `lib/stores/watchWatchers.svelte.ts`

`byChannel: Record<channelId, string[]>`, gefüttert vom `watch_watchers`-Handler. `clear`
bei Party-Ende/Channel-Switch. Picker liest daraus, `userCache.queue` für die Namen.

### Weiteres

- `gateway-senders.ts`: `sendWatchJoin/Leave/Handoff`.
- `ws/handlers/watch.ts`: `watch_watchers`-Handler dazu.
- Paraglide: neue Messages (Toast, Button, Picker, „Automatisch", Fehlertext).

### Targeted Refactor (Größen-Policy)

`WatchPartyTile.svelte` ist mit 413 Z. schon über dem 250-Z.-Component-Cap. Join/Leave +
Toast + Picker verschlimmern das. Die Host/Viewer-Sync-Orchestrierung (die beiden
`$effect`s, Broadcast-Debounce, Heartbeat, DriftCorrector-Wiring) wird aus dem Tile in
einen Controller `lib/watch/partyController.svelte.ts` herausgezogen → das `.svelte`
wird wieder präsentational + Picker. „Verbessere den Code, in dem du arbeitest" —
kein Fremd-Refactor.

## Error-Handling & Edge-Cases

- **`watch_join`-Validierung:** prüft Channel-Membership (wie `handle_start`) bevor's in
  die Registry geht — kein Registry-Spam / kein Watcher-Listen-Leak durch Nicht-Member.
- **Promotion serialisiert:** `promote_or_end` läuft komplett unter `manager._lock` und
  re-liest `host_user_id` nach Lock-Erwerb. Da nur der Host eine Promotion auslöst
  (Schritt 2 gated auf `host_user_id == departing`), kann höchstens eine echte Promotion
  in-flight sein; Viewer-Leaves brechen bei Schritt 2 ab.
- **Verkettete Abgänge:** Wird der frisch promotete User im selben Moment auch getrennt,
  feuert dessen `watch_leave` → erneute Promotion → nächster oder Ende. Selbst-konsistent
  durch Neubewertung.
- **Promoteter Player noch nicht ready:** Heartbeat-`$effect` wartet auf `player`
  (bestehender Guard). Bis dahin tragen die Viewer per Extrapolation; Position wurde bei
  der Promotion frisch extrapoliert → aktuell. Kein Loch.
- **Gezielter Handoff, Target verschwindet zwischen Pick und Verarbeitung:** Server
  validiert Target gegen die Registry zum Verarbeitungszeitpunkt → weg = Error
  `4018 "target not watching"`, Host bleibt Host (UI kann Liste neu ziehen). Non-Host →
  `4015` (bestehender „only host"-Code).
- **Redis down während Promotion:** Guard wie im bestehenden Cleanup — loggen, Party
  vergammelt schlimmstenfalls zur 6h-TTL. Kein Crash.
- **Disconnect-Cleanup-Dedup:** Cleanup iteriert `watched_parties` (Superset — der Host
  ist via `watch_start` immer auch Watcher) und ruft pro Channel die Leave+Promotion-
  Logik. `hosted_parties` bleibt nur noch für `handle_stop`s Buchführung; keine
  Doppelverarbeitung.
- **Watcher-Liste = Teilnahme, nicht Presence:** Wer eine Party offen hat, erscheint in
  der Liste — analog zur Voice-Presence-Sichtbarkeit, keine Invisible-Maskierung. Der
  View-Channel-Filter gilt aber (wie `watch:events`).

## Testing

### Backend (pytest, erweitert `test_watch.py` + ggf. Manager-Test)

- Registry-Unit: `watch_join/leave` Refcount (Multi-Tab: User mit 2 Sockets, 1 schließen
  → bleibt; beide → raus), `joined_at` nicht zurückgesetzt bei Re-Join, `next_host`-
  Ordnung.
- Host-Disconnect mit 2 Watchern → `host_user_id` wechselt auf den ältesten anderen;
  Position frisch extrapoliert, `is_playing` erhalten.
- Host-Disconnect ohne weiteren Watcher → `delete_state`.
- Host-`watch_leave` (Kachel zu) → Promotion. Viewer-`watch_leave` → keine Promotion.
- Explizit: `watch_handoff` mit gültigem Target → Host wechselt gezielt;
  Nicht-Watcher-Target → `4018`; Non-Host → `4015`; ohne Target → nächster Ältester.
- **Reconnect-Zombie-Regression (#2):** Host trennt → reconnectet (neuer Socket) →
  `watch_join` → bleibt Host; erneutes Trennen räumt jetzt wieder auf.
- `watch_watchers`-Broadcast view-channel-gefiltert (Member ohne VIEW_CHANNEL bekommt
  ihn nicht).

### Frontend E2E (`watch-party.spec.ts`, WS-Ebene)

- Alice hostet, Bob öffnet Kachel (`watch_join`) → Alice trennt → REST `watch-state`
  zeigt `host_user_id == bob`.
- `watch_handoff` von Alice an Bob → Host wechselt; Picker zeigt jeweils den anderen.

### Bewusst außen vor

- Unit-Tests für die `sync.ts`-Drift-Engine (Pulse hat kein Vitest — bleibt manuell).
- Echter Mehr-Browser-Sicht-Test des Picker-UI = manuell.

### Manuelle Verifikation vor Merge

pytest + `pnpm check` + `pnpm build` + Playwright; plus ein 3-Personen-Handoff-Sichttest
(Host trennt mitten im Video, Kontrolle wandert sichtbar, Wiedergabe läuft ohne Sprung
weiter).

## Betroffene Dateien (Überblick)

**Backend:**
- `pubsub.py` — neue `_WatchRegistryMixin` (`_watchers`, `watch_join/leave`, `next_host`).
- `ws_watch.py` — neue Handler `handle_join/leave/handoff`, erweitertes
  `cleanup_on_disconnect`, `promote_or_end`-Helper (ggf. ausgelagert wg. Größen-Policy).
- `ws_ops_handlers.py` — `@register_ws_op` für `watch_join/leave/handoff`,
  `WSOpContext.watched_parties`.
- `ws_ops.py` (Dispatcher) — per-Connection `watched_parties`-Set + Cleanup-Aufruf.
- Watcher-Liste-Broadcast-Pfad (Manager `_fan_out` + view-channel-Filter).

**Frontend:**
- `web/src/lib/components/WatchPartyTile.svelte` — Join/Leave, Toast, Picker.
- `web/src/lib/watch/partyController.svelte.ts` — neuer Sync/Host-Controller (Refactor).
- `web/src/lib/stores/watchWatchers.svelte.ts` — neuer Store.
- `web/src/lib/ws/gateway-senders.ts` — `sendWatchJoin/Leave/Handoff`.
- `web/src/lib/ws/handlers/watch.ts` — `watch_watchers`-Handler.
- Paraglide-Messages.

## Nicht im Scope

- Shared-Control-Modell (jeder steuert) — verworfen zugunsten Single-Host + Auto-Promote.
- Doppel-Heartbeat bei Multi-Tab desselben Hosts (kleinerer, separater Punkt).
- Quick-Wins aus dem Review (#4 Heartbeat-Bound, #7 `sync.ts` Prod-Log, #8 HLS) —
  eigene, unabhängige Tasks.
- Cross-Pod-Watcher-Sichtbarkeit (Single-Pod-Annahme der ganzen Watch-Schiene).
</content>
</invoke>
