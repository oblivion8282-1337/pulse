# Selfhost ③c — Cloud-Pairing & Verankerung Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** „Server starten" wirklich starten lassen — der Host holt sich via Cloud-Bootstrap Identität + Relay-Subdomain + Tunnel-Token, persistiert die Geheimnisse sicher im Main-Prozess, verdrahtet sie in `LocalBackendManager`/Reachability und verankert die laufende Instanz in der Server-Liste.

**Architecture:** Renderer (authentifizierte Cloud-Web-App) mintet den kurzlebigen bootstrap-token und reicht ihn per IPC an Main; **Main** löst ein (`POST /selfhost/bootstrap`), persistiert `BootstrapCredsOut` im chmod-600-Store und gibt nie Geheimnisse an den Renderer. Ein reines `pairing.ts`-Modul kapselt Redeem + Mapper + Store-I/O. `wireHost` füllt aus den Creds die ③a-Stubs. Beim Erreichen von `live` verankert der Renderer die Instanz in `serversStore`.

**Tech Stack:** Electron-Main (TS, esbuild, node:test), Svelte 5 Runes, Paraglide-i18n, Playwright. Node-global `fetch` (Electron 42 / Node 22). Keine neue Dependency.

## Global Constraints

- **Baut auf ③a+③b** (Branch `feat/selfhost-host-ui`). ③c stackt darauf.
- **Geheimnisse (`client_secret`, `relay_tunnel_token`) nie an den Renderer, nie ins Log.** Sanitisierter Status only: `{paired, hostname?, instanceId?, relaySubdomain?}`.
- **Keine neue Dependency. Keine Emojis. Svelte-Component ≤250 Z., Source ≤350 Z.**
- **i18n:** neue Texte über `m.local_host_*`-Keys, de+en gepflegt, warm, kein Technik-Jargon.
- **Öffentliche Cloud-Pfade:** Bootstrap-Redeem `${cloudOrigin}/api/auth/selfhost/bootstrap` (Bearer = bootstrap-token); Probe `${cloudOrigin}/api/auth/selfhost/reachability/probe`. `cloudOrigin` aus den Creds (Default `https://howispulse.com`).
- **Verifikation gesamt:** `cd desktop && pnpm run build:electron` (clean) + `pnpm test:unit` (grün); `cd web && pnpm check` (0/0) + `pnpm build` + `pnpm exec playwright test local-hosting`.
- Kein Push auf main ohne Freigabe.

## Bekannte Typen (aus der Exploration, NICHT neu erfinden)

- `BootstrapCredsOut` (Antwort von `/selfhost/bootstrap`): `{ instance_id: string; owner_user_id: string; hostname: string; client_id: string; client_secret: string; cloud_origin: string; admin_email: string|null; relay_subdomain: string|null; relay_server_addr: string|null; relay_tunnel_token: string|null }`.
- `FixtureIdentity` (renderConfig.ts): `{ hostname: string; instanceId: string; ownerId: string; relaySubdomain?: string }`.
- `TunnelRelay` (tunnel.ts): `{ serverAddr: string; authToken: string; subdomain: string }`.
- `StartInput` (localBackendManager.ts): `{ userData: string; identity: FixtureIdentity; relay?: TunnelRelay; media?: boolean; ... }`.
- Renderer-API (`web/src/lib/api/instances.ts`): `instancesApi.listMyInstances(): Promise<Instance[]>` (`Instance.{id,hostname,status,...}`), `instancesApi.mintBootstrapToken(id): Promise<{token,expires_at,ttl_seconds}>`.
- `serversStore.add(hostname, label?, instance_id?, pairwise_sub?): ServerEntry` + `serversStore.servers: ServerEntry[]` (`ServerEntry.instance_id`).
- ③a-Bridge in `desktop/electron/main.ts::wireHost`, Store-Helfer in `desktop/electron/store.ts` (`storeGet`/`storeSet`), `ALLOWED_STORE_KEYS`.
- `HostPhaseEvent.detail.relayUrl` wird auf `live` bereits gepusht.

---

### Task 1: `pairing.ts` — Redeem + Mapper + Store-I/O (Main, reines Modul)

**Files:**
- Create: `desktop/electron/localBackend/pairing.ts`
- Test: `desktop/test/localBackend/pairing.test.ts` (unter `test/localBackend/`, damit der `test:unit`-Glob `test/localBackend/*.test.ts` ihn automatisch findet)

**WICHTIG (node:test-Konventionen):** Importe MIT `.ts`-Endung (Node strip-only), z.B. `from '../../electron/localBackend/pairing.ts'`. Lauf-Kommando: `cd desktop && pnpm test:unit` (kein tsx). `pairing.ts` darf KEINE Electron-Imports haben (sonst bricht node:test).

**Interfaces:**
- Consumes: Node-`fetch` (injizierbar), eine `StoreLike`-Schnittstelle `{ get(k): unknown; set(k, v): void }`, `FixtureIdentity`/`TunnelRelay` (importiert aus `./renderConfig`/`./tunnel`).
- Produces:
  - `interface BootstrapCreds { instanceId; ownerId; hostname; clientId; clientSecret; cloudOrigin; relaySubdomain: string|null; relayServerAddr: string|null; relayTunnelToken: string|null }` (camelCase, intern).
  - `interface PairingStatus { paired: boolean; hostname?: string; instanceId?: string; relaySubdomain?: string|null }` (sanitisiert — KEINE Secrets).
  - `interface PairResult { paired: boolean; error?: string; status?: PairingStatus }`.
  - `const HOST_CREDS_KEY = 'pulse.host.creds'`.
  - `async function redeemBootstrap(token: string, cloudOrigin: string, fetchImpl?: typeof fetch): Promise<BootstrapCreds>` — POSTet `${cloudOrigin}/api/auth/selfhost/bootstrap` mit `Authorization: Bearer ${token}`, mappt die snake_case-Antwort → `BootstrapCreds`. Wirft bei !ok / Netzfehler.
  - `function credsToIdentity(c: BootstrapCreds): FixtureIdentity`.
  - `function credsToRelay(c: BootstrapCreds): TunnelRelay | undefined` (undefined wenn `relaySubdomain`/`relayServerAddr`/`relayTunnelToken` fehlen).
  - `function probeUrl(c: BootstrapCreds): string` → `${c.cloudOrigin}/api/auth/selfhost/reachability/probe`.
  - `function sanitize(c: BootstrapCreds | null): PairingStatus` → `{paired:false}` bei null, sonst `{paired:true,hostname,instanceId,relaySubdomain}`.
  - `function loadCreds(store: StoreLike): BootstrapCreds | null` · `function saveCreds(store: StoreLike, c: BootstrapCreds): void` · `function clearCreds(store: StoreLike): void` (über `HOST_CREDS_KEY`).

- [ ] **Step 1: Write failing tests** — `desktop/test/pairing.test.ts` (node:test):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  redeemBootstrap, credsToIdentity, credsToRelay, probeUrl, sanitize,
  loadCreds, saveCreds, clearCreds, HOST_CREDS_KEY, type BootstrapCreds,
} from '../../electron/localBackend/pairing.ts';

const SAMPLE = {
  instance_id: '123', owner_user_id: '7', hostname: 'mein-pc',
  client_id: 'cid', client_secret: 'SECRET', cloud_origin: 'https://howispulse.com',
  admin_email: 'a@b.c', relay_subdomain: 'brave-otter-4f2a.relay.howispulse.com',
  relay_server_addr: 'relay.howispulse.com:2333', relay_tunnel_token: 'plse_relay_x',
};

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300, status,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

test('redeemBootstrap maps snake_case → camelCase creds', async () => {
  const c = await redeemBootstrap('plse_boot_x', 'https://howispulse.com', fakeFetch(200, SAMPLE));
  assert.equal(c.instanceId, '123');
  assert.equal(c.ownerId, '7');
  assert.equal(c.clientSecret, 'SECRET');
  assert.equal(c.relaySubdomain, 'brave-otter-4f2a.relay.howispulse.com');
});

test('redeemBootstrap throws on non-ok', async () => {
  await assert.rejects(() => redeemBootstrap('t', 'https://x', fakeFetch(401, { detail: 'consumed' })));
});

test('credsToIdentity / credsToRelay / probeUrl', () => {
  const c = { ...SAMPLE } as unknown as BootstrapCreds;
  // build a real camelCase creds via redeem-shape:
  const creds: BootstrapCreds = {
    instanceId: '123', ownerId: '7', hostname: 'mein-pc', clientId: 'cid',
    clientSecret: 'S', cloudOrigin: 'https://howispulse.com',
    relaySubdomain: 'sub.relay.x', relayServerAddr: 'relay.x:2333', relayTunnelToken: 'plse_relay_x',
  };
  assert.deepEqual(credsToIdentity(creds), { hostname: 'mein-pc', instanceId: '123', ownerId: '7', relaySubdomain: 'sub.relay.x' });
  assert.deepEqual(credsToRelay(creds), { serverAddr: 'relay.x:2333', authToken: 'plse_relay_x', subdomain: 'sub.relay.x' });
  assert.equal(probeUrl(creds), 'https://howispulse.com/api/auth/selfhost/reachability/probe');
  void c;
});

test('credsToRelay returns undefined without relay fields', () => {
  const creds = { instanceId: '1', ownerId: '2', hostname: 'h', clientId: 'c', clientSecret: 'S', cloudOrigin: 'https://x', relaySubdomain: null, relayServerAddr: null, relayTunnelToken: null } as BootstrapCreds;
  assert.equal(credsToRelay(creds), undefined);
});

test('sanitize never leaks secrets', () => {
  const creds = { instanceId: '1', ownerId: '2', hostname: 'h', clientId: 'c', clientSecret: 'SECRET', cloudOrigin: 'https://x', relaySubdomain: 'sub', relayServerAddr: 'a', relayTunnelToken: 'plse_relay_SECRET' } as BootstrapCreds;
  const s = sanitize(creds);
  assert.equal(s.paired, true);
  assert.equal(JSON.stringify(s).includes('SECRET'), false);
  assert.deepEqual(sanitize(null), { paired: false });
});

test('saveCreds → loadCreds round-trip + clearCreds', () => {
  const mem = new Map<string, unknown>();
  const store = { get: (k: string) => mem.get(k), set: (k: string, v: unknown) => void mem.set(k, v) };
  const creds = { instanceId: '1', ownerId: '2', hostname: 'h', clientId: 'c', clientSecret: 'S', cloudOrigin: 'https://x', relaySubdomain: null, relayServerAddr: null, relayTunnelToken: null } as BootstrapCreds;
  saveCreds(store, creds);
  assert.deepEqual(loadCreds(store), creds);
  clearCreds(store);
  assert.equal(loadCreds(store), null);
});
```

- [ ] **Step 2: Run, verify fail** — `cd desktop && pnpm test:unit`. Expected: FAIL (module not found / pairing.ts existiert noch nicht).

- [ ] **Step 3: Implement** — `desktop/electron/localBackend/pairing.ts`. Reines Modul, keine Electron-Imports. `redeemBootstrap` nutzt `(fetchImpl ?? fetch)`, parst `text()` → JSON, mappt Felder; bei `!resp.ok` `throw new Error(detail ?? status)`. Store-I/O über die schmale `StoreLike`-Schnittstelle (JSON-serialisierbares Objekt unter `HOST_CREDS_KEY`). **Nie loggen.**

- [ ] **Step 4: Run, verify pass** — `cd desktop && pnpm test:unit` grün (6 neue Tests + die bestehenden).

- [ ] **Step 5: Commit** — `git commit -m "feat(desktop): pairing.ts — Bootstrap-Redeem + Creds-Mapper + Store-I/O"`

---

### Task 2: `wireHost` füllt die ③a-Stubs + IPC pair/getPairing/unpair + before-quit

**Files:**
- Modify: `desktop/electron/main.ts` (`wireHost`, `ALLOWED_STORE_KEYS`, before-quit)
- Modify: `desktop/electron/preload.ts` (host-Namespace)
- Modify: `web/src/lib/platform/pulse.d.ts` (PulseHostApi + Typen)

**Interfaces:**
- Consumes: `pairing.ts` (Task 1), `storeGet`/`storeSet` aus `./store`.
- Produces (IPC + preload + d.ts, synchron):
  - `host.pair(bootstrapToken: string): Promise<PairResult>` — Main redeemt + speichert, gibt sanitisierten Status.
  - `host.getPairing(): Promise<PairingStatus>`.
  - `host.unpair(): Promise<void>`.
  - `start`/`stop`/`getStatus`/`onPhase` unverändert.

- [ ] **Step 1: `ALLOWED_STORE_KEYS`** — `'pulse.host.creds'` zur Allowlist in `main.ts` hinzufügen (sonst lehnt `store:set` den Key ab).

- [ ] **Step 2: `wireHost` umbauen** — `main.ts`. Eine schmale `StoreLike`-Bindung an `store.ts`: `const hostStore = { get: storeGet, set: (k,v) => storeSet(k,v) }`. Beim Start `let creds = loadCreds(hostStore)`. Die `HostDeps` aus `creds` ableiten (statt der TODO-Stubs):

```ts
import {
  redeemBootstrap, loadCreds, saveCreds, clearCreds,
  credsToIdentity, credsToRelay, probeUrl, sanitize,
} from './localBackend/pairing';

function wireHost(getWin: () => Electron.BrowserWindow | null): void {
  const manager = new LocalBackendManager();
  const hostStore = { get: storeGet, set: (k: string, v: unknown) => storeSet(k, v) };
  let creds = loadCreds(hostStore);

  const deps: HostDeps = {
    startBackend: async ({ media }) => {
      if (!creds) throw new Error('host not paired yet');
      await manager.start({
        userData: app.getPath('userData'),
        identity: credsToIdentity(creds),
        relay: credsToRelay(creds),
        media,
      });
    },
    stopBackend: () => manager.stop(),
    checkReachability: async () => {
      const r = await checkReachability({ probeUrl: creds ? probeUrl(creds) : '' });
      return { verdict: r.verdict, publicIp: r.publicIp };
    },
    mapPorts: async (stunIp) => {
      const r = await mapMediaPorts({ stunIp });
      return { verdict: r.verdict, openPorts: r.openPorts, failedPorts: r.failedPorts };
    },
    relayUrl: () => (creds?.relaySubdomain ? `https://${creds.relaySubdomain}` : null),
  };
  const hl = new HostLifecycle(deps);
  hl.onPhase((e) => getWin()?.webContents.send('host:phase', e));

  ipcMain.handle('host:start', () => hl.start());
  ipcMain.handle('host:stop', () => hl.stop());
  ipcMain.handle('host:status', () => hl.getStatus());
  ipcMain.handle('host:pair', async (_e, token: unknown) => {
    if (typeof token !== 'string' || !token) return { paired: false, error: 'invalid token' };
    try {
      const cloudOrigin = creds?.cloudOrigin ?? 'https://howispulse.com';
      const fresh = await redeemBootstrap(token, cloudOrigin);
      saveCreds(hostStore, fresh);
      creds = fresh;
      return { paired: true, status: sanitize(fresh) };
    } catch (e) {
      // NIE die Fehlermeldung mit Token/Secret anreichern
      return { paired: false, error: e instanceof Error ? e.message : 'pairing failed' };
    }
  });
  ipcMain.handle('host:getPairing', () => sanitize(creds));
  ipcMain.handle('host:unpair', () => {
    clearCreds(hostStore);
    creds = null;
  });

  // Lebenszyklus: beim echten Beenden den Stack sauber stoppen (läuft sonst im Tray weiter).
  app.on('before-quit', () => { void manager.stop(); });
}
```

  (Hinweis: das bestehende `before-quit` für den GSR-Sidecar bleibt; ein zweiter Listener ist additiv und ok. `manager.stop()` muss idempotent/fehlertolerant sein — ist es laut ① bereits.)

- [ ] **Step 3: preload.ts** — den `host`-Namespace um `pair`/`getPairing`/`unpair` erweitern (analog `start`/`stop`/`getStatus` über `ipcRenderer.invoke`), `onPhase` unverändert.

- [ ] **Step 4: pulse.d.ts** — `PulseHostApi` + neue Typen `PairingStatus`/`PairResult` ergänzen:

```ts
export interface PairingStatus { paired: boolean; hostname?: string; instanceId?: string; relaySubdomain?: string | null; }
export interface PairResult { paired: boolean; error?: string; status?: PairingStatus; }
// in PulseHostApi:
pair(bootstrapToken: string): Promise<PairResult>;
getPairing(): Promise<PairingStatus>;
unpair(): Promise<void>;
```
  Den `HostStartOpts`-TODO(③c)-Kommentar bereinigen (start nimmt jetzt keine Pflichtfelder mehr — `start(opts?: HostStartOpts)` bleibt rückwärtskompatibel).

- [ ] **Step 5: Verify** — `cd desktop && pnpm run build:electron` (clean) + `pnpm test:unit` (alle grün, inkl. Task-1-Tests). `cd web && pnpm check` (0/0 — die d.ts-Typen greifen).

- [ ] **Step 6: Commit** — `git commit -m "feat(desktop): wireHost füllt Identität/Relay/Probe aus Pairing + IPC pair/getPairing/unpair"`

---

### Task 3: hostStore-Pairing + LocalHosting-Instanzwahl + Live-Verankerung

**Files:**
- Modify: `web/src/lib/host/hostStore.svelte.ts`
- Modify: `web/src/lib/components/account/LocalHosting.svelte`
- Modify: `web/messages/de.json` + `web/messages/en.json`

**Interfaces:**
- Consumes: `window.pulse.host.{pair,getPairing,unpair,start}` (Task 2); `instancesApi.listMyInstances`/`mintBootstrapToken` (`$lib/api/instances`); `serversStore` (`$lib/api/servers.svelte`).
- Produces (hostStore):
  - `pairing = $state<PairingStatus | null>(null)`; `instances = $state<{id:string;hostname:string}[]>([])` (nur `status==='active'`).
  - `get paired(): boolean`; `get canHost(): boolean` (`paired || instances.length>=1`); `get needsChoice(): boolean` (`!paired && instances.length>1`).
  - `init()`: zusätzlich `getPairing()` → `pairing`, und (desktop) `listMyInstances()` → aktive `instances` (Fehler still → leer).
  - `async start(instanceId?: string)`: wenn `!paired` → `id = instanceId ?? instances[0]?.id` (ohne id → return, kein Start), `mintBootstrapToken(id)` → `host.pair(token)` → bei `paired` `pairing = res.status`; danach `host.start()`. Bei Pair-Fehler: `pairing` unverändert, der Lifecycle bleibt `idle` (Component zeigt eine ruhige Fehlerzeile).
  - `async anchorLive()`: nach `phase==='live'` aufrufen — `const p = pairing`; wenn `p?.relaySubdomain` und nicht bereits in `serversStore.servers` mit gleicher `instance_id`: `serversStore.add('https://'+p.relaySubdomain, p.hostname, p.instanceId)`.

- [ ] **Step 1: i18n-Keys** — in `de.json` + `en.json` ergänzen (warm, kein Jargon, keine Emojis): `local_host_no_instance_title`, `local_host_no_instance_body` (verweist auf den Antrag weiter unten — z.B. „Du brauchst zuerst einen eigenen Server. Den beantragst du gleich hier unten."), `local_host_choose_instance` („Welchen Server möchtest du starten?"), `local_host_pair_failed` („Das hat gerade nicht geklappt — versuch es noch einmal."), `local_host_server_added` („Dein Server ist jetzt in deiner Liste.").

- [ ] **Step 2: hostStore erweitern** — `hostStore.svelte.ts` um die obigen States/Getter/Methoden. `init()` ruft `getPairing()` + `listMyInstances()` (in try/catch, desktop-gated über `available`). Imports: `instancesApi` aus `$lib/api/instances`, `serversStore` aus `$lib/api/servers.svelte`, `PairingStatus` aus `$lib/platform/pulse`. **Keine Secrets** — nur die sanitisierten Felder. Datei bleibt klein (< 350 Z.).

- [ ] **Step 3: LocalHosting.svelte erweitern** — den `idle`-Zweig aufteilen:
  - `hostStore.instances.length === 0` (und `!paired`) → ruhige Karte `local_host_no_instance_*` (kein Button, Verweis nach unten auf `SelfHostApplication`). `data-testid="local-host-no-instance"`.
  - `hostStore.needsChoice` → kleine Auswahl (ein `<select>` oder Liste der hostnames) + „Server starten" → `hostStore.start(chosenId)`. `data-testid="local-host-choose"`.
  - sonst → der bestehende „Server starten"-Knopf → `hostStore.start()`.
  - Ein `$effect`, der bei `hostStore.phase === 'live'` einmalig `hostStore.anchorLive()` ruft und `toast.success(m.local_host_server_added())` zeigt (nur beim Übergang nach live, nicht wiederholt).
  - Wenn die Component dadurch > 250 Z. wird: den idle-Block in eine `LocalHostingIdle.svelte` auslagern. Bestehende `data-testid`s + Phasen-UI unverändert.

- [ ] **Step 4: Verify** — `cd web && pnpm check` (0/0) + `pnpm build` (grün).

- [ ] **Step 5: Commit** — `git commit -m "feat(web): Cloud-Pairing im hostStore + Instanzwahl/Verankerung in LocalHosting"`

---

### Task 4: E2E — Pairing + Verankerung gegen gemocktes window.pulse + instances-API

**Files:**
- Modify: `web/tests/e2e/local-hosting.spec.ts`

**Interfaces:**
- Consumes: das gemockte `window.pulse` (platform 'electron' + host) aus dem bestehenden Spec; zusätzlich `host.pair/getPairing/unpair`-Mocks + `page.route('**/me/instances', …)` + `page.route('**/me/instances/*/bootstrap-token', …)`.

- [ ] **Step 1: Mock erweitern** — im `addInitScript` das `host`-Objekt um `getPairing` (liefert `{paired:false}` initial, nach `pair` `{paired:true,hostname:'mein-pc',instanceId:'123',relaySubdomain:'brave-otter.relay.howispulse.com'}`), `pair(token)` (setzt internen paired-State, gibt `{paired:true,status:{…}}`), `unpair` ergänzen. `page.route` für `GET /api/auth/me/instances` (Liste mit 1 aktiven Instanz `{id:'123',hostname:'mein-pc',status:'active',…}`) + `POST /api/auth/me/instances/123/bootstrap-token` (`{token:'plse_boot_x',expires_at:'…',ttl_seconds:300}`).

- [ ] **Step 2: Tests** (Assertions NICHT abschwächen):
  - **0 Instanzen:** `page.route` Liste leer → idle zeigt `local-host-no-instance` (kein Start-Button).
  - **1 Instanz, ungepairt → start → live → Verankerung:** `local-host-start` klicken → Mock feuert `checking-network`…`live` (relayUrl) → `local-host-live` + `local-host-url` sichtbar; danach taucht ein neuer Server-Eintrag auf (prüfbar via `serversStore` über `page.evaluate`-Import wie in `server-vault.spec.ts`, ODER über ein sichtbares Server-Listen-Element). Der `pair`-Mock wurde aufgerufen (Flag im Mock setzen, via `page.evaluate` auslesen).
  - (Mehrfach-Instanz-Auswahl ist optional als zusätzlicher Test; Mindestumfang sind die zwei obigen.)

- [ ] **Step 3: Verify** — `cd web && pnpm check` (0/0) + `pnpm build` + `pnpm exec playwright test local-hosting` (grün; bei Cold-Start-Timeout 1× neu, bekannte Infra-Eigenheit).

- [ ] **Step 4: Commit** — `git commit -m "feat(web): E2E — Cloud-Pairing-Flow + Server-Verankerung"`

---

## Folge-Scheiben (NICHT in ③c)

- **④:** Bezahl-Gate vor „Server starten".
- Tieferer Router-Assistent (über die ruhige 3-Schritt-Karte hinaus).
- Auto-Start des Hostings beim App-Boot (bewusst weggelassen).

## Self-Review

- **Spec-Coverage:** Redeem+Mapper+Store (Task 1) · Stub-Füllung+IPC+before-quit (Task 2) · Pairing-Logik+Instanzwahl+Verankerung (Task 3) · E2E (Task 4). Sicherheit (Secrets nur in Main, sanitize) in Task 1 getestet + Task 2 erzwungen.
- **Kein Doppel:** 0-Instanzen-Fall verweist auf den bestehenden `SelfHostApplication` statt eines zweiten Antrags-Flows; Pairing ist unsichtbar in „Server starten" gefaltet.
- **Platzhalter:** keine TBD; das node:test-Kommando ist als „etabliertes `test:unit`/`node --test`" markiert (Implementer nutzt das im Repo vorhandene).
- **Typ-Konsistenz:** `BootstrapCreds`/`PairingStatus`/`PairResult` zwischen Task 1↔2↔3; `host.pair/getPairing/unpair` zwischen preload↔pulse.d.ts↔hostStore↔E2E; `serversStore.add`-Signatur wie exploriert.
