# Pulse Plugin-System — Roadmap

Stand: 2026-05-24 (Schritt 7 fertig)

Manifest-Spezifikation: [`PLUGIN_MANIFEST.md`](./PLUGIN_MANIFEST.md).

Ziel: ein opt-in Plugin-System für Pulse, das Drittentwickler nutzen können,
ohne den Core-Source zu forken. Symmetrisches Design Backend/Frontend; jeder
"Plugin-Punkt" ist eine Runtime-Registry, in die ein Plugin-Modul beim Import
seinen Handler/Section/Schema einklinkt.

## Schritte

### Schritt 1 — Event-Schema-Registry (Backend, shared) — fertig (9ac593d)

Branch: `feat/event-schema-registry`, merged auf `main`.
Backend-Pendant: `shared/dcc_shared/events.py` exportiert eine Registry für
`{op, schema, version}`-Tupel; alle WS-Op-Payloads werden über sie validiert.
Plugins können neue Ops registrieren, ohne `events.py` zu patchen.

### Schritt 1b — Listener-side strict validation — fertig

Branch: `feat/listener-strict-validation`.

Schritt 1 hat den **Publisher-Pfad** auf die Registry migriert; jeder REST-
Route- / voice-signaling- / media-svc-Publisher baut sein Event jetzt als
Pydantic-Modell. Diese Etappe schließt den **Subscriber-Pfad**: jedes
eingehende Redis-Pub/Sub-Event wird im chat-gateway-Listener gegen
`EVENT_REGISTRY` validiert, bevor es an die lokalen Sockets fan-outed wird.

Was sich geändert hat:

- `services/chat-gateway/src/dcc_chat_gateway/pubsub_event_validation.py`
  (~110 Z., neu): `validate_event(op, payload) → (is_valid, error_msg)` +
  `maybe_drop(op, payload, channel) → bool`. Mode-resolver liest
  `PULSE_EVENT_VALIDATION` (env, default `strict`).
- `pubsub_channel_handlers.py` + `pubsub_channel_guild.py`: jeder
  op-discriminated Branch ruft jetzt `maybe_drop()` vor dem eigentlichen
  Processing. Bare-Snapshot-Pfade (`voice:events` ohne `op`, `stream:events`,
  `watch:events`) bleiben unangetastet — die Snapshots sind nicht im
  `EVENT_REGISTRY` (sie tragen keinen Discriminator) und werden vom Listener
  selbst auf der Outbound-Seite mit `op` versehen.
- Tests: `services/chat-gateway/tests/test_event_validation.py` (23 Tests),
  482 chat-gateway-Tests grün (459 vorher + 23 neu).

Validation-Modes (`PULSE_EVENT_VALIDATION`):

- `strict` (Default) — invalid event → drop + ERROR log. Production-Default.
- `warn` — invalid event → WARNING log, aber weiterverarbeitet. Sanfte
  Migration: Schema-Drift sichtbar machen ohne sofort zu droppen.
- `off` — kein Validation-Overhead. Für Setups, wo der Listener vor dem
  Publisher upgegradet wird und ein paar Sekunden Drift unkritisch sind.
- Unknown / unset → fällt auf `strict` zurück.

Sonder-Behandlung:

- **Plugin-Ops** (Op-Code enthält `:`, z.B. `tamagotchi:ack`) bypassen die
  Validation. Plugins registrieren ihre eigenen Ops; die Core-Registry
  weiß nichts davon, und ohne diesen Bypass würde Phase 1b den ganzen
  Plugin-Pfad blockieren.
- **Unknown Core-Ops** (Op-Code ist nicht namespaced, aber nicht im
  Registry): werden mit einer WARNING durchgelassen. Schützt vor
  Block-by-Skew, wenn ein neuer Op-Publisher schon deployt ist, der
  Listener aber noch alt. Echtes Drift-Symptom als Log raus.
- **Bare Snapshots** (kein `op`-Feld): Caller (Channel-Handler) ruft
  `maybe_drop` für solche Payloads gar nicht erst auf — die
  `VoiceStateSnapshot` / `StreamStateSnapshot` / `WatchStateSnapshot`-
  Form ist Registry-frei by design.

### Schritt 2 — Backend Op- + Channel-Handler-Registries — fertig (d93cbeb)

Branch: `feat/ws-handler-registry-backend`, merged.
`services/chat-gateway/src/dcc_chat_gateway/routes/ws_ops_registry.py`
exportiert `@register_ws_op('foo:bar')`-Decorator. Der Op-Dispatch in
`ws_ops.py` schlägt jeden inbound Op über die Map nach. Channel-Subscription-
Logik (`pubsub`-Mixin) ebenso registry-basiert.

### Schritt 2c — Frontend WS-Handler-Registry — fertig (dd9abc1)

Branch: `feat/ws-handler-map-frontend`, merged.
`web/src/lib/ws/handler-registry.ts` mit `registerWsHandler(op, fn)`.
`connection.ts` schrumpfte von 1108 auf 350 Z. — der 490-Z.-Switch wurde
durch Domänen-Module ersetzt (`web/src/lib/ws/handlers/*.ts`), die jeweils
`register(ctx)` aufrufen. Plugins schreiben:

```typescript
import { registerWsHandler } from '$lib/ws/handler-registry';
registerWsHandler('tamagotchi:state', (evt) => store.apply(evt));
```

### Schritt 3 — Settings-Section-Registry (Frontend) — fertig

Branch: `feat/settings-section-registry`.

Was sich geändert hat:

- `web/src/lib/settings-registry/` ist neu:
  - `registry.svelte.ts` (267 Z.): `registerSettingsSection`, `getSection`,
    `listSections`, `runSignOutHooks`, `bindPersistence`. Pro Section ein
    Svelte-5-Rune-`$state` + Lifecycle (`onSignOut`-Policy).
  - `types.ts`: `SectionConfig<T>`, `SectionStore<T>`, `SignOutPolicy<T>`.
  - `sections/{appearance,audio,voice,screenShare,streamChat,notifications,
    sounds,shortcuts}.ts`: pro Built-in-Section ein Modul mit defaults +
    parser + onSignOut-Config. Alle ≤ 101 Z.
- `web/src/lib/stores/settings.svelte.ts` ist von **656 → 343 Z.**
  geschrumpft. Public-API (`settings.audio.bitrate`, `settings.setTheme(…)`,
  …) unverändert — die Getter delegieren an die Registry-Section-Stores.
- `auth.svelte.ts` ruft weiter `settings.resetUserScoped()` — der Aufruf
  delegiert jetzt an `runSignOutHooks()`, das jede Section nach ihrer
  `onSignOut`-Policy behandelt. Nur `notifications.browserPushEnabled`
  wird reset (Policy `{ browserPushEnabled: false }`), Rest ist
  device-scoped (Policy `'keep'`).
- `localStorage`-Format bleibt `dcc.settings` JSON-Blob; Pro-Section-Slot
  + neues optionales `_meta`-Object für Section-Versionen.
- Legacy-`dcc.screenShareSettings` wird einmalig in den neuen Blob gefaltet
  (Pre-Registration-Hook in `stores/settings.svelte.ts`).

Plugin-Usage:

```typescript
import { registerSettingsSection } from '$lib/settings-registry';

const tama = registerSettingsSection('tamagotchi', {
  defaults: { petName: 'Pipsi', hunger: 0, lastFedAt: 0 },
  onSignOut: 'reset', // 'keep' | 'reset' | (state) => state | Partial<T>
  version: 1
});

// Reactive read — `tama.value.petName` re-runs the $effect on change.
$effect(() => console.log(tama.value.petName));
tama.set('petName', 'Hugo');
tama.patch({ hunger: 0, lastFedAt: Date.now() });
```

Was noch offen ist:

- **Schritt 3b — Backend-Pendant (server-side `user_preferences`):** für
  Plugins, deren Section-State **zwischen Devices syncen** soll, braucht's
  eine `user_preferences`-Tabelle in auth-svc oder chat-gateway. Bewusst
  geskippt; Plan: eigene Tabelle `user_preferences(user_id, namespace,
  payload jsonb, version, updated_at)` mit `GET/PATCH /me/preferences/<ns>`
  + WS-Push (`user_preferences_updated`) für Cross-Device-Sync. Für jetzt
  bleibt jede Section device-local in `localStorage`.
- **valibot-Schemas:** `SectionConfig` hat schon einen optionalen `parse`-
  Hook, aber kein dediziertes `schema: Schema<T>`. Den Pulse-Stack-üblichen
  valibot-Pfad kann ein Plugin bereits selbst in `parse(raw)` einbauen
  (`schema.parse(raw)` + try/catch + fallback). Bei Bedarf später ein
  natives `schema?: BaseSchema<T>`-Feld nachschieben.

### Schritt 4 — Plugin-Manifest + Loader — fertig

Branch: `feat/plugin-manifest-loader`. Manifest-Spec:
[`PLUGIN_MANIFEST.md`](./PLUGIN_MANIFEST.md).

Backend (`services/chat-gateway/src/dcc_chat_gateway/plugins/`):

- `manifest.py` (144 Z.) — pydantic-Modell für `plugin.toml`; akzeptiert
  Schema-API `"1"`. Validierung: `name` matched `^[a-z][a-z0-9_-]{1,31}$`,
  `IncompatibleApiError` bei falscher Major-Version.
- `loader.py` (153 Z.) — `discover_plugins_dir()` (env-Override
  `PULSE_PLUGINS_DIR` → Repo-Walk-Up nach `plugins/`), `load_directory()`,
  `load_all()`. Pro-Plugin-Fehler werden geloggt + geskippt; ein kaputtes
  Plugin gated nie die anderen.
- `registry.py` (236 Z.) — `PluginManager` mit `add`/`activate`/`deactivate`.
  Activate snapshottet `registered_ops()`/`registered_channels()` vor +
  nach `register()`-Call, der Diff ist die Tracking-Liste für Deactivate.
  Module werden über `pulse_plugin.<name>.<module>`-Synthetic-Key per
  `spec_from_file_location` geladen — kein Cache-by-bare-name-Hazard.
- `routes/ws_ops_registry.py` + `pubsub_channel_registry.py` haben jetzt
  ein `unregister_*`-Pendant (für den Plugin-Deactivate-Pfad).
- `app.py` Lifespan ruft `load_plugins()` nach den Background-Tasks auf;
  fail-tolerant (Exception schluckt + loggt, kein Boot-Block).

Frontend (`web/src/lib/plugins/`):

- `manifest-types.ts` (61 Z.) — TS-Spiegel des Python-Modells.
- `registry.ts` (134 Z.) — `addPlugin`/`activatePlugin`/`deactivatePlugin`.
  Diff-Tracking via `listWsHandlers()` + `listSections()` Snapshot.
- `loader.ts` (112 Z.) — `import.meta.glob('/../plugins/*/manifest.ts')`
  eager für Manifeste, lazy für die Frontend-Entries. Verzeichnis-Walk im
  Browser nicht möglich → jedes Plugin liefert sein `manifest.ts` als
  TS-Spiegel der TOML (CI-Sync später).
- `+layout.svelte` ruft `loadAll()` einmal `onMount` auf.

Skelett-Plugin `plugins/hello/`:

- `plugin.toml` (TOML-Manifest), `backend.py` (registriert `hello:ping` →
  antwortet mit `hello:pong`), `manifest.ts` (Frontend-Mirror der TOML),
  `frontend.ts` (registriert `hello:pong`-Handler, logged ans Console).

Tests:

- `services/chat-gateway/tests/test_plugin_loader.py` (16 Tests) deckt
  Manifest-Parsing (minimal/full/wrong-api/bad-name/missing-table),
  Discovery (env-var/walk-up), PluginManager-Lifecycle (activate registers,
  deactivate rolls back, idempotent, frontend-only-Plugins, mismatched
  Directory-Name, one-bad-plugin-doesn't-block-others) und ein
  End-to-End-Test, der das echte `plugins/hello/` lädt und verifiziert,
  dass `hello:ping` registriert ist.

Was bewusst NICHT in Schritt 4:

- **Permission-Gate auf `[plugin.uses]`** — die Listen werden geparst und
  gespeichert, aber der Loader weist (noch) nichts zurück, was nicht in
  der Whitelist steht. Schritt 5.
- **Persistierter Activate-State** — alle gefundenen Plugins werden
  auto-aktiviert. Eine `plugin_settings`-Tabelle mit On/Off-Flag pro
  Plugin kommt in Schritt 6 (mit dazu: das Admin-UI für Plugins).
- **Isolation/Sandboxing** — Plugins laufen im Host-Prozess. Schritt 5
  evaluiert Subinterpreter vs. signed-only.

### Schritt 5 — Permission-Gate + Soft-Sandbox + Lifecycle-Hooks — fertig

Branch: `feat/plugin-permissions-sandbox`.

**Realistic-Scope-Disclaimer.** Eine *echte* Sandbox (WASM, Subinterpreter,
Process-Isolation) wäre für **Stufe A** (interne / vertraute Plugins)
überdimensioniert. Schritt 5 baut deshalb eine **Soft-Sandbox** —
capability-passing + Manifest-vs-Code-Konsistenzprüfung. Reicht gegen
*versehentliche* Capability-Inflation. Reicht *nicht* gegen *bösartige*
Plugins; die wären Stufe B und brauchen einen der Pfade in
`memory/plugin-sandbox-future.md` (Bot-API → WASM).

Was sich geändert hat:

* **Backend Permission-Gate**
  (`services/chat-gateway/src/dcc_chat_gateway/plugins/permissions.py`,
  126 Z., neu):
  * `PluginPermissionError` mit den verletzten Op-/Channel-Listen.
  * `resolve_permission_mode()` liest `$PULSE_PLUGIN_PERMISSIONS` —
    `strict` (Default) / `warn` / `off`. Unbekannte Werte → strict.
  * `compute_violations()` als pure Funktion (Set-Differenz).
  * Eingehakt in `registry.py::PluginManager.activate()`: nach
    `register()` Diff der Registries gegen die Whitelist; bei Verletzung
    im strict-Modus alle in dieser Activation-Phase neuen Einträge
    revertiert (`unregister_ws_op` / `unregister_channel_handler`),
    dann `PluginPermissionError`.
* **Activation-Lifecycle (Backend)**: `register()` darf
  `{"deactivate": fn}` zurückgeben. `fn` läuft beim Deactivate *vor*
  dem Registry-Rollback (Plugin sieht eigene Ops noch live). Exception
  im Hook → log + swallow, Rollback geht weiter.
* **Frontend Permission-Gate** (`web/src/lib/plugins/registry.ts`,
  244 Z.):
  * `PluginPermissionError` + `resolvePluginPermissionMode()` (analog
    zum Backend; liest `import.meta.env.PULSE_PLUGIN_PERMISSIONS`
    bzw. `globalThis.PULSE_PLUGIN_PERMISSIONS` für Tests).
  * `activatePlugin()` diff'd gegen `manifest.uses.ws_ops` +
    `uses.settings_sections`, bei Verletzung im strict-Modus
    `unregisterWsHandler` für jeden neuen Handler + `failedActivate`-
    Flag auf dem Record + console.error + raise. Settings-Sections
    bleiben (keine `unregister`-API — Schritt 3-Design).
  * `deactivatePlugin()` Hook läuft jetzt *vor* dem Rollback (analog
    Backend). Exception → console.error + swallow.
* **`hello`-Plugin**: hat schon vorher `ws_ops = ["hello:ping"]`
  deklariert; nichts zu tun.
* **Tests (Backend)**:
  `services/chat-gateway/tests/test_plugin_permissions.py` (11 Tests,
  alle grün) deckt: strict-default-blocks-undeclared (mit Rollback-
  Verifikation), strict-allows-declared, strict-no-uses-block (leere
  Whitelist blockt alles), warn-mode-keeps-+-logs, off-mode-silently-
  accepts, unknown-mode-falls-back-to-strict, deactivate-hook-runs-
  before-rollback, deactivate-hook-exception-doesn't-block, register-
  returning-garbage-warns-but-activates, channel-violations,
  real-hello-plugin-passes-gate. Existing `test_plugin_loader.py`
  (16 Tests) noch grün — Helper `_make_plugin` wurde so angepasst dass
  die Plugins ihre Ops jetzt im Manifest deklarieren (verhaltens-neutral
  für den Loader-Pfad, nur der Permission-Gate würde sonst dazwischen
  funken).
* **Tests (Frontend)**: `pnpm check` + `pnpm build` grün (kein Vitest —
  Soft-Sandbox-Logik ist über die Backend-Tests covered, das Frontend
  spiegelt das Modell 1:1).
* **Memory-Doku** für Stufe-B-Pfade:
  `memory/plugin-sandbox-future.md` skizziert die vier Optionen
  (Bot-API, WASM, Subinterpreter, iframe), den empfohlenen Pfad
  (erst Bot-API, dann WASM, Subinterpreter skippen) und welche heutigen
  Code-Hooks Stufe-B-ready bleiben (`[plugin.uses]` als
  capability-Liste; `PluginManager.activate` als Erweiterungspunkt).

Was bewusst NICHT in Schritt 5:

* **Schritt 5b — Bot-API für externe Plugins.** Eigener
  Service `services/bot-api/`, Webhook + WS-Relay Modus, Bot-Token-Modell
  in `auth.bots`, Scope-basierte Capabilities. Out-of-process =
  niedrigster Aufwand für echte Isolation. Skizze in
  `memory/plugin-sandbox-future.md` (Option A).
* **Schritt 5c — WASM-Plugin-Host.** `services/wasm-host/` mit
  Wasmtime-Embedding + `pulse-plugin-api.wit`. Echte Memory-Isolation
  in-process, aber großer Aufwand + Plugin-Autoren brauchen
  WASM-fähigen Compiler. Erst wenn Latenz-kritische in-process-Plugins
  gebraucht werden (Voice-Effects o.ä.). Option B in der Memory-Doku.
* **Signierte Plugins / Marketplace.** Erst wenn Stufe B kommt.
* **Persistierter Activate-State** — alle gefundenen Plugins werden
  auto-aktiviert. `plugin_settings`-Tabelle + Admin-UI = Schritt 6.

### Schritt 6 — Plugin-Manager-UI + persistierter Activate-State — fertig

Branch: `feat/plugin-manager-ui`.

Was sich geändert hat:

* **Konflikt-Detektor** (`web/src/lib/plugins/conflict-detector.ts`, 108 Z.,
  neu): pure-Function Set-Differenz über die `[plugin.uses]`-Whitelists.
  Returnt `Conflict[]` mit `{kind, resource, plugins}` für jede Ressource
  (`ws_ops` / `channels` / `settings_sections` / `ui_slots`), die von ≥2
  Plugins deklariert ist. Optionaler `activeNames`-Filter, sodass das UI
  zwischen "Konflikt zwischen aktiven Plugins" (= echtes Problem) und
  "Hint zwischen inaktiven Plugins" unterscheiden kann.
* **Persistierter Activation-State** (`web/src/lib/plugins/activation-
  state.svelte.ts`, 70 Z., neu): nutzt `registerSettingsSection('plugins',
  { defaults: { activated: ['hello'] }, onSignOut: 'reset', version: 1 })`
  aus Schritt 3. API: `isPluginActivated/listActivatedPlugins/
  markPluginActivated/markPluginDeactivated`. `parse(raw)` validiert das
  persistierte Format defensiv.
* **Loader-Anpassung** (`web/src/lib/plugins/loader.ts`, 147 Z.): vorher
  wurden alle entdeckten Plugins auto-aktiviert. Jetzt:
  `addPlugin()` läuft immer (damit das UI das Plugin listen kann),
  `activatePlugin()` nur wenn `isPluginActivated(name)` true ist. Default
  `['hello']` hält den Schritt-4-Smoketest am Leben. Neue Funktion
  `setPluginActivated(name, active)` für UI-Toggles: persistiert *nach*
  erfolgreichem activate/deactivate (verhindert inkonsistenten State bei
  Exceptions).
* **Settings-Panel** (`web/src/lib/components/settings/SettingsPlugins.svelte`,
  236 Z., neu): Karten-Liste aller installierten Plugins. Pro Karte
  Name + Version + Author + Description, Tags für jede deklarierte
  `[plugin.uses]`-Schnittstelle (`ws_ops`, `channels`, `settings_sections`,
  `ui_slots`), Toggle-Button. Konflikte erscheinen als bernsteinfarbene
  Warning-Box oben + die geteilten Slots werden in den Karten bernsteinfarben
  hervorgehoben + per Karte gibt's eine kompakte "geteilte Slots mit X"-
  Sektion. Toggle wirft Toast bei Fehler (Permission-Gate-Rejection,
  Activate-Hook-Exception). Refresh-Button für Hot-Reload-Vorbereitung.
* **SettingsDialog-Integration** (`web/src/lib/components/SettingsDialog.svelte`):
  neuer Tab `'plugins'` mit Puzzle-Icon, als letzter Eintrag in der Nav-
  Liste (nach Privatsphäre/Sicherheit). Mobile-Drilldown funktioniert
  automatisch (das ist generisch).

Was bewusst NICHT in Schritt 6:

- **Beziehungs-Graph** (SVG mit Plugins links + Ressourcen rechts +
  Pfeilen) aus dem ursprünglichen Mockup-Konzept — die Tag-Liste +
  Konflikt-Highlight liefert die gleiche Information lesbarer.
- **Backend-Plugin-Liste-Endpoint** (`GET /api/chat/plugins`) — das
  Frontend nutzt `import.meta.glob` für Discovery, der Endpoint wäre
  doppelte Datenhaltung. Wenn ein Admin-Read-Only-View „welche Plugins
  hat der Server installiert" gewünscht ist, später in Schritt 7.
- **Hot-Reload** (Plugin dynamisch ohne Page-Reload nachladen).
  Refresh-Button im UI ruft `listPlugins()` neu auf, aber die
  `import.meta.glob`-Map ist Build-fixiert; neue Plugins nach `pnpm dev`-
  Start sind erst nach HMR-Tick verfügbar.
- **UI-Slot/Component-Punkt** + **Migrations** — bleiben für Schritt 8.

### Schritt 7 — Tamagotchi-Reference-Plugin — fertig

Branch: `feat/example-tamagotchi-plugin`.

Erstes echtes Pulse-Plugin (nach dem `hello/`-Skelett, das nur Ping/Pong macht).
Übt **alle vier** Plugin-Punkte gleichzeitig aus und dient ab jetzt als
Copy-Paste-Vorlage für eigene Plugins.

* **Plugin-Verzeichnis** `plugins/tamagotchi/`:
  * `plugin.toml` — Manifest mit `ws_ops = [tamagotchi:{feed,play,sleep,reset,ack}]`,
    `settings_sections = ["tamagotchi"]`, `scope.type = "per-user"`.
  * `backend.py` (98 Z.) — registriert vier Action-Ops (`feed`/`play`/`sleep`/
    `reset`), echo't jede mit einem `tamagotchi:ack`-Frame zurück. State lebt
    *client-seitig* (siehe `store.ts`); das Backend ist heute nur Echo —
    Schritt 3b (server-side `user_preferences`) wäre der Pfad für Cross-Device-
    Sync, der diesen Echo zur State-Quelle macht.
  * `manifest.ts` — Frontend-Spiegel des TOML (Browser hat kein TOML-Parser).
  * `frontend.ts` (148 Z.) — registriert die Settings-Section `tamagotchi`
    (parser-validiert via `parsePet`), den `tamagotchi:ack`-WS-Handler, und
    exportiert `feed/play/sleep/reset/rename/refreshDecay/getPetStore`. Jeder
    Action-Call läuft optimistic-update first, sendet die WS-Op über
    `gateway.sendPluginOp` parallel. `deactivate()`-Hook räumt den Handler ab
    und nullt das Modul-Singleton.
  * `store.ts` (190 Z.) — pure Decay-Logik (Hunger/Glück/Energie, 0–100), keine
    Svelte-/DOM-Dep. `applyDecay(state, now)` ist die Schlüsselfunktion: Stats
    werden *beim Lesen* mit der seit `lastUpdatedAt` verstrichenen Zeit
    durchgerechnet → kein `setInterval` nötig.
  * `components/TamagotchiWidget.svelte` (227 Z.) — kleines Card-UI im
    Sidebar-Footer. Emoji-Avatar pro Mood (🐣/🐤/😴/🍽️/🥺/💤), drei
    Progress-Bars, vier Action-Buttons. Bewusst **keine Lucide-Imports**, weil
    `plugins/` kein pnpm-Workspace-Member ist → Unicode-Glyphen statt Icon-Komponenten.
* **`sendPluginOp` auf `GatewayConnection`** (`web/src/lib/ws/connection.ts`):
  generischer Outbound-Pfad für Plugin-Ops. Verlangt einen colon-namespaced
  Op-Code (`plugin:action`) — schützt vor versehentlicher Kollision mit
  Built-in-Ops (`send`/`subscribe`/…). Cast through `unknown`, weil
  `ClientEvent` plugin ops zur Build-Time nicht kennt.
* **Default-aktiv**: `web/src/lib/plugins/activation-state.svelte.ts` listet
  `tamagotchi` neben `hello` in `DEFAULT_ACTIVATED` — frische Installationen
  sehen das Widget direkt. User kann's im Plugin-Manager
  (`/Einstellungen → Plugins`) toggeln; der persistierte State überschreibt
  den Default.
* **Sidebar-Mount** (`web/src/lib/components/SidebarFooter.svelte`):
  Widget conditional gerendert, gegated auf
  `!viewport.isMobile && pluginActivation.activated.includes('tamagotchi')`.
  Hardcodet, weil der UI-Slot-Plugin-Punkt erst in Schritt 8 kommt — wir
  wollen einen sichtbaren Beweis-of-Concept, kein Slot-Framework.
* **Tests** (`services/chat-gateway/tests/test_plugin_tamagotchi.py`, 4 Tests,
  alle grün): Plugin lädt via Discovery + ist active, Permission-Gate
  (strict) akzeptiert das Manifest, Deactivate rollt alle Ops weg, feed-
  Handler acked via Fake-Socket. Das `_isolate_registries`-Fixture wipet
  Plugin-Ops *vor* dem Snapshot, um Test-Reihenfolge-Leak aus
  FastAPI-Lifespan-Tests (die `load_all()` triggern könnten) zu absorbieren.

Was bewusst NICHT in Schritt 7:

* **Server-side State-Persistenz** — Tamagotchi-State lebt nur in
  `localStorage`, ist also pro Device. Schritt 3b (`user_preferences`-Tabelle)
  wäre der Pfad für Cross-Device-Sync; der Echo-Ack ist schon der Hook.
* **Tod / Wiederbelebung** — `alive: boolean` ist im State-Modell vorhanden,
  aber heute immer `true`. Eine echte "Pet stirbt nach 3 Tagen Hunger 100"-
  Mechanik wäre Schritt 7+.
* **UI-Slot-Registry** — das Widget wird hardcoded im `SidebarFooter`
  gemountet. Plugin-Punkt `[plugin.uses].ui_slots` ist deklariert (leer für
  Tamagotchi), die Slot-Registry selbst existiert noch nicht.
* **Notifications** — keine "dein Pet hat Hunger"-Push-Notification.

## Plugin-Punkte (Status-Tabelle)

| Punkt | Frontend | Backend | Plan-Schritt |
|---|---|---|---|
| WS-Event-Schemas | ✅ | ✅ | 1 |
| Listener strict validation | — | ✅ (1b) | 1b |
| WS-Op-Handler | ✅ (2c) | ✅ (2) | 2 |
| Channel-Subscription | — | ✅ (2) | 2 |
| Settings-Section | ✅ (3) | — (3b geplant) | 3 |
| Plugin-Manifest + Loader | ✅ (4) | ✅ (4) | 4 |
| Permission-Gate auf `[plugin.uses]` | ✅ (5) | ✅ (5) | 5 |
| Activation-Lifecycle (`deactivate`-Hook) | ✅ (5) | ✅ (5) | 5 |
| Plugin-Manager-UI + Konflikt-Detektor | ✅ (6) | — | 6 |
| Persistierter Activate-State | ✅ (6) | — | 6 |
| Reference-Plugin (Tamagotchi) | ✅ (7) | ✅ (7) | 7 |
| Bot-API (out-of-process, Stufe B) | — | — | 5b (geplant) |
| WASM-Plugin-Host (in-process, isoliert) | — | — | 5c (geplant) |
| UI-Slot/Component | — | — | 8 (geplant) |
| Migrations | — | — | 8 (geplant) |
