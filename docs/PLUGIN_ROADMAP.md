# Pulse Plugin-System — Roadmap

Stand: 2026-05-24

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

### Schritt 5 — Permission-Gate + Sandboxing (geplant)

Loader weist Registrations zurück, die NICHT in `[plugin.uses]` stehen —
"Manifest-vs-Code"-Drift-Schutz. Außerdem: signierte Plugins, optionaler
Subinterpreter.

## Plugin-Punkte (Status-Tabelle)

| Punkt | Frontend | Backend | Plan-Schritt |
|---|---|---|---|
| WS-Event-Schemas | ✅ | ✅ | 1 |
| WS-Op-Handler | ✅ (2c) | ✅ (2) | 2 |
| Channel-Subscription | — | ✅ (2) | 2 |
| Settings-Section | ✅ (3) | — (3b geplant) | 3 |
| Plugin-Manifest + Loader | ✅ (4) | ✅ (4) | 4 |
| Permission-Gate auf `[plugin.uses]` | — | — | 5 |
| UI-Slot/Component | — | — | 5 |
| Migrations | — | — | 5 |
| Plugin-Admin-UI + persistierter Activate-State | — | — | 6 |
