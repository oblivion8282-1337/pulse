# Selfhost ②a — Host-Tunnel-Client + Origin-Umstellung Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Den Heim-Host über einen Reverse-Tunnel (rathole) unter einer Relay-Subdomain erreichbar machen — die erste, **lokal baubare + testbare** Scheibe von ②a: Host-Tunnel-Client (im `LocalBackendManager` aus ①) + Origin-Umstellung auf die Subdomain, beweisbar über einen *lokalen* rathole-Server.

**Architecture:** Der Host bündelt die `rathole`-Client-Binary; `LocalBackendManager` (aus ①) startet sie als überwachten Prozess mit einer gerenderten Client-Config (lokales chat-gateway:Port → benannter Tunnel zum Relay). `renderEnv` setzt den **public-origin** (JWT/WebAuthn/CORS/MinIO-URL) auf die Relay-Subdomain statt den internen Hostnamen. Verifiziert durch einen Integrationstest mit lokalem rathole-Server.

**Tech Stack:** TypeScript (Electron-Main, `desktop/electron/localBackend/`), `node:test` (Node v25), `rathole` (neue gebündelte Binary — im Brainstorming freigegeben). Backend unverändert.

## Global Constraints

- **Baut auf ① auf** (`feat/selfhost-native-orchestrator`, PR #20) — muss vor Ausführung gemergt/gestackt sein. `LocalBackendManager`, `SupervisedProcessSpec`, `renderEnv`, `resolveBinary` stammen von dort.
- **No new npm dependencies; NO Vitest** (`node:test`, Node v25). Relative Imports mit `.ts`-Extension. **No backend (`services/`) code changes** in dieser Scheibe.
- **rathole** ist eine neue *native* Binary (kein npm) — Host bündelt den Client; Tests brauchen `rathole` lokal (z.B. `brew install rathole` oder Release-Binary). Im Brainstorming freigegeben (Tendenz rathole vs frp).
- Steuerungsebene only — **kein** LiveKit/MediaMTX/coturn (= ②b). Alles localhost außer dem ausgehenden Tunnel.
- Secrets (Tunnel-Auth-Token) nie loggen.

---

## File Structure

- Modify: `desktop/electron/localBackend/types.ts` — `BinaryName` += `'rathole'`; `Ports` += `tunnel` falls nötig.
- Create: `desktop/electron/localBackend/tunnel.ts` — `renderRatholeClientConfig(input): string` + `tunnelComponent(...): SupervisedProcessSpec`.
- Modify: `desktop/electron/localBackend/renderConfig.ts` — `FixtureIdentity.relaySubdomain?`; `renderEnv` nutzt `publicOrigin = relaySubdomain ?? hostname` für JWT/WebAuthn/CORS/MinIO-URLs.
- Modify: `desktop/electron/localBackend/localBackendManager.ts` — Tunnel-Komponente nach chat-gateway in die Start-Sequenz.
- Test: `desktop/test/localBackend/tunnel.test.ts` (Unit: Config-Rendering + Origin-Override) + `desktop/test/localBackend/tunnel.int.test.ts` (Integration: lokaler rathole-Server + Client → Request erreicht chat-gateway durch den Tunnel).

---

### Task 1: `rathole` als Binary + Tunnel-Client-Config-Renderer

**Files:**
- Modify: `desktop/electron/localBackend/types.ts` (`BinaryName` union)
- Create: `desktop/electron/localBackend/tunnel.ts`
- Test: `desktop/test/localBackend/tunnel.test.ts`

**Interfaces:**
- Consumes: `resolveBinary` (paths.ts).
- Produces: `renderRatholeClientConfig(input: { relayServerAddr: string; authToken: string; localChatPort: number; tunnelName: string }): string` — gibt eine rathole-**Client**-TOML zurück (Format unten). `RATHOLE_TUNNEL_NAME` Konstante.

- [ ] **Step 1: Failing test für die Config**

```ts
// desktop/test/localBackend/tunnel.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRatholeClientConfig } from '../../electron/localBackend/tunnel.ts';

test('renderRatholeClientConfig baut die Client-TOML', () => {
  const toml = renderRatholeClientConfig({
    relayServerAddr: 'relay.howispulse.com:2333',
    authToken: 'TKN', localChatPort: 8002, tunnelName: 'inst-42',
  });
  assert.match(toml, /\[client\]/);
  assert.match(toml, /remote_addr = "relay\.howispulse\.com:2333"/);
  assert.match(toml, /default_token = "TKN"/);
  assert.match(toml, /\[client\.services\.inst-42\]/);
  assert.match(toml, /local_addr = "127\.0\.0\.1:8002"/);
});
```

- [ ] **Step 2: FAIL** — `cd desktop && node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test test/localBackend/tunnel.test.ts` → Modul fehlt.

- [ ] **Step 3: Implementieren** — `types.ts`: `BinaryName` um `| 'rathole'` erweitern. `tunnel.ts`:

```ts
// rathole client config (TOML). Der Relay-Server kennt denselben Service-Namen
// + Token und exponiert ihn unter der Subdomain (TLS terminiert am Relay).
export function renderRatholeClientConfig(input: {
  relayServerAddr: string; authToken: string; localChatPort: number; tunnelName: string;
}): string {
  return [
    '[client]',
    `remote_addr = "${input.relayServerAddr}"`,
    `default_token = "${input.authToken}"`,
    '',
    `[client.services.${input.tunnelName}]`,
    'type = "tcp"',
    `local_addr = "127.0.0.1:${input.localChatPort}"`,
    '',
  ].join('\n');
}
```

- [ ] **Step 4: PASS** — Test grün.
- [ ] **Step 5: Commit** — `git commit -m "feat(selfhost): rathole-Binary + Client-Config-Renderer"`

---

### Task 2: Origin-Umstellung — `relaySubdomain` in `renderEnv`

**Files:**
- Modify: `desktop/electron/localBackend/renderConfig.ts` (`FixtureIdentity`, `renderEnv`)
- Test: `desktop/test/localBackend/tunnel.test.ts` (erweitern)

**Interfaces:**
- Consumes: `RenderEnvInput` (renderConfig.ts).
- Produces: `FixtureIdentity` += `relaySubdomain?: string`; `renderEnv` nutzt `publicOrigin = identity.relaySubdomain ?? identity.hostname` für `JWT_ISSUER`, `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN`, `CORS_ALLOW_ORIGINS`, `MINIO_SERVER_URL`, `S3_PUBLIC_ENDPOINT`. Interne URLs (Postgres/Redis) bleiben localhost.

- [ ] **Step 1: Failing test**

```ts
test('renderEnv nutzt relaySubdomain als public origin', () => {
  const base = { dirs: dataDir('/u'), secrets: FIXTURE_SECRETS,
    ports: FIXTURE_PORTS };
  const env = renderEnv({ ...base, identity: {
    hostname: 'home.internal', instanceId: '42', ownerId: '9',
    relaySubdomain: 'inst-42.relay.howispulse.com' } });
  assert.equal(env.JWT_ISSUER, 'https://inst-42.relay.howispulse.com');
  assert.equal(env.WEBAUTHN_RP_ID, 'inst-42.relay.howispulse.com');
  assert.match(env.CORS_ALLOW_ORIGINS, /inst-42\.relay\.howispulse\.com/);
  // interne DB-URL bleibt localhost:
  assert.match(env.DATABASE_URL, /@127\.0\.0\.1:/);
});
```
(`FIXTURE_SECRETS`/`FIXTURE_PORTS` aus den bestehenden renderConfig-Tests übernehmen — DRY.)

- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implementieren** — `FixtureIdentity` um `relaySubdomain?: string` erweitern; in `renderEnv` ganz oben `const publicOrigin = input.identity.relaySubdomain ?? input.identity.hostname;` und alle `https://${hostname}`-Origin-URLs (JWT/WebAuthn/CORS/MinIO) auf `publicOrigin` umstellen. **Keine** Änderung an Postgres/Redis-URLs.
- [ ] **Step 4: PASS** + `pnpm test:unit` (Regression — die bestehenden renderEnv-Tests ohne `relaySubdomain` müssen weiter grün sein, da der Fallback `?? hostname` greift).
- [ ] **Step 5: Commit** — `git commit -m "feat(selfhost): Relay-Subdomain als public origin in renderEnv"`

---

### Task 3: Tunnel als überwachte Komponente im Manager

**Files:**
- Modify: `desktop/electron/localBackend/tunnel.ts` (`tunnelComponent`)
- Modify: `desktop/electron/localBackend/localBackendManager.ts` (Start-Sequenz)
- Modify: `desktop/electron/localBackend/types.ts` (falls `Ports`/Input um Relay-Felder erweitert)
- Test: `desktop/test/localBackend/tunnel.test.ts` (Spec-Bau)

**Interfaces:**
- Consumes: `SupervisedProcessSpec` (process.ts), `resolveBinary`, `renderRatholeClientConfig` (Task 1).
- Produces: `tunnelComponent(input: { dirs; relay: { serverAddr; authToken; subdomain }; chatPort: number }): SupervisedProcessSpec` — schreibt die Client-TOML nach `dirs.root/rathole-client.toml`, Spec: `command = resolveBinary('rathole')`, `args = ['--client', '<config>']` (rathole-CLI prüfen: `rathole <config>` mit `[client]`-Sektion startet Client-Modus), `name='tunnel'`, `healthCheck` = TCP-Probe auf den lokalen chat-gateway-Port (der Tunnel selbst hat keinen lokalen Health-Port — die Erreichbarkeit prüft der Integrationstest), `restartMax: 5`.
- `LocalBackendManager.start(input)` erhält optional `relay?: { serverAddr; authToken; subdomain }`; wenn gesetzt → nach chat-gateway den Tunnel starten + `renderEnv` mit `relaySubdomain = relay.subdomain` aufrufen. Ohne `relay` → Verhalten exakt wie ① (kein Tunnel).

- [ ] **Step 1: Failing test** — `tunnelComponent({...})` gibt eine Spec mit `name==='tunnel'`, `command` enthält `rathole`, und schreibt die TOML-Datei (assert `existsSync` + Inhalt enthält die Subdomain-Service-Sektion).
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implementieren** — `tunnelComponent` (TOML schreiben + Spec bauen); `LocalBackendManager.start` optional `relay` verdrahten (Tunnel nach chat-gateway; `renderEnv` mit `relaySubdomain`). Rollback/Stop schließt den Tunnel mit ein (er ist Teil der überwachten Prozesse).
- [ ] **Step 4: PASS** + `pnpm test:unit` grün.
- [ ] **Step 5: Commit** — `git commit -m "feat(selfhost): Tunnel-Komponente im LocalBackendManager"`

---

### Task 4: Integrationstest — Request erreicht chat-gateway durch den Tunnel

**Files:**
- Test: `desktop/test/localBackend/tunnel.int.test.ts`

**Voraussetzung:** `rathole` lokal verfügbar (`resolveBinary('rathole')`); Test skippt sauber, wenn nicht. pg-Keg auf PATH (für den ①-Stack), wie bei den ①-Integrationstests.

- [ ] **Step 1: Test schreiben** — Ablauf:
  1. `manager.start({ userData: tmp, identity: {...}, relay: { serverAddr: '127.0.0.1:<relayPort>', authToken: 'T', subdomain: 'inst-test.local' } })` — bringt ①-Stack + Tunnel-Client hoch.
  2. **Lokaler rathole-Server**: vor `manager.start` einen rathole-Server-Prozess starten (Server-TOML: `[server] bind_addr='127.0.0.1:<relayPort>'`, `[server.services.inst-test] type='tcp' bind_addr='127.0.0.1:<exposedPort>' token='T'`), warten bis er lauscht.
  3. Nach `manager.start`: HTTP-Request an `http://127.0.0.1:<exposedPort>/health` (= der vom Relay-Server exponierte Port, der durch den Tunnel auf das lokale chat-gateway:Port zeigt) → **HTTP 200** (chat-gateway `/health` durch den Tunnel erreicht).
  4. **Reconnect:** Tunnel-Client-Prozess killen → `/health` über den exposed Port schlägt fehl → SupervisedProcess restartet → wieder 200.
  5. `manager.stop()` + rathole-Server stoppen; `finally`-Cleanup.
- [ ] **Step 2: Run** — `cd desktop && PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH" node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-timeout=120000 test/localBackend/tunnel.int.test.ts` → PASS (skip wenn rathole/pg fehlen).
- [ ] **Step 3: README** — kurze Notiz in `desktop/electron/localBackend/README.md`: rathole-Binary-Voraussetzung + wie der Integrationstest läuft.
- [ ] **Step 4: Commit** — `git commit -m "feat(selfhost): Tunnel-Integrationstest (lokaler Relay) + README"`

---

## Folge-Scheiben von ②a (NICHT in diesem Plan — Cloud/Ops-gated)

Diese sind **nicht lokal voll baubar/verifizierbar** (Prod-Cloud, DNS, Wildcard-Cert) und bekommen eigene Pläne, wenn ① + diese Tunnel-Scheibe stehen:

- **Cloud Subdomain-Vergabe + Registry:** Alembic-Migration (`relay_subdomain` auf `registered_instances`), `BootstrapCredsOut` um `relay_subdomain`/`relay_server_addr`/`relay_auth_token` erweitern, `redeem_bootstrap_token()` vergibt die Subdomain + Tunnel-Token. (Backend `services/auth` — dann *mit* Tests + Changelog.)
- **Prod-Relay-Dienst:** `rathole-server`-Container in `infra/prod/docker-compose.yml` + `*.relay.howispulse.com`-Routing. **Wichtig (Befund):** rathole ist TCP — der Relay-Server muss benannte Tunnel intern auf chat-gateway routen; Caddy kann TCP nicht direkt proxien → TLS-Terminierung + Subdomain→Tunnel-Mapping sauber lösen (rathole-Server pro Service-Name, davor TLS).
- **DNS + Wildcard-Cert:** `*.relay.howispulse.com`-A-Record + Caddy DNS-01-Wildcard-Cert (DNS-API-Zugriff) — reines Ops.
- **Client-Discovery:** die Cloud liefert die Subdomain als Instanz-Adresse (Instanz-Liste/Server-Vault) → `server.hostname` (web). Meist nur Daten-Durchreichung, da `buildUrl` schon mit voller Subdomain umgeht.

## Self-Review

- **Spec-Coverage:** Komponente 2 (Host-Tunnel-Client) → Tasks 1,3,4; Komponente 3 (Origin-Umstellung) → Task 2; Komponenten 1/4/5 (Cloud-Relay-Dienst, Subdomain-Vergabe, Discovery) → bewusst Folge-Scheiben (Cloud/Ops-gated), oben gelistet. Tests (§8 der Spec) → Task 4 (Integration durch lokalen Tunnel + Reconnect).
- **Platzhalter:** keine; rathole-CLI-Flag (`--client`/Config-Modus) ist als „im Code/Doku prüfen" markiert (Implementer verifiziert die exakte rathole-Invocation — kein TODO, sondern eine benannte Verifikation).
- **Typ-Konsistenz:** `renderRatholeClientConfig`/`tunnelComponent`/`relaySubdomain`/`SupervisedProcessSpec` durchgängig gleich über Tasks 1→4.
