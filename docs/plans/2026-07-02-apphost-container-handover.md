# Handover: App-Hosting Container-Umbau (Stand 2026-07-02)

Übergabe-Dokument, um auf einer anderen Maschine nahtlos weiterzumachen.
Branch: **`feat/apphost-container`** (2 Commits auf frischem main, NICHT gemergt).
Voll-Plan: `docs/superpowers/plans/2026-06-29-apphost-packaging-onebutton-container.md` (Status-Header aktualisiert).

## Was heute passiert ist (2 Blöcke)

### Block 1 — Self-Host-Registry live geschaltet (fertig, auf main + Servern)

`registry.howispulse.com` ist komplett provisioniert und end-to-end bewiesen
(Cert, `REGISTRY_PUSH_TOKEN` in Prod-`.env` + GitHub-Secret, `pulse_registry`-Container,
Caddy-Block, GC-Cron So 04:17, CI-Mirror läuft, Hetzner-Updater umgestellt und
Container von der neuen Registry recreatet). Runbook-Korrekturen via PR #123 auf main.
GHCR `pulse-allinone` ist seitdem **private** (anonym 403). Details/Betrieb:
`infra/prod/DEPLOY.md` → „Self-Host-Registry aktivieren".

### Block 2 — App-Hosting Phase 0+1 (dieser Branch)

Umbau von „7 native Prozesse via uv run" auf „EIN allinone-Container über die
Container-Runtime des Systems". Getroffene **User-Entscheidungen**:
1. frpc **ins allinone-Image** (nicht Host-Sidecar).
2. **`origin`-Spalte** (`vps`|`app_host`) statt Hostname-Heuristik.
3. Win/Mac: Podman wird **mitgebündelt** (Phase 2/3) — v1 nutzt vorhandenes Podman/Docker via Detection.

Commits:
- `a30a53cd` feat(app-hosting): Ein-Knopf-Container statt nativer Prozess-Orchestrierung
- `6e2c33fb` docs(apphost): Plan-Status aktualisieren

Kernstücke (Datei-Wegweiser):
- **Image:** `infra/self-host/Dockerfile` (frpc 0.69.1, SHA-gepinnt) ·
  `infra/self-host/s6/etc/s6-overlay/scripts/11-render-frpc.sh` (rendert `/etc/pulse/frpc.toml`
  aus `PULSE_RELAY_{SUBDOMAIN,SERVER_ADDR,TUNNEL_TOKEN}`; erzwingt `PULSE_TLS_MODE=behind-proxy`) ·
  s6-Unit `s6-rc.d/frpc/` (ohne Relay-Vars: `sleep infinity`, coturn-Muster).
  **Gotcha:** `loginFailExit = false` in der frpc.toml ist PFLICHT — sonst exitet frpc bei
  Login-Fehler im Sekundentakt und das restart-gate (5 Crashes/60s) halted den GANZEN Container.
- **Auth:** Migration `20260702_0040_instances_origin.py` (Backfill `hostname ~ '^app-[0-9]+\.'`);
  `instance_provisioning.py` setzt `origin="app_host"`, Guard `user_has_active_owner_instance`
  zählt nur noch app_host (VPS-Besitzer bekommen sonst nie eine App-Host-Instanz);
  `routes_instance_applications.py` liefert `origin` in `InstanceOut`.
- **Desktop:** `desktop/electron/localBackend/containerRuntime.ts` (Detection:
  Flatpak→`flatpak-spawn --host podman` → bundled podman (`resources/podman/`, Seam für Phase 2/3)
  → PATH podman → docker; exec ohne Shell) · `containerBackendManager.ts`
  (container.env 0600 → `login registry.howispulse.com` mit Instanz-Creds via --password-stdin →
  pull → recreate `pulse-host` + Named Volume `pulse-host-data` → Health-Poll auf
  `127.0.0.1:55580/api/chat/health`, 240s). GELÖSCHT: localBackendManager, process, postgres,
  components, media, migrations, secrets, renderConfig, tunnel, paths, types + deren Tests +
  `smoke-controlplane.ts`. `pairing.ts` um credsToIdentity/credsToRelay geschrumpft.
  Neues IPC `host:runtime` → `window.pulse.host.runtimeAvailable()` (preload + pulse.d.ts synchron).
- **Web:** `featureFlags.ts` → `APP_HOSTING_ENABLED = true` · `hostStore.svelte.ts` (`runtimeOk`,
  Instanz-Filter auf `origin === 'app_host'`) · `LocalHosting.svelte` (Zustand
  `local-host-no-runtime` mit Setup-Hinweis) · `MyInstances.svelte` (filtert app_host raus) ·
  Messages `local_host_runtime_missing_*` (de+en).
- **Flatpak:** `packaging/com.howispulse.Pulse.yml` + `--talk-name=org.freedesktop.Flatpak`.

## Verifikations-Stand

- allinone-Image lokal gebaut + gebootet: **mit** Relay-Dummy-Vars erreicht frpc den echten
  frps auf dem netcup („unauthorized relay login" = Kette Container→frps→Plugin→auth-svc ok),
  Container bleibt healthy; **ohne** Relay-Vars schläft die frpc-Unit.
- pytest auth: 457 grün (inkl. neuer Test `test_approve_provisions_despite_vps_instance`).
- `pnpm check` 0/0, `pnpm build` grün, `build:electron` grün.
- Desktop `node --test`: 45/46 — der Fail ist `reachability.int.test.ts` (UDP-Probe),
  **vorbestehend/umgebungsbedingt** (failt auch auf gestashtem Basis-Stand).
- Simplifier gelaufen (1 DRY-Refactor: `ensureRuntime()`-Helper), gestempelt.

## Offene Punkte (in Reihenfolge)

1. **Changelog-Eintrag** vor Push auf main (CI-Gate). Stil-Vorschläge liegen beim User
   (Vorschlag 1 „Sachlich": „Eigenen Server direkt aus der App hosten: Ein Knopf startet
   deinen persönlichen Pulse-Server auf deinem Gerät — erreichbar für Freunde über eine
   sichere Relay-Adresse. Braucht Podman oder Docker auf dem Gerät; die App sagt dir,
   wenn etwas fehlt.").
2. **GUI-E2E lokal** (vor Merge!): `scripts/dev-up.fish`, dann in der Desktop-App
   Account-Einstellungen → App-Hosting: Antrag → als Owner genehmigen → Start-Knopf.
   Achtung: früherer Versuch (2026-06-23, alte Architektur) hing am Reachability-Gate
   (`unknown→paused`) — falls das wieder auftritt, liegt es an der STUN/Probe-Diagnose
   (`reachability.ts`), nicht am Container-Pfad. Dev-Pairing läuft gegen die lokale Cloud
   (`PULSE_DEV_URL`), das Image kommt aber von `registry.howispulse.com` (echte Instanz-Creds
   nötig) — für reine Container-Tests ohne Cloud: Image lokal bauen
   (`docker build -f infra/self-host/Dockerfile -t pulse-allinone:dev .`) und in
   `containerBackendManager.ts` `IMAGE` temporär umbiegen.
3. **Merge = Deploy-Effekte:** allinone.yml baut das Image mit frpc (kein paths-Filter,
   läuft bei jedem main-Push) und mirrort zur Registry; die Web-App zeigt die
   App-Hosting-Karte (Flag an). Self-Host-VPS-Bestand ist unberührt (Relay-Vars fehlen dort).
4. **Phase 2 Windows:** podman.exe + gvproxy in den NSIS-Installer, WSL2-Erststart-Assistent
   (`wsl --install`, Admin+Reboot-Pfad), `podman machine init/start`; `containerRuntime.ts`
   hat den Bundled-Seam schon (`resources/podman/`). Braucht Windows-Maschine.
5. **Phase 3 Mac:** podman + applehv/vfkit bündeln, Signierung/Notarisierung. Braucht Mac.
6. **v1.1-Idee (vertagt):** CGNAT = heute „not-possible-here"; der Relay-Tunnel ist aber
   outbound → „Chat-only-Hosting hinter CGNAT" wäre machbar (Voice/Streams bleiben aus).

## Betriebs-Notizen (Registry, falls dort etwas klemmt)

- Token-Endpoint 500 `jwt_cert_file fehlt/unlesbar` → `.env` braucht
  `JWT_CERT_FILE=/secrets/jwt_public.crt` + auth recreaten.
- GC-Cron-Volume heißt `pulse_pulse_registry` (Compose-Prefix!).
- Bei JWT-Key-Rotation: Cert neu erzeugen + Registry redeployen (DEPLOY.md).
