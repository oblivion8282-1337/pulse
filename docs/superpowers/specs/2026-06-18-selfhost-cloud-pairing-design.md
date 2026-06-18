# Selfhost ③c — Cloud-Pairing & Verankerung (Design)

**Datum:** 2026-06-18
**Slice:** ③c (von ① Embedded-Backend · ② Erreichbarkeit · ③ Electron-UX [③a Engine, ③b UI, ③c Pairing])
**Status:** Design (autonom entschieden — User-Mandat „bau das ganze Ding fertig, entscheide selbst, frag nur bei echten Hard-Forks"). Kein Emoji. Kein Push auf main ohne Freigabe.

## Ziel

Den letzten Stub von ③a/③b füllen: damit „Server starten" wirklich startet, braucht der Host eine **Cloud-Identität** (instance_id, owner_id, hostname), eine **Relay-Subdomain + Tunnel-Token**, und eine **Probe-URL**. ③c besorgt diese über das bestehende Cloud-Bootstrap, persistiert die Geheimnisse sicher im Main-Prozess, verdrahtet sie in `LocalBackendManager`/Reachability, und verankert die laufende Instanz in der Server-Liste, sodass der User (und seine Freunde) sich verbinden können.

## Was schon existiert (nicht neu bauen)

- **Cloud-API:** `instancesApi.listMyInstances()` → `Instance[]`; `instancesApi.mintBootstrapToken(id)` → `{token, expires_at, ttl_seconds}` (Cookie-Auth, Renderer hat die Session, weil die Electron-App die Cloud-Web-App lädt). `POST /selfhost/bootstrap` (Bearer = bootstrap-token) → `BootstrapCredsOut {instance_id, owner_user_id, hostname, client_id, client_secret, cloud_origin, admin_email, relay_subdomain, relay_server_addr, relay_tunnel_token}`.
- **Backend-Manager:** `manager.start({ userData, identity: FixtureIdentity{hostname,instanceId,ownerId,relaySubdomain?}, relay?: TunnelRelay{serverAddr,authToken,subdomain}, media })`. Relay-Subdomain schaltet automatisch den Public-Origin (JWT/WebAuthn/CORS/MinIO/LiveKit) um.
- **③a-Bridge:** `wireHost` in `main.ts` mit `HostLifecycle` + `host:start/stop/status` + `host:phase`-Push. Stubs `lastIdentity`/`relayCfg`/`probeUrl` (TODO③c).
- **③b-UI:** `LocalHosting.svelte` (ruhige Phasen) + `hostStore` (Runes-Wrapper). `idle` zeigt einen „Server starten"-Knopf.
- **Persistenz:** `window.pulse.store.*` (chmod-600 `<userData>/pulse-stream.json`). `serversStore.add(hostname,label,instance_id)` verankert einen verbindbaren Server.

## Entscheidungen (autonom)

1. **Pairing = ein Klick, nicht sichtbar als eigenes Konzept.** Der „Server starten"-Knopf erledigt bei Bedarf Mint→Redeem→Persist und startet dann. Der User sieht „Pairing" nie als Schritt — passt zum Leitprinzip „intuitiv, menschlich".
2. **Geheimnisse bleiben im Main-Prozess.** Der Renderer ist die *remote* Cloud-Web-App (howispulse.com) — er mintet nur den kurzlebigen (5 Min, single-use) bootstrap-token (braucht die Session-Cookie) und reicht ihn per IPC an Main. **Main** löst ein (`POST /selfhost/bootstrap`), persistiert `BootstrapCredsOut` im chmod-600-Store und gibt dem Renderer **nie** `client_secret`/`relay_tunnel_token` zurück — nur einen sanitisierten Status (`paired`, `hostname`, `instanceId`, `relaySubdomain`).
3. **Drei neue IPC-Methoden** unter `window.pulse.host`: `pair(bootstrapToken) → PairResult`, `getPairing() → PairingStatus` (sanitisiert), `unpair() → void`. `start()`/`stop()`/`onPhase()` bleiben wie ③a.
4. **Instanz-Auswahl:** 0 aktive Instanzen → ruhige Karte „Zuerst einen eigenen Server beantragen" mit Verweis auf den **bestehenden** Antrag (`SelfHostApplication`, weiter unten) — kein Doppel. Genau 1 → automatisch nehmen. >1 → leichter Auswahl-Schritt (Liste der hostnames) vor dem Start.
5. **Verankerung:** Sobald die Phase `live` erreicht ist, fügt der Renderer die Instanz über `serversStore.add(relayUrl, hostname, instanceId)` hinzu (idempotent — vorhandene gleiche `instance_id` nicht doppeln), damit „mein Server" sofort in der Server-Leiste auftaucht und verbindbar ist. Die teilbare Adresse (③b-Live-Karte) ist genau dieser `relayUrl`.
6. **Lebenszyklus:** Hosting läuft weiter, solange die App lebt (auch im Tray — ein Server, der beim Wegklicken stirbt, ist kein Server). Erst echtes Beenden stoppt: `before-quit` ruft `manager.stop()` (heute fehlt das). Kein Auto-Start beim App-Start (der User entscheidet bewusst „starten").
7. **Probe-URL:** `${cloud_origin}/api/auth/selfhost/reachability/probe` — `cloud_origin` kommt aus den Bootstrap-Creds (Default `https://howispulse.com`). Exakten öffentlichen Pfad beim Implementieren gegen `web-nginx.conf`/Router-Prefix verifizieren.

## Datenfluss (ein „Server starten"-Klick, ungepairt)

```
Renderer (cloud web app)                Main (Electron)                 Cloud (auth-svc)
  hostStore.start()
   ├─ getPairing() ───────────────────▶ store: paired? ──┐
   │                                                       │ nein
   ├─ listMyInstances() ─────────────────────────────────────────────▶ GET /me/instances
   │   (0 → "beantragen"-State; 1 → nimm; >1 → Auswahl)
   ├─ mintBootstrapToken(id) ────────────────────────────────────────▶ POST /me/instances/{id}/bootstrap-token
   │                                                                     → { token (plse_boot_*) }
   ├─ host.pair(token) ───────────────▶ POST {cloud}/api/auth/selfhost/bootstrap (Bearer token)
   │                                       → BootstrapCredsOut          ◀────────
   │                                     store.setAll({ pulse.host.creds }) (chmod 600)
   │                                       ◀── PairResult {paired,hostname,instanceId,relaySubdomain}
   ├─ host.start() ───────────────────▶ HostLifecycle.start():
   │                                       identity/relay/probeUrl aus Store
   │                                       manager.start({identity, relay, media:true})
   │                                       → Phasen checking-network…live (push host:phase)
   └─ phase==='live' → serversStore.add(relayUrl, hostname, instanceId)
```

## Sicherheit

- bootstrap-token: kurzlebig + single-use; im Renderer nur transient, nie persistiert.
- `client_secret`/`relay_tunnel_token`: nur in Main, chmod-600-Store, **nie** geloggt, **nie** an den Renderer. `frpc.toml`/Env werden schon mode 0o600 geschrieben.
- `host.pair`-Redeem läuft gegen `cloud_origin` (https erzwungen). Fehler (Token abgelaufen/verbraucht/Netz) → sauberer `PairResult{paired:false,error?}`; der Lifecycle macht aus einem fehlgeschlagenen Start ohnehin `something-paused`.
- `unpair()` löscht die Creds aus dem Store (User wechselt Instanz / meldet sich ab).

## Komponenten & Grenzen

- **Main:** `desktop/electron/localBackend/pairing.ts` (neu) — `redeemBootstrap(token, cloudOrigin)`, `loadCreds()/saveCreds()/clearCreds()` über den Store, `credsToIdentity()`/`credsToRelay()`/`probeUrl()`-Mapper. Reines, testbares Modul (Fetch injizierbar). `wireHost` nutzt es: füllt `lastIdentity`/`relayCfg`/`probeUrl` aus den geladenen Creds; neue Handler `host:pair`/`host:getPairing`/`host:unpair`.
- **Preload + pulse.d.ts:** `host.pair/getPairing/unpair` ergänzen (synchron halten).
- **Renderer:** `hostStore` um `pairing`-State + `ensurePaired()` (mint→pair) erweitern; `LocalHosting.svelte` um den 0/1/>1-Instanz-Fall + die `live`-Verankerung. Neue i18n-Keys (`local_host_*`, warm, kein Jargon).
- **before-quit:** `manager.stop()` (über die Lifecycle/Bridge) beim echten Beenden.

## Testbarkeit

- **Main-Unit (node:test):** `pairing.ts` mit injiziertem Fetch + Fake-Store: Redeem-Happy-Path mappt Creds→identity/relay/probeUrl; Redeem-Fehler → `{paired:false}`; saveCreds→loadCreds round-trip; clearCreds. **Geheimnisse nie im sanitisierten Status.**
- **E2E (Playwright, gemocktes `window.pulse`):** mock `host.pair/getPairing/unpair` + `instancesApi`-Netzwerk (`page.route`): 0-Instanzen-State zeigt „beantragen"; 1-Instanz → start → live → ein neuer Server-Eintrag; ungepairt→gepairt-Übergang.

## Nicht in ③c

- **④** Bezahl-Gate vor „Server starten".
- Tieferer Router-Assistent (③b zeigt die ruhige 3-Schritt-Karte).
- Auto-Start des Hostings beim App-Boot.
