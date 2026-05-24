# Plugin-System — Roadmap

Pulse soll mittelfristig ein **modulares Plugin-System** bekommen: Features wie Tamagotchi, Custom-Themes, Bot-Hooks oder Mini-Spiele sollen einsteckbar sein, ohne dass der Core angefasst werden muss. Diese Datei trackt den Plan + Fortschritt.

Visuelle Erklärung (warum + wie): `docs/mockups/plugin-system.html` *(falls eingecheckt — sonst lokal vom letzten Plan-Session erstellt).*

## Wo wir gerade stehen

| Schritt | Status | Branch | Commit |
|---|---|---|---|
| 0a — `pubsub.py` splitten | ✅ fertig | `refactor/split-pubsub` | `56dd199` |
| 0b — `ws.py` splitten | ✅ fertig | `refactor/split-ws` | `b4542cd` |
| 1 — Event-Schema-Registry | ✅ fertig | `feat/event-schema-registry` | `9ac593d` |
| 2 — Op-Handler-Registry (Backend) | ✅ fertig | `feat/op-handler-registry` | `d93cbeb` |
| 2c — WS-Handler-Map (Frontend) | ✅ fertig | `feat/ws-handler-map-frontend` | `dd9abc1` |
| 3 — Settings-Section-Registry | ⏳ offen | — | — |
| 4 — Plugin-Manifest + Loader | ⏳ offen | — | — |
| 5 — Sandboxing (externe Plugins) | ⏳ offen | — | — |

Alle fertigen Branches sind gepusht, **keiner gemerged**. Sie bauen aufeinander auf (jeder neuere Branch mergt die vorherigen rein).

## Die Schritte im Detail

### Schritt 0 — Notfall-Aufräumen

**Warum:** `pubsub.py` (1314 Z.) und `ws.py` (995 Z.) waren durch das Friend-System (Mai 2026) weit über die Pulse-Größen-Policy (Hard-Cap 500) gewachsen. Solange das so ist, landet jedes neue Feature wieder im selben überfüllten Topf — egal wie modular es konzipiert ist. **Reine Code-Verschiebung, keine Verhaltens-Änderung.**

**0a — `pubsub.py` (1314 → 468 Z.)** in 5 Mixin-Module:
- `pubsub.py` (468) — `ConnectionManager` + Lifecycle + Voice/Stream-Reader
- `pubsub_channels.py` (56) — Channel-Keys + Konstanten
- `pubsub_listener.py` (399) — `_ListenerMixin` mit `_listen`
- `pubsub_friend_cache.py` (213) — `_FriendCacheMixin`
- `pubsub_perm_filter.py` (295) — `_PermFilterMixin`

**0b — `ws.py` (995 → 139 Z.)** in 3 Module:
- `routes/ws.py` (139) — Endpoint + Auth + Lifecycle
- `routes/ws_ready.py` (415) — `build_and_send_ready_frame()`
- `routes/ws_ops.py` (557 → später 153 nach Schritt 2)

### Schritt 1 — Event-Schema-Registry

**Warum:** Redis-Pub/Sub-Events waren bisher ad-hoc als `dict` definiert. Publisher (REST-Routes, voice-signaling, media-svc) bauten dicts, Subscribers (pubsub-Listener) parsten als `dict`. Channel-Namen wurden zwischen Services **per Hand** synchron gehalten (`mediamtx-auth-hook` ↔ `media-svc`). Bug-Risiko: Felder umbenennen → Drift.

**Was entstand:** `shared/dcc_shared/events/` als Package mit 8 Modulen + Pydantic v2 Models für 35 Op-discriminierte Events + 3 Snapshots. `EVENT_REGISTRY: dict[op → ModelClass]` als Single Source of Truth.

**Migriert:** 14 chat-gateway-Routes + voice-signaling + media-svc. Publisher sind type-safe; `manager.publish*` nimmt polymorphisch `dict | _EventBase` (backward-compatible).

**Offen (Phase 1b):** Listener-side Strict-Validation gegen `EVENT_REGISTRY` (bewusst verschoben — Schema-Drift wird zur Laufzeit noch nicht erkannt, aber Publisher sind type-safe).

### Schritt 2 — Op-Handler-Registry

**Warum:** Der WS-Op-Switch in `ws_ops.py` und der Pubsub-Channel-Switch in `pubsub_listener.py` waren monolithische `if/elif`-Ketten. Jeder neue Op-Code verlangte einen Switch-Case → kein Plugin-Einklink-Punkt.

**Was entstand:** Zwei Registries mit Decorator-API:
- `register_ws_op(op)` — WS-Client→Server-Ops (subscribe/send/voice/watch/activity)
- `register_channel_handler(channel)` — Redis-Channel-Listener (voice:events, guild:events, …)

**Resultat:** `ws_ops.py` 556 → 153 Z. (reiner Dispatcher). `pubsub_listener.py` 399 → 111 Z. (nur Polling-Loop + Fan-Out). Per-Domäne ein Handler-Modul (`ws_ops_handlers.py`, `ws_op_send.py`, `pubsub_channel_handlers.py`, `pubsub_channel_guild.py`).

**Plugin-API bereit:**
```python
@register_ws_op("tamagotchi:feed")
async def handle_feed(ctx: WSOpContext, msg: dict) -> None: ...

@register_channel_handler("tamagotchi:events")
async def handle_tama(manager, channel, msg) -> None: ...
```

### Phase 2c — WS-Handler-Map (Frontend)

**Warum:** Spiegelbildlich zum Backend. `web/src/lib/ws/connection.ts` hatte einen ~490-Zeilen-Switch mit 30+ Cases, der eingehende WS-Events an Stores dispatcht. Symmetrie zum Backend nötig damit Plugins beide Seiten anfassen können.

**Was entstand:** `connection.ts` 1108 → 350 Z. (Soft-Cap exakt erreicht). `lib/ws/handler-registry.ts` + 13 Handler-Module unter `lib/ws/handlers/` (chat, channels, guild, members, voice, presence, stream, watch, friends, ready, error, types, context).

**Plugin-API symmetrisch:**
```typescript
import { registerWsHandler } from '$lib/ws/handler-registry';
registerWsHandler('tamagotchi:state', (evt) => tamagotchiStore.apply(evt));
```

### Schritt 3 — Settings-Section-Registry

**Status:** ⏳ offen.

**Was es ist:** Plugins sollen eigene Bereiche in den Einstellungen anmelden können, statt dass `PersistedSettings` (web/src/lib/stores/settings.svelte.ts) eine statisch typisierte Union ist. Heute kann man kein neues Settings-Feld hinzufügen, ohne den Type zu mutieren.

**Was es ändern würde:**
- `SettingsRegistry`-API auf Frontend mit `registerSettingsSection(name, defaults, schema)`.
- Persistierung über `dcc.settings`-localStorage bleibt, aber per-section gekapselt.
- Lifecycle-Hooks (`onLogout`, `onReset`) für Plugin-Cleanup.
- Optional: Backend-seitig analoge `UserPreference`-Persistierung für Plugins die Server-Persistenz brauchen.

### Schritt 4 — Plugin-Manifest + Loader

**Status:** ⏳ offen.

**Was es ist:** Der "Steckbrief" eines Plugins (`plugin.toml`): name, version, author, gewünschte Schnittstellen (events, ws_ops, channels, settings, ui_slots, permissions), Scope (per-user / per-server / global). Plus ein Lade-Mechanismus, der beim App-Start die Manifests scannt und die Plugins registriert.

**Was es ermöglicht:**
- Plugins werden zu echten, eigenständigen Paketen.
- Aktivieren/Deaktivieren ohne Pulse-Neustart.
- Anzeige im UI: welche Plugins installiert + was sie berühren (siehe `docs/mockups/plugin-system.html` Sektion 7).

### Schritt 5 — Sandboxing

**Status:** ⏳ offen (nur nötig wenn externe Plugins zugelassen werden).

**Was es ist:** Damit Plugins von fremden Entwicklern Pulse nicht crashen oder ausspähen können. Optionen: WASM-Sandbox, separate Prozesse via stdio-JSON-RPC (analog zum bestehenden GSR-Sidecar-Pattern), oder Bot-API über HTTP (= komplett externe Server).

**Was es kostet:** Eigene Infrastruktur. Plugin-Store + Review-Prozess. Sicherheits-Audits.

**Wann nötig:** Erst wenn ein **echtes Ökosystem** entstehen soll. Für interne/vertraute Plugins (Schritt 1–4) nicht erforderlich.

## Konventionen

Jeder Refactor- oder Schritt-Branch folgt:

- **Verhaltens-neutral.** Wire-Format / öffentliche API bleibt identisch (Frontend muss ohne Änderung weiterlaufen).
- **Eigener Branch**, gepusht, **kein** direkter Merge auf `main` ohne Review.
- **Pulse-Tests-Befehl**: `POSTGRES_PORT=5433 REDIS_URL=redis://localhost:6379/0 uv run --all-packages pytest -q`. Frontend: `cd web && pnpm check && pnpm build`.
- **Code-Größen-Policy**: Source-Files ≤ 350 Z. (hart 500), Svelte-Components ≤ 250.
- **Pulse-Stil Commit-Message** mit `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>` Trailer.

## Merge-Reihenfolge

Wenn alles fertig ist:

1. `refactor/split-pubsub` (steht für sich alleine — gegen `main`)
2. `refactor/split-ws` (steht für sich alleine — gegen `main`)
3. `feat/event-schema-registry` (hat 0a + 0b reingemerged)
4. `feat/op-handler-registry` (hat 0a + 0b + 1 reingemerged)
5. `feat/ws-handler-map-frontend` (hat 0a + 0b + 1 + 2 reingemerged)
6. dann Schritte 3 / 4 / 5 sequenziell

Jeder Branch ist als eigener PR reviewbar; die Inkremente sind klein gehalten. Squash-Merge oder Merge-Commit — beides funktioniert, weil die Branches aufeinander aufbauen.

## Visuelle Plan-Erklärung

`docs/mockups/plugin-system.html` (~1500 Zeilen Single-File HTML im Pulse "Glasshouse / Graphite"-Stil) erklärt das Plugin-System für Nicht-Programmierer mit Lego-Metaphern, Steckdosen-Analogie, Tamagotchi-als-Beispiel-Mockup und Konflikt-Auflösungs-Konzept. Aktuell im Working-Tree von vorherigen Plan-Sessions, **noch nicht eingecheckt**. Falls eingecheckt: hier referenzieren.
