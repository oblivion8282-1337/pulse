# Plan: Mehrere HQ-Streams pro User gleichzeitig (z.B. zwei Monitore separat)

**Status:** Idee / vertagt — „machen wir vielleicht irgendwann mal" (2026-06-23).
Kein Code geschrieben. Dieser Plan ist die Recherche + der Implementierungs-Schnitt für später.

> **Nachtrag 2026-06-29:** Befund + alle Datei-Referenzen gegen den aktuellen Code
> re-verifiziert (stimmen, ±1 Zeile). Auf User-Wunsch um den **Per-Plattform-Schnitt
> für alle drei Plattformen (Linux / Windows / macOS)** ergänzt — siehe Abschnitt ganz
> unten („## Nachtrag 2026-06-29 …"). Der ursprüngliche MVP-Schnitt war Linux-only;
> der Nachtrag arbeitet Windows + macOS konkret aus.

## Frage

Kann ein einzelner User zwei (allgemein N) HQ-Screen-Streams gleichzeitig fahren —
z.B. zwei Monitore separat streamen, jeder als eigenes wählbares Viewer-Tile?

## Befund: heute **nein**

Die ganze HQ-Stream-Identität ist auf `(channel_id, user_id)` verdrahtet, **nicht**
auf eine Stream-/Slot-Dimension. Vier Kollisionspunkte für einen zweiten Stream
desselben Users:

1. **Active-Key** `stream:active:channel-<cid>-<uid>` (`services/media-svc/src/dcc_media_svc/streamkeys.py:38`) — pro (cid,uid) genau einer. Zweiter Stream überschreibt den ersten.
2. **WHEP-Lookup** `GET /channels/{cid}/whep?user_id=<uid>` (`services/media-svc/src/dcc_media_svc/routes.py:236`) liest genau diesen Key → kann nur EINEN Pfad auflösen.
3. **Channel-State** `stream:channel:<cid>` → `{user_ids: [...]}` (`streamkeys.py:35`, Poller `poller.py`) — Menge von User-IDs, kein Stream-Deskriptor. UI rendert ein Tile pro User.
4. **Sidecar** = `SidecarManager`-Singleton, EIN GSR/Rust-Prozess, respawn-on-stop (`desktop/electron/sidecar.ts:306`).

Der MediaMTX-Pfad ist `channel-<cid>-<uid>-<nonce>`. Der `nonce` (32 hex, pro
Token-Issue frisch) ist **nicht** die Slot-Dimension — er löst nur den
ICE-Republish-Race (MediaMTX 1.17.1) und wechselt bei jedem Reconnect, taugt also
nicht als stabile Stream-ID.

## Kernidee: ein stabiler `slot`-Integer (0, 1, …) durch alle 4 Schichten

Vom Renderer vergeben, in den MediaMTX-Pfad eingebettet, und überall wo heute
`user_id` die Stream-Identität trägt durch `(user_id, slot)` ersetzt.

**Pfad neu:** `channel-<cid>-<uid>-s<slot>-<nonce>`.
Das `s`-Präfix ist nötig, sonst wird `channel-1-2-3-<nonce>` mehrdeutig
(zweiter uid-Teil oder Slot?).

## Schicht 1 — MediaMTX-Pfad + Key-Schema (Fundament)

**Pfad-Format** — `streamkeys.py:28` + `mediamtx-auth-hook/.../shared.py:21` (DUPLIZIERT, synchron halten):
- Regex `^channel-(\d+)-(\d+)-([0-9a-f]{32})$` → `^channel-(\d+)-(\d+)-s(\d+)-([0-9a-f]{32})$`
- `parse_channel_user_path` → gibt `(cid, uid, slot, nonce)` zurück.
- `path_for_channel_user(...)` bekommt `slot`-Parameter.

**Active-Key** (`streamkeys.py:38` + `shared.py:28`):
- `stream:active:channel-{cid}-{uid}` → `stream:active:channel-{cid}-{uid}-s{slot}`.
- `STOPPING_KEY` (`streamkeys.py:45`) analog `-s{slot}`.

**Channel-State** (`streamkeys.py:35`) — **additiv, nicht ersetzen**:
- Heute `{user_ids: [str], since}`. Konsumiert von `get_stream_state` (`routes.py:216`),
  chat-gateway re-broadcast (`StreamStateSnapshot`, `dcc_shared/events.py`), Frontend
  `streamDiff.ts` / `pruneChannel` / Tile-Rendering.
- Neu `{user_ids: [str], streams: [{user_id, slot}], since}`. `user_ids` bleibt als
  deduplizierte Projektion → alle Alt-Consumer + alte Clients funktionieren weiter
  (graceful degradation, ein Tile pro User). Neues `streams` trägt die Slot-Info.
- `StreamStateSnapshot` bekommt `streams: list[StreamDescriptor] = []` (Default leer → WS-Frame rückwärtskompatibel).
- Poller: `out: dict[str, set[str]]` (`poller.py:77`) → `dict[str, set[tuple[str,int]]]`; Reconcile-Pipeline (`poller.py:248-291`) iteriert über `(uid, slot)`.

**Aufwand: M.**

## Schicht 2 — Token-Issue + WHEP-Lookup (media-svc + auth-hook)

**Token-Issue** `issue_stream_token` (`routes.py:171`):
- `StreamTokenIn` (`routes.py:118`) bekommt `slot: int = 0` (`Field(ge=0, le=1)` für MVP N=2).
- `path_for_channel_user(cid, uid, slot, nonce)` (`routes.py:188`), Token-Record (`:189`) bekommt `"slot"`.
- `STOPPING_KEY.delete` (`:205`) um slot erweitern.

**WHEP-Lookup** `get_whep_url` (`routes.py:236`):
- Query `slot: int = 0`. `ACTIVE_KEY.format(..., slot=slot)` (`:257`).
- Read-Cache-Key (`:285`) um slot erweitern — sonst teilen zwei Slots ein Read-Token → falscher Pfad.
- `get_stream_state` (`:216`) gibt `streams` zusätzlich zurück.

**Auth-Hook** `_handle` (`mediamtx-auth-hook/.../routes.py:195`):
- `parse_channel_user_path` → `(cid, uid, slot, nonce)`; Unpacking `:198`, `:242` anpassen.
- Publish-Validierung (`:221`): `str(rec.get("slot")) != path_slot` → deny `publish_slot_mismatch`.
- `_consume_token_and_mark_active` (`:157`) bekommt `slot`, schreibt Active-Key mit Slot.
- Read-Validierung (`:257`) prüft Slot analog.

**Sicherheit:** Token bindet jetzt an `(cid, uid, slot, nonce)`. Slot-Mismatch MUSS denyen.
**Aufwand: M.**

## Schicht 3 — chat-gateway Proxy (durchreichen)

`routes/streaming.py`:
- `StreamTokenIn` (`:48`) + `slot: int = 0`, in `json_body` durchreichen.
- `get_whep_url`: `slot`-Query annehmen + weiterreichen.
- `stop_stream` (DELETE): braucht `slot`. media-svc DELETE-Route (`routes.py:323`) löscht heute
  `ACTIVE_KEY` ohne Slot. Minimal: Slot-Query, Default = alle Slots des Users löschen.
- Membership-/Permission-Checks (`streaming.py:108-120`) unverändert (pro Channel, nicht pro Slot). Keine DB/Migration.

**Aufwand: S.**

## Schicht 4 — Sidecar-Singleton + Renderer-UI (der teure Teil)

**Sidecar — der faule Trick:** Den `SidecarManager`-Singleton **nicht** intern auf
Multi-Child umbauen (pending/shutdown/respawn-Logik wäre riskant). Stattdessen
`getSidecar(slot = 0)` → **`Map<slot, SidecarManager>`** (`sidecar.ts:598`): jeder
Slot ein eigener, unveränderter, getesteter Prozess. Null Änderung an der teuren
Lifecycle-Logik.
- `main.ts`: `gsr:call` bekommt `slot`-Param (Default 0), wählt die Manager-Instanz. Allowlist-Validierung identisch.
- Event-Relay: `onEvent` pro Manager; beim Relay zum Renderer `slot` in den `gsr:event`-Payload schreiben.
- Drei Dateien synchron halten: `main.ts` / `preload.ts` / `web/src/lib/platform/pulse.d.ts`.

**Echte Kosten (nicht die Map):**
- `web/src/lib/stream/state.svelte.ts` ist heute EIN `stream`-`$state`-Objekt (`:16`) →
  muss slot-fähig werden (`streams[slot]` o.ä.). `applyEvent` (`:106`) routet per `ev.slot`,
  `notifyBackendStopped` (`:49`) schickt Slot mit. **(M)**
- `StreamControls.svelte` (`:102-124`): Slot wählen + zweiter Start-Button/UI. **(M)**

**Capture-Quelle pro Slot:** Linux = pro `start` ein eigener Portal-Dialog (User wählt
Quelle), Windows = `Monitor: 1` vs `Monitor: 2` (`GsrStartArgs.capture`, `gsr.ts:126`).
Kein Sidecar-Code nötig — nur zwei `start`-Calls mit unterschiedlichem Token/Slot/Pfad.

**Frontend-Tiles (Viewer-Seite):**
- `hqStreamManager.svelte.ts`: `keyOf` (`:278`) `${channelId}:${userId}` → `…:${slot}`. `ManagedHqStream` (`:37`) + `slot`-Feld, `#start` (`:205`) ruft `getWhepUrl(channelId, userId, slot)`.
- `openedTiles.svelte.ts`: hq-Tile-`id = userId` (`:11`) → `${userId}:${slot}`. `pruneChannel` (`:119`) gegen die `streams`-Liste.
- `StreamGrid.svelte` + Presence-Store: `streams`-Deskriptorliste konsumieren statt `user_ids`; Fallback auf `user_ids` mit slot=0 wenn `streams` leer (alter Server).

**Aufwand: L** (Map selbst ist S; teuer sind state.svelte.ts + UI + 3-Datei-Sync).

## Tests — was bricht

- `services/mediamtx-auth-hook/tests/test_auth_hook.py` — Pfade ohne `-s<slot>` matchen die neue Regex nicht → brechen. Strengste Suite (Auth-Pfad). Slot-Mismatch-Deny ergänzen.
- `services/media-svc/tests/test_routes.py` — Token/WHEP prüfen `mediamtx_path` + Active-Key → brechen. Zwei-Slot-Fall ergänzen.
- `services/media-svc/tests/test_poller.py` — baut `channel-<cid>-<uid>`-Pfade → bricht. Neues Format + `streams`-Assertion.
- `web/tests/e2e/` — kein HQ-Stream-Spec; echtes HQ-E2E ist laut CLAUDE.md eh manuell. Kein Bruch.

## Migrations-/Kompatibilitätsfallen

1. **Live-Streams beim Deploy:** Alte Pfade ohne `-s` matchen die neue Regex nicht → Presence-Flap.
   **Mitigation (wichtigste):** Regex so bauen, dass `-s<slot>` **optional** ist (Default slot=0) → beide Formate tolerieren während der Übergangszeit. Deckt auch den Rolling-Deploy zwischen den zwei getrennt deploybaren Services (media-svc ↔ auth-hook) ab.
2. **Key-Modul-Duplikation** (`streamkeys.py` ↔ `shared.py`): old-format-Toleranz deckt das mit ab.
3. **`user_ids` additiv lassen** → alte Frontends + `streamDiff.ts` + WS-Frame heil.
4. **Nonce unangetastet** — ICE-Race-Schutz pro Pfad bleibt; zwei Slots sind ohnehin disjunkte Pfade.
5. **WHEP-`?token=`-Minting** funktional identisch, nur Cache-Key + Active-Lookup um Slot.

## Reihenfolge + Risiko-Hotspots

1. Schicht 1 (Key/Pfad, old-format-tolerante Regex, beide Module synchron).
2. Schicht 2 (media-svc + auth-hook) + Tests grün.
3. Schicht 3 (chat-gateway, durchreichen).
4. Backend Ende-zu-Ende mit zwei manuellen Token-Issues testen (kein echter GSR, nur Pfad/Key).
5. Schicht 4 (Sidecar-Map + state.svelte.ts + UI) zuletzt.

**Hotspots:** (a) old-format-Regex-Toleranz beim Deploy, (b) Auth-Hook-Slot-Check (Sicherheit), (c) `state.svelte.ts` Single→Slot, (d) Electron-3-Datei-Sync.

## MVP-Schnitt

**N=2, Linux-only zuerst.** Auf Linux bleibt der GSR-Prozess warm (kein respawn-on-stop
wie Windows) → Sidecar-Map am saubersten. `streams`-Feld additiv, old-format-Regex-Toleranz.
Windows (respawn-Bug) + macOS (Sidecar fehlt noch) = Phase 2.

**Grobschätzung:** Backend (Schicht 1–3) ~ein Tag, rein testbar ohne echten Stream.
Schicht 4 ~das Doppelte.

## Faule Alternative (falls „beide Screens sehen" reicht statt „separat wählbar")

GSR/Portal kann **eine** Capture-Region über beide Monitore spannen → ein einziger
Stream, der beide Screens nebeneinander zeigt. Null Architektur-Änderung (nur
Quellen-Auswahl im Portal-Dialog). Nachteil: geteilte Bitrate/Auflösung, Viewer kann
die Screens nicht einzeln an-/abwählen.

## Verwandt

- Memory `watchparty-multi-per-channel-plan` (ähnliches „mehrere parallele X pro Channel", vertagt).
- `streaming/README.md` (Sidecar-Datenfluss), CLAUDE.md §HQ-Streaming.

---

## Nachtrag 2026-06-29 — alle drei Plattformen ausgearbeitet

Der Plan oben ist korrekt und **aktuell** (am 2026-06-29 gegen den Code re-verifiziert).
Was oben fehlte: der ursprüngliche MVP war „Linux zuerst, Windows/macOS = Phase 2"
ohne Details. Hier der konkrete Schnitt **pro Plattform**, plus die Capture- und
Encode-Realität, die ich heute verifiziert habe.

### Re-Verifikation (Stand 2026-06-29, Zeilen ±1 zur 2026-06-23-Fassung)

- Active-Key pro `(cid,uid)` einer: `streamkeys.py` `ACTIVE_KEY` + `shared.py` (dupliziert). **bestätigt.**
- WHEP-Lookup `get_whep_url` `routes.py:237`, liest `ACTIVE_KEY.format(...)` `:257`. **bestätigt.**
- Token-Issue `issue_stream_token` `routes.py:172`; `StreamTokenIn` `:118`. **bestätigt.**
- `stop_stream` `routes.py:324`, löscht Active-Key ohne Slot `:355`. **bestätigt.**
- Sidecar-Singleton `getSidecar()` `sidecar.ts:598`, `let instance` `:594`. **bestätigt.**
- Frontend-Identität pro User: `hqStreamManager.svelte.ts` `keyOf = ${channelId}:${userId}` `:278`,
  `getWhepUrl(channelId, userId)` `:205`; Anker `hqStreamBackground.svelte.ts` `${channelId}::${userId}` `:26`. **bestätigt.**

Fazit: **kein prinzipieller Blocker auf irgendeiner Plattform.** Die Capture-APIs
können alle zwei parallele Sessions; die Arbeit ist überall die Umstellung von
Personen-Identität (`user_id`) auf Stream-Identität (`(user_id, slot)`) — die vier
Schichten oben. Der Per-Plattform-Unterschied steckt **nur** in Schicht 4
(Sidecar + Capture-Quelle).

### Capture-Realität pro Plattform (heute verifiziert)

Zwei parallele Capture-Sessions sind nativ auf allen drei Plattformen möglich:

- **Linux (GSR):** ein GSR-Prozess pro Quelle. `gpu-screen-recorder --info` listet
  die Monitore direkt — auf dieser Maschine (Wayland + NVIDIA, GSR 5.13.6):
  `capture_options = HDMI-A-1 | DP-1 | region | portal`. `-w DP-1` capturet diesen
  Monitor direkt. Diese Liste fließt **bereits** im `health`-Op als
  `gsr.capture_options` zum Frontend (wird nur nicht genutzt). Zwei Slots = zwei
  GSR-Prozesse mit unterschiedlichem `-w`.
- **Windows (WGC):** ein `GraphicsCaptureItem` pro `HMONITOR`. Zwei Monitore = zwei
  Capture-Sessions (zwei Prozesse). Der Sidecar **kann das schon**: `list_monitors`
  +  `capture: "Monitor: <index>"` → `Monitor::from_index` (`capture/source.rs:45`).
- **macOS (ScreenCaptureKit):** Apple erlaubt **ausdrücklich** mehrere SCStream-
  Sessions gleichzeitig, solange jede ein anderes Display nimmt. Sidecar kann das
  schon: `list_monitors` (`SCShareableContent.displays`) + `capture: "display:<n>"`
  /`"Monitor: <n>"` (`ops/start.rs:37,116`).

**Was KEINE Plattform nativ kann:** zwei Monitore in *einer* Capture-Session als zwei
getrennte Spuren. „Zwei separate Streams" = immer zwei Sessions. (Das ist genau der
Sinn der Slot-Dimension.)

### Schicht 4 pro Plattform — der einzige plattform-divergente Teil

Gemeinsame Grundlage (plattform-unabhängig, einmal bauen): `getSidecar(slot)` →
`Map<slot, SidecarManager>` (`sidecar.ts:598`); `gsr:call`/`gsr:event` tragen `slot`
(`main.ts` ↔ `preload.ts` ↔ `pulse.d.ts` synchron); `state.svelte.ts` Single→Slot;
`StreamControls.svelte` Slot-/Quelle-Auswahl; Viewer-Tiles slot-keyed (siehe Schicht-4-
Block oben). Darüber liegt **pro Plattform** nur die Capture-Quellen-Wahl + eine
Lifecycle-Eigenheit:

**Linux — am saubersten, aber Quellen-Wahl-UX klären.**
- Prozess bleibt **warm** (kein respawn-on-stop, nur `win32` respawnt — `sidecar.ts:399`).
  Die Sidecar-Map ist hier am risikoärmsten.
- Quellen-Wahl heute: pro `start` ein eigener **Portal-Dialog** → User müsste für
  Slot 0 Monitor A, für Slot 1 Monitor B picken (zwei Dialoge). Funktioniert, ist
  aber klobig.
- **Besser (optional):** Named-Monitor-Capture nutzen — `capture` = `"DP-1"` direkt
  aus `gsr.capture_options` (kein Dialog). Erfordert (a) den Linux-Monitor-Picker
  (separates kleines Stück, s.u.) und (b) **Verifikation, ob direkte KMS-Monitor-
  Capture in der ausgelieferten Flatpak-Sandbox erlaubt ist** — im Eigenbau läuft
  sie, in Flatpak evtl. Portal-Pflicht. Das ist der einzige offene Risiko-Check für
  Linux. Fällt KMS im Flatpak weg → Fallback auf zwei Portal-Dialoge.

**Windows — Capture frei, Lifecycle teuer.**
- Capture-seitig **null Sidecar-Arbeit**: `MonitorPicker` produziert schon
  `"Monitor: 1"` / `"Monitor: 2"`; zwei Slots = zwei `start`-Calls mit verschiedenen
  Monitor-Tokens.
- Eigenheit: der Windows-Sidecar **self-exitet nach `stop`** (WGC-Threadpool-Timer-AV)
  und wird respawnt (`sidecar.ts:399`, nur `win32`). Pro-Slot-Map ist trotzdem ok —
  jeder Slot ist ein eigener `SidecarManager`, respawnt unabhängig. Aber: zwei
  gleichzeitige WGC+NVENC-Pipelines im selben Prozess-Baum zwei-Prozess testen
  (Adapter-/Encoder-Kontext ist pro Prozess isoliert → sollte sauber sein).
- NVENC-Session-Limit: ältere GeForce-Treiber capten gleichzeitige Encode-Sessions
  (früher 2–3; ab Treiber 2023+ aufgehoben). Zwei ist überall ok.

**macOS — Capture frei, reitet aber auf dem Mac-Client-Gate.**
- Capture-seitig **null Sidecar-Arbeit**: `list_monitors` + `display:<n>` sind im
  Sidecar fertig; Prozess bleibt **warm** (kein respawn) → Map sauber wie Linux.
- **Aber:** der macOS-Client als Ganzes ist noch nicht auslieferbar (FFmpeg-LGPL-
  Bündelung, Signing/Notarisierung, TCC-Permission-UX, Live-RTMPS-Verifikation —
  s. `docs/plans/2026-06-15-macos-client.md`). Multi-Stream auf macOS bringt **kein**
  eigenes Capture-Problem mit, aber es kann erst „an" gehen, wenn der Mac-Client
  überhaupt steht. Multi-Stream ist hier ein Frontend-/Slot-Thema, kein Mac-Thema.

### Empfohlene Phasen (für „alle drei Plattformen")

1. **Backend (Schicht 1–3), plattform-unabhängig.** Slot durch Key/Pfad/Token/WHEP,
   old-format-tolerante Regex. Rein gegen zwei manuelle Token-Issues testbar, kein
   echter Stream, keine Plattform. ~ein Tag. (Unverändert zum Plan oben.)
2. **Frontend-Slot-Fundament + Sidecar-Map**, plattform-unabhängig: `state.svelte.ts`,
   `hqStreamManager`, Tiles, `getSidecar(slot)`, 3-Datei-Electron-Sync. Der teure Teil (L).
3. **Linux scharf schalten** (warm, am saubersten). Quellen-Wahl: erst zwei Portal-
   Dialoge (null Risiko), dann optional Named-Monitor + Flatpak-KMS-Check.
4. **Windows scharf schalten**: nur Slot-Token + Zwei-Prozess-Test (Capture ist fertig).
5. **macOS** zieht automatisch mit, sobald der Mac-Client (separater Plan) steht —
   nur Verifikation, kein Extra-Capture-Code.

So ist „alle drei Plattformen" erreicht, ohne dass Windows/macOS eigene Capture-
Entwicklung brauchen — die Plattform-Arbeit steckt fast komplett im gemeinsamen
Slot-Fundament (Schritte 1–2), nicht in den Sidecars.

### Optionales Vorab-Stück (nützlich unabhängig von Multi-Stream)

Der **Linux-Einzelmonitor-Picker** (heute zwingt das Frontend `capture_source='portal'`,
obwohl `gsr.capture_options` die Monitore schon liefert) ist ein kleines, separates
Frontend-Stück. Es ist Voraussetzung für die schöne Named-Monitor-Variante in
Schritt 3 und bringt schon für sich Wert (Monitor in-App wählen statt Portal-Dialog).
Kann vor oder unabhängig vom Multi-Stream-Feature gebaut werden.
