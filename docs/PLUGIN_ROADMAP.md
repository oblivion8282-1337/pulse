# Pulse Plugin-System — Roadmap

Stand: 2026-05-24 (Schritt 5 fertig)

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

## Plugin-Punkte (Status-Tabelle)

| Punkt | Frontend | Backend | Plan-Schritt |
|---|---|---|---|
| WS-Event-Schemas | ✅ | ✅ | 1 |
| WS-Op-Handler | ✅ (2c) | ✅ (2) | 2 |
| Channel-Subscription | — | ✅ (2) | 2 |
| Settings-Section | ✅ (3) | — (3b geplant) | 3 |
| Plugin-Manifest + Loader | ✅ (4) | ✅ (4) | 4 |
| Permission-Gate auf `[plugin.uses]` | ✅ (5) | ✅ (5) | 5 |
| Activation-Lifecycle (`deactivate`-Hook) | ✅ (5) | ✅ (5) | 5 |
| Bot-API (out-of-process, Stufe B) | — | — | 5b (geplant) |
| WASM-Plugin-Host (in-process, isoliert) | — | — | 5c (geplant) |
| UI-Slot/Component | — | — | 6 |
| Migrations | — | — | 6 |
| Plugin-Admin-UI + persistierter Activate-State | — | — | 6 |
