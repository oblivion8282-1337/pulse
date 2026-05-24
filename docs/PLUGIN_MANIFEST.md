# Pulse Plugin Manifest (Schritt 4)

Stand: 2026-05-24

Jedes Pulse-Plugin liegt in einem eigenen Verzeichnis unter `plugins/<name>/`
(im Repo-Root) und beschreibt sich über ein `plugin.toml`. Loader (Backend +
Frontend) scannen beim App-Start dieses Verzeichnis, parsen jedes Manifest,
und rufen die deklarierten Entrypoints auf — symmetrisch zu den drei
Einsteck-Punkten der Schritte 1–3:

* WS-Op-Handler (`register_ws_op` / `registerWsHandler`)
* Channel-Subscription (`register_channel_handler`)
* Settings-Sections (`registerSettingsSection`)

Das Manifest ist die **Single Source of Truth** für *welches* Plugin existiert
und *was* es im System beanspruchen darf — die `[plugin.uses]`-Felder werden
in Schritt 5 zum Permission-Gate (ein Plugin darf nur die WS-Ops/Channels
registrieren, die im Manifest stehen).

## Format

```toml
[plugin]
name = "tamagotchi"           # required, [a-z0-9_-]+, unique pro Pulse-Install
version = "0.1.0"             # required, semver
api = "1"                     # required, Pulse-Plugin-API-Major. Heute "1".
author = "Pulse Maintainer"   # optional, frei
description = "Virtuelles Haustier pro User"  # optional, frei

[plugin.scope]
# Wo der Plugin-State lebt. Hinweis für UI + Schritt 5 Permission-Modell;
# der Loader wertet das (noch) nicht aus.
#   "per-user"   — State pro User (Settings-Section, lokal/synced)
#   "per-guild"  — State pro Server (Backend-Storage)
#   "global"     — singleton Plugin-State
type = "per-user"

[plugin.uses]
# Whitelist der Schnittstellen, die das Plugin in Anspruch nimmt.
# Schritt 4: rein deklarativ (Loader trackt, aber blockt nicht).
# Schritt 5: Loader weist Registrations zurück, die NICHT in dieser Liste
# stehen — Defense-in-depth gegen Manifest-vs-Code-Drift.
ws_ops = ["hello:ping"]                      # ops, die das Plugin registriert
ws_emit_ops = ["hello:pong"]                 # ops, die das Plugin AN Clients sendet
channels = []                                # Redis pubsub-Channels
settings_sections = []                       # Section-Namen (Frontend Schritt 3)
ui_slots = []                                # spätere UI-Erweiterungspunkte

[plugin.entrypoints]
# Modul-Pfade, die der Loader importiert. Optional — ein reines Backend-Plugin
# lässt `frontend` weg und umgekehrt.
backend  = "backend:register"   # Python "module:function", relativ zum Plugin-Dir
frontend = "frontend.ts"        # Datei relativ zum Plugin-Dir; Default-Export = register-Fn
```

### Felder im Detail

| Feld | Pflicht | Form | Notes |
|---|---|---|---|
| `plugin.name` | ✅ | `^[a-z][a-z0-9_-]{1,31}$` | identisch zum Verzeichnis-Namen |
| `plugin.version` | ✅ | Semver-String | nur informativ in Schritt 4 |
| `plugin.api` | ✅ | `"1"` | Plugin-Loader weist andere Werte ab |
| `plugin.author` | — | String | |
| `plugin.description` | — | String | UI-Anzeige im Plugin-Manager (Schritt 7) |
| `plugin.scope.type` | — | `per-user`/`per-guild`/`global` | Default `global` |
| `plugin.uses.*` | — | Liste Strings | leer = nichts deklariert |
| `plugin.entrypoints.backend` | — | `"module:function"` | Modul wird per `importlib.import_module` geladen, dann `getattr(mod, fn)` aufgerufen |
| `plugin.entrypoints.frontend` | — | Pfad zu `.ts`/`.js` | Vite `import.meta.glob` lädt den Default-Export, der eine `register()`-Funktion sein muss |

### Plugin-Verzeichnis-Layout

```
plugins/hello/
├── plugin.toml          # Manifest (oben)
├── backend.py           # optional — wird vom Backend-Loader geladen
└── frontend.ts          # optional — wird vom Frontend-Loader geladen
```

### Entrypoint-Contract

**Backend** (`backend:register`):

```python
def register() -> None:
    """Wird vom Loader genau einmal beim App-Start aufgerufen.

    Plugin registriert hier seine WS-Ops + Channel-Handler via die
    Schritt-2-Decorators. Idempotent.
    """
```

**Frontend** (`frontend.ts` Default-Export):

```typescript
export default function register(): void {
  // Plugin registriert hier WS-Handler + Settings-Sections via
  // die Schritt-2c/3-APIs. Idempotent.
}
```

### Activate/Deactivate

Schritt 4 liefert die Loader-Infrastruktur + ein Lifecycle-API. Die
Plugin-Registry merkt sich pro Plugin, welche Ops/Channels/Sections es
während `register()` registriert hat, und kann sie beim `deactivate(name)`
über die `unregister*`-APIs der jeweiligen Registry wieder entfernen.

In Schritt 4 ist die UI noch nicht da — Activate/Deactivate sind Test-API.
Persistierung des Activate-Status (welche Plugins beim nächsten Start
geladen werden sollen) kommt in Schritt 6.

### Konfiguration / Discovery

* **Default:** Repo-internes `plugins/`-Verzeichnis im Pulse-Root.
* **Override:** Env-Var `PULSE_PLUGINS_DIR` setzt einen alternativen Pfad
  (z. B. `~/.pulse/plugins/` für Self-Host).
* **Frontend:** Plugin-Verzeichnis wird per Vite `import.meta.glob` zur
  Build-Zeit eingelesen; ein `plugins.json` listet pro Build die
  enthaltenen Plugin-Namen + Frontend-Entry-Pfade. Generierung über
  einen kleinen Sync-Step (s. `web/scripts/sync-plugins.mjs` oder
  direkt im Vite-Plugin — Schritt 4 lädt initial nur den im Repo
  vorhandenen Skelett-Plugin `hello`).
* **Server-Side Plugin-Activate-Status** (Schritt 6) wird in einer
  `plugin_settings`-Tabelle persistiert; Schritt 4 hat *alle* gefundenen
  Plugins automatisch aktiv.

### Versionierung

`plugin.api = "1"` ist Major-Version der Plugin-API. Plugins müssen den
Wert exakt matchen — `2` lehnt der Loader heute mit `IncompatibleApiError`
ab. Breaking-Change-Strategy: wenn die Decorator-Signaturen sich ändern,
springt `api` auf `"2"`, und Loader-Code in `plugins/loader.py` /
`web/src/lib/plugins/loader.ts` enthält für eine Migrationsperiode
Adapter für `api = "1"`.

### Beispiel — Hello-Plugin (Schritt 4 Skelett)

`plugins/hello/plugin.toml`:

```toml
[plugin]
name = "hello"
version = "0.1.0"
api = "1"
description = "Ping/Pong-Demo, beweist dass der Plugin-Loader läuft"

[plugin.scope]
type = "global"

[plugin.uses]
ws_ops = ["hello:ping"]
ws_emit_ops = ["hello:pong"]

[plugin.entrypoints]
backend  = "backend:register"
frontend = "frontend.ts"
```

`plugins/hello/backend.py`:

```python
from dcc_chat_gateway.routes.ws_ops_registry import register_ws_op


@register_ws_op("hello:ping")
async def _handle_hello_ping(ctx, msg):
    await ctx.websocket.send_json({"op": "hello:pong", "echo": msg.get("echo")})


def register() -> None:
    """Idempotent — die @register_ws_op-Decorator hat sich bereits eingehakt
    als das Modul importiert wurde. Diese Funktion existiert für Symmetrie
    + Future-Use (wenn das Plugin Init-Code bräuchte, käme er hier rein).
    """
```

`plugins/hello/frontend.ts`:

```typescript
import { registerWsHandler } from '$lib/ws/handler-registry';

export default function register(): void {
  registerWsHandler('hello:pong' as never, (evt: { echo?: unknown }) => {
    console.log('[hello-plugin] pong:', evt.echo);
  });
}
```

Test (per WS-Client gegen das laufende Dev-Backend):

```json
{"op":"hello:ping","echo":"hi"}
```

Erwartete Server-Antwort:

```json
{"op":"hello:pong","echo":"hi"}
```

## Was bewusst NICHT in Schritt 4 ist

* **Isolation/Sandboxing** — Plugins laufen im Host-Prozess, mit vollem
  Backend-Process-Zugriff. Schritt 5 (Permission-Modell) und ggf. ein
  Subinterpreter-Ansatz kommen separat.
* **Hot-Reload** — Plugins werden beim App-Start einmal geladen. Restart
  → neue Plugin-Liste.
* **Dependency-Graph** zwischen Plugins — Plugin-A-braucht-Plugin-B.
  Heute laden alle Plugins parallel, in undefinierter Reihenfolge.
* **Migration-API** für Plugin-DB-Tabellen — Schritt 4/5.
* **UI-Slot-Registry** — `[plugin.uses].ui_slots` ist nur deklariert;
  die Slot-Registry selbst existiert noch nicht (Schritt 4/5 in Roadmap).

## Aktivierungsmodell (Admin + Guild)

Seit dem Plugin-Admin-Aktivierungs-PR ist die Plugin-Aktivierung **kein
per-User-State mehr**, sondern zwei Admin-gepflegte Ebenen:

1. **Instanz-Allowlist** (`chat.instance_plugin_allowlist`, vom
   Bootstrap-Admin (`auth.users.is_admin = true`) gepflegt). Was darf
   auf dieser Pulse-Instanz überhaupt geladen werden? Der chat-gateway-
   Loader importiert beim Startup **nur Plugins aus der Allowlist** und
   registriert deren WS-Ops/Channels/Settings-Sections.
2. **Pro-Guild-Toggle** (`chat.guild_plugins`, vom Guild-Admin mit
   `MANAGE_GUILD`-Permission). Pro Server: ist ein Allowlist-erlaubtes
   Plugin auf diesem Server aktiv? Der WS-Op-Dispatcher gated jeden
   colon-namespaced Plugin-Op gegen dieses Toggle.

### Plugin-Ops müssen `guild_id` führen

Plugin-Ops (Format `<plugin>:<action>`, z.B. `tamagotchi:feed`) brauchen
ab jetzt ein **Pflichtfeld `guild_id`** im Payload — die Snowflake-ID
des Servers, auf dem die Aktion stattfindet. Der WS-Op-Gate
(`plugins/ws_op_gate.py`) lehnt fehlende `guild_id` mit Error-Code
`4014` ab; fehlende Membership → `4015`; Plugin nicht für die Guild
aktiviert → `4016`. Übers Wire ist `guild_id` ein **String** (JS-`Number`-
Präzisions-Grenze), Backend coerced toleranten Pfad zu int.

Das Hello-Plugin (`hello:*`) ist der Sonderfall:

* `hello` ist **fest in der Allowlist** (Loader-Self-Heal beim Startup
  + Migrations-Seed) und kann vom Admin nicht entfernt werden (DELETE
  → 409).
* `hello`-Ops umgehen das Guild-Gate komplett — kein `guild_id`-Feld
  nötig, kein Membership-Check, kein Guild-Toggle. Das hält den
  Loader-Smoketest unabhängig von Guild-Setup.

### Admin-API (Bootstrap-Admin, JWT `admin: true`)

| Endpunkt | Effekt |
|---|---|
| `GET /admin/plugins` | Discovery ∪ Allowlist. Pro Plugin: `in_discovery`, `in_allowlist`, `version`, `description` |
| `PUT /admin/plugins/{name}` | In die Allowlist eintragen. 404 wenn `name` nicht in der Discovery existiert. Idempotent |
| `DELETE /admin/plugins/{name}` | Aus der Allowlist entfernen + alle `guild_plugins`-Rows mit raus. 409 für `hello` |

### Guild-API (`MANAGE_GUILD`, Owner-Bypass)

| Endpunkt | Effekt |
|---|---|
| `GET /guilds/{id}/plugins` | Pro Allowlist-Plugin: `{plugin_name, enabled}`. `hello` immer `enabled=true`. Caller muss Mitglied sein |
| `PUT /guilds/{id}/plugins/{name}` | Toggle. Body `{enabled: bool}`. 404 wenn nicht in Allowlist, 409 für `hello` |

### Hot-Reload-Verhalten

Allowlist + Guild-Toggle-Mutationen **wirken nicht sofort**:

* **Allowlist-Mutation** → Plugin-Op-Gate liest aus
  `app.state.plugin_allowlist` (Snapshot zur Lifespan-Zeit). Neue
  Plugins werden vom Loader erst beim **nächsten Service-Restart**
  registriert. Bis dahin: 4013 für jeden Op auf neuen Plugins.
* **Guild-Toggle-Mutation** → WS-Op-Gate cached den Toggle-Status mit
  60 s TTL pro `(guild_id, plugin_name)`. Eine Änderung greift also
  innerhalb von max. 60 s — gut genug für PR1. Echtzeit-Invalidation
  über Redis-Pub/Sub wäre PR2.
