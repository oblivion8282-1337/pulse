# Plan: Mehrere HQ-Streams pro User gleichzeitig (z.B. zwei Monitore separat)

**Status:** Idee / vertagt — „machen wir vielleicht irgendwann mal" (2026-06-23).
Kein Code geschrieben. Dieser Plan ist die Recherche + der Implementierungs-Schnitt für später.

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
