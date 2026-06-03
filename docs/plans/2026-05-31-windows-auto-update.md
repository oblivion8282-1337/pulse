# Windows-.exe Auto-Update Implementation Plan

**Goal:** Die Windows-Desktop-App von einer portablen Einzel-.exe auf einen NSIS-Installer mit Selbst-Aktualisierung (electron-updater, generic-Feed auf howispulse.com) umstellen — Discord-Stil: In-App-Banner „Update bereit – neu starten", sonst Auto-Install beim nächsten App-Schließen.

**Architecture:** electron-updater (`autoUpdater`, generic provider) prüft beim Start gegen `https://howispulse.com/updates/win/latest.yml`, lädt das Update automatisch herunter, meldet den Fortschritt über eine neue `window.pulse.updates`-IPC-Bridge an den Renderer. Der Renderer zeigt ein sonner-Banner mit „Neu starten"-Button (`quitAndInstall`). Der CI-Workflow baut den NSIS-Installer + `latest.yml`/`.blockmap` und rsynct sie auf den VPS (gleiches Muster wie Flatpak); nginx serviert `/updates/win/` aus einem bind-gemounteten Host-Ordner.

**Tech Stack:** electron-updater 6.x (neue Runtime-Dep, vom User genehmigt), electron-builder 26.0.12 (schon da), NSIS, sonner (Banner), GitHub Actions + rsync.

**Entscheidungen (vom User bestätigt):** NSIS-only (portable ersetzen) · Banner+Quit-Fallback (`autoInstallOnAppQuit`) · generic-Feed auf howispulse.com/updates/win/ · vorerst unsigniert (`signAndEditExecutable: false`).

---

## Verifizierte Muster (kein Raten)

- **electron-updater-API** (gegen offizielle Doku gecheckt): `import { autoUpdater } from "electron-updater"`; Events `checking-for-update` / `update-available` / `update-not-available` / `download-progress` / `update-downloaded` / `error`; `autoUpdater.checkForUpdates()`; `quitAndInstall(isSilent=false, isForceRunAfter=false)`; `autoDownload` + `autoInstallOnAppQuit` Default `true`. Läuft NUR bei `app.isPackaged` (nicht in dev).
- **Wiring-Muster:** `wireX(() => mainWindow)` in `app.whenReady()` — Vorbild `wireNotify(() => mainWindow)` (`main.ts:413`), Modul `notify.ts`. Updater kommt in neue `updater.ts` (main.ts ist bei 452 Z, Hard-Cap 500).
- **Preload-Bridge-Muster:** `ipcRenderer.invoke(...)` für Calls, `ipcRenderer.on(channel, handler)` + Unsubscribe-Rückgabe für Events (Vorbild `gsr.onEvent` / `notify.onClick`). `pulse.d.ts` synchron halten.
- **Renderer-Subscription:** `+layout.svelte` onMount, `isElectron()`-gated (Z.71ff, neben `invite.onLink`). Toast-System = sonner (`Toaster` schon in `+layout.svelte:108` gemountet).
- **Deploy-Muster:** `flatpak.yml` rsynct via Secrets `VPS_SSH_PRIVATE_KEY` + `VPS_KNOWN_HOSTS` nach `michael@159.195.150.54:pulse/flatpak-repo/`; nginx `location ^~ /flatpak/ { alias /srv/flatpak-repo/; }` + docker-compose bind-mount `${HOME}/pulse/flatpak-repo:/srv/flatpak-repo:ro`. → Win-Updates 1:1 gespiegelt nach `pulse/updates-win/` → `/srv/updates-win/` → `/updates/win/`.

---

## Task 1: electron-builder.yml portable → NSIS + generic publish

**Files:** Modify `desktop/electron-builder.yml`, `desktop/package.json`

- `desktop/package.json`: `electron-updater` als **dependencies** (Runtime, nicht devDep) hinzufügen. Version `^6.3.9` (electron-updater 6.x). Da `main.cjs` esbuild-gebündelt ist und `electron-updater` `--external` bleiben muss (dynamic requires in `builder-util-runtime`), kommt das Modul über `node_modules` in die asar — siehe Task 1b.
- `electron-builder.yml`: `win.target: portable` → `win.target: nsis`. `portable:`-Block entfernen, `nsis:`-Block hinzufügen:
  ```yaml
  nsis:
    oneClick: true            # Discord-Stil: kein Wizard, per-User-Install
    perMachine: false         # per-User → kein UAC-Prompt, kein Admin nötig
    artifactName: Pulse-Setup-${version}.exe
    deleteAppDataOnUninstall: false
  publish:
    provider: generic
    url: https://howispulse.com/updates/win/
  ```
- `signAndEditExecutable: false` bleibt (unsigniert, Entscheidung 4).

**Verifikation:** `cd desktop && pnpm install` läuft durch (electron-updater im Lockfile). Voller `dist:win`-Build ist Windows-only → CI (Task 5).

## Task 1b: electron-updater im esbuild-Bundle externalisieren + in asar bringen

**Files:** Modify `desktop/package.json` (build:electron-Script), `desktop/electron-builder.yml` (files)

- `build:electron`-Script: `--external:electron-updater` ergänzen (sonst zieht esbuild die dynamic requires rein und bricht).
- `electron-builder.yml` `files:` um `node_modules/electron-updater/**/*` + dessen Transitiv-Deps erweitern. **ACHTUNG Lackmustest:** electron-builder zieht `dependencies` (nicht devDeps) automatisch in die asar, wenn sie nicht in `files`-Excludes stehen — d.h. mit electron-updater als `dependencies` reicht ggf. der Default. Erster CI-Build zeigt, ob ein expliziter `files`-Eintrag nötig ist. Falls Build „Cannot find module 'electron-updater'" wirft → expliziten Eintrag nachziehen.

## Task 2: desktop/electron/updater.ts (neu) + main.ts-Wiring

**Files:** Create `desktop/electron/updater.ts`, Modify `desktop/electron/main.ts`

`updater.ts` (Vorbild `notify.ts`):
```typescript
/**
 * Pulse desktop shell — Auto-Update (electron-updater, generic feed).
 *
 * Prüft beim Start gegen https://howispulse.com/updates/win/latest.yml (Feed-URL
 * aus electron-builder.yml `publish:` → landet als app-update.yml in resources/).
 * autoDownload=true (Default) lädt das Update sofort; bei `update-downloaded`
 * schicken wir ein `updates:ready`-Event an den Renderer, der ein Banner zeigt.
 * Klickt der User „Neu starten" → `updates:restart` → quitAndInstall(). Sonst
 * installiert autoInstallOnAppQuit (Default true) beim nächsten App-Beenden.
 *
 * Läuft NUR in gepackten Builds (`app.isPackaged`) — in dev ist autoUpdater inert
 * und würde nur „No published versions"-Fehler werfen. Windows-only Feed; auf
 * Linux deckt Flatpak/OSTree die Updates ab, daher Gate auf win32.
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';

export function wireUpdater(getWindow: () => BrowserWindow | null): void {
  // Nur gepackt + Windows: Linux = Flatpak, dev = kein Feed.
  if (!app.isPackaged || process.platform !== 'win32') return;

  const send = (channel: string, payload?: unknown): void => {
    const win = getWindow();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  };

  autoUpdater.autoDownload = true;          // Default, explizit
  autoUpdater.autoInstallOnAppQuit = true;  // Default, explizit — Quit-Fallback

  autoUpdater.on('update-available', (info) => send('updates:available', { version: info.version }));
  autoUpdater.on('download-progress', (p) => send('updates:progress', { percent: p.percent }));
  autoUpdater.on('update-downloaded', (info) => send('updates:ready', { version: info.version }));
  autoUpdater.on('error', (err) => console.error('[updater]', err));

  // Renderer-getriggerter Sofort-Neustart aus dem Banner.
  ipcMain.handle('updates:restart', () => {
    autoUpdater.quitAndInstall(false, true); // isSilent=false, isForceRunAfter=true
  });
  // Manueller Re-Check aus dem Renderer (optional; Start-Check passiert eh hier).
  ipcMain.handle('updates:check', () => autoUpdater.checkForUpdates());

  // Initialer Check kurz nach Start (Fenster ist dann da).
  void autoUpdater.checkForUpdates().catch((e) => console.error('[updater] initial check', e));
}
```

`main.ts` (Vorbild `wireNotify`):
- Import: `import { wireUpdater } from './updater';`
- In `app.whenReady()` nach `wireNotify(...)`: `wireUpdater(() => mainWindow);`

**Verifikation:** `cd desktop && pnpm run build:electron` baut ohne Fehler (esbuild externalisiert electron-updater). `main.ts` bleibt unter 500 Z (Updater-Logik ist ausgelagert).

## Task 3: preload.ts + pulse.d.ts — window.pulse.updates

**Files:** Modify `desktop/electron/preload.ts`, `web/src/lib/platform/pulse.d.ts`

`preload.ts` — neuer Block in der `exposeInMainWorld('pulse', {...})`-Map (Vorbild `notify`):
```typescript
  // Auto-Update (Windows, gepackt). Main lädt Updates selbst; der Renderer
  // zeigt nur das Banner + triggert den Sofort-Neustart.
  updates: {
    /** Update wurde heruntergeladen + installierbereit. Returns unsubscribe-fn. */
    onReady(cb: (data: { version: string }) => void): () => void {
      const handler = (_e: unknown, data: unknown): void => {
        if (!data || typeof data !== 'object') return;
        const d = data as Record<string, unknown>;
        if (typeof d.version !== 'string') return;
        cb({ version: d.version });
      };
      ipcRenderer.on('updates:ready', handler);
      return () => ipcRenderer.removeListener('updates:ready', handler);
    },
    /** Sofort installieren + neu starten (Banner-Button). */
    restartNow: (): Promise<void> => ipcRenderer.invoke('updates:restart'),
    /** Manueller Re-Check (optional). */
    check: (): Promise<void> => ipcRenderer.invoke('updates:check'),
  },
```

`pulse.d.ts` — neues Interface + Feld:
```typescript
export interface PulseUpdatesApi {
  /** Fires when an update is downloaded and ready to install. Returns unsubscribe. */
  onReady(cb: (data: { version: string }) => void): () => void;
  /** Install the downloaded update and restart now (banner button). */
  restartNow(): Promise<void>;
  /** Manually re-trigger an update check. */
  check(): Promise<void>;
}
```
+ in `PulseApi`: `updates?: PulseUpdatesApi;`

**Verifikation:** `cd web && pnpm check` (0 Errors).

## Task 4: Update-Banner im Renderer

**Files:** Modify `web/src/routes/+layout.svelte`

In der `isElectron()`-Subscription (onMount, neben `invite.onLink`) ein `updates.onReady`-Abo ergänzen, das eine persistente sonner-Toast mit Action-Button zeigt:
```typescript
    let disposeUpdate: (() => void) | undefined;
    if (isElectron()) {
      // ... bestehender invite-Block ...
      disposeUpdate = window.pulse?.updates?.onReady((data) => {
        toast('Update bereit', {
          description: `Version ${data.version} ist installiert, sobald du neu startest.`,
          duration: Infinity,
          action: {
            label: 'Neu starten',
            onClick: () => void window.pulse?.updates?.restartNow(),
          },
        });
      });
    }
```
- Import ergänzen: `import { toast } from 'svelte-sonner';` (sonner-Component re-exportiert `toast` — verifizieren ob aus `svelte-sonner` oder `$lib/components/ui/sonner`).
- `disposeUpdate?.()` im cleanup-return ergänzen.

**Verifikation:** `cd web && pnpm check && pnpm build` (0/0). Optional Playwright-Test mit gemocktem `window.pulse.updates` (Vorbild `passkeys.spec.ts`).

## Task 5: win-build.yml — NSIS bauen + rsync nach howispulse + nginx-Route

**Files:** Modify `.github/workflows/win-build.yml`, `infra/prod/web-nginx.conf`, `infra/prod/docker-compose.yml`

**win-build.yml:**
- Build-Step `dist:win` baut jetzt NSIS-Installer + `latest.yml` + `.blockmap` nach `desktop/release/`.
- `electron-builder --win` mit `--publish never` (nur bauen, kein Auto-Upload — der rsync macht's). Dazu im package.json-Script `dist:win` → `electron-builder --win --publish never`.
- Den GitHub-Release-Step (`softprops/action-gh-release`) **ersetzen** durch rsync nach VPS (Vorbild flatpak.yml Z.186-205):
  ```yaml
      - name: SSH für scp einrichten
        env:
          SSH_KEY: ${{ secrets.VPS_SSH_PRIVATE_KEY }}
          KNOWN_HOSTS: ${{ secrets.VPS_KNOWN_HOSTS }}
        run: |
          mkdir -p ~/.ssh && chmod 700 ~/.ssh
          printf '%s\n' "$SSH_KEY" > ~/.ssh/id_ed25519 && chmod 600 ~/.ssh/id_ed25519
          printf '%s\n' "$KNOWN_HOSTS" > ~/.ssh/known_hosts && chmod 644 ~/.ssh/known_hosts
        shell: bash
      - name: Updates nach howispulse hochladen
        shell: bash
        run: |
          scp -i ~/.ssh/id_ed25519 \
            desktop/release/latest.yml \
            desktop/release/Pulse-Setup-*.exe \
            desktop/release/Pulse-Setup-*.exe.blockmap \
            michael@159.195.150.54:pulse/updates-win/
  ```
  **ACHTUNG 1 — scp statt rsync:** der `windows-latest`-Runner hat KEIN `rsync` vorinstalliert (flatpak.yml läuft auf Ubuntu + `apt-get install rsync`), aber den OpenSSH-`scp`. scp lädt nur die genannten Dateien hoch und löscht NIE — alte Setup-.exe/.blockmap bleiben für Delta-Downloads liegen (genau das gewünschte Verhalten, kein `--delete`-Äquivalent nötig). Zielordner `~/pulse/updates-win/` muss vorab existieren (scp legt ihn nicht an).
- Das `upload-artifact` (Build-Artefakt) bleibt als Fallback erhalten.
- `concurrency`-Block ergänzen (`cancel-in-progress: false`) damit parallele Pushes nicht auf dem rsync-Target rasen (Vorbild flatpak.yml Z.45-49).

**web-nginx.conf** — nach dem `/flatpak/`-Block (Z.206):
```nginx
    # ── Pulse Windows-Auto-Update-Feed ──
    # NSIS-Installer + latest.yml + .blockmap, von win-build.yml per rsync
    # hierher gepusht; bind-gemountet als /srv/updates-win (siehe web-Service
    # in docker-compose.yml). electron-updater pollt latest.yml. Leerer/fehlender
    # Host-Ordner => 404, harmlos.
    location ^~ /updates/win/ {
        alias /srv/updates-win/;
        autoindex off;
    }
```

**docker-compose.yml** — web-Service volumes (nach Z.335):
```yaml
      - ${HOME}/pulse/updates-win:/srv/updates-win:ro
```

**Verifikation:** YAML-Lint (Workflow). nginx-Syntax visuell gegen den `/flatpak/`-Block. Realer Build + Update-Roundtrip = manueller Schritt (Task 7).

## Task 6: Doku — CLAUDE.md, README, Anti-Pattern-Fix

**Files:** Modify `CLAUDE.md`, `packaging/README.md` (oder Desktop-Doku), `streaming/win-hq-sidecar/README.md` (falls Distributions-Hinweis)

- `CLAUDE.md` §Desktop + §Produktiv-Deployment: Win-App ist jetzt NSIS-Installer mit Auto-Update über `howispulse.com/updates/win/` (generic electron-updater-Feed, gleiches rsync-Muster wie Flatpak). `dist:win` baut Setup-.exe + latest.yml.
- `CLAUDE.md` / `PLAN.md §12` Anti-Pattern **„❌ electron-builder als Dep"** korrigieren — wird für Windows bewusst genutzt; **`electron-updater` als Runtime-Dep ist neu + gewollt** (nicht unter die „keine neuen Deps"-Regel fallen lassen).
- Erwähnen: NSIS-Installer ist unsigniert → SmartScreen-Warnung beim Erst-Download (Cert später nachrüstbar).

**Verifikation:** Lesen, keine Tests.

## Task 7: Manueller Verifikations-Schritt (kein Code)

electron-updater läuft nicht in dev → echtes Testen braucht zwei reale Builds gegen den Live-Feed:
1. CI-Build v0.1.0 → rsync → installieren auf Windows-Testmaschine.
2. `version` in `desktop/package.json` auf `0.1.1` bumpen → push → CI-Build → rsync.
3. v0.1.0-App starten → Banner „Update bereit" muss erscheinen → „Neu starten" → installiert v0.1.1.
4. Alternativ: App schließen → autoInstallOnAppQuit installiert beim nächsten Start.

**Server-Vorbedingungen (einmalig, manuell durch den User):**
- GitHub-Secrets `VPS_SSH_PRIVATE_KEY` + `VPS_KNOWN_HOSTS` existieren bereits (von flatpak.yml) — derselbe CI-Key muss auf den **netcup**-Server (159.195.150.54) passen. **Prüfen**, ob der Flatpak-CI-Key dort schon `authorized_keys` hat (flatpak.yml rsynct bereits dorthin → ja).
- Host-Ordner `~/pulse/updates-win/` auf dem Server anlegen (sonst legt Docker ihn leer an → 404 bis zum ersten rsync, harmlos).
- `infra/` nach `~/pulse/infra/` rsyncen + `docker compose up -d pulse_web` (neuer Bind-Mount + nginx-Route greifen erst nach Container-Recreate).

---

## Offene Risiken (im Build zu verifizieren, nicht zu raten)

1. **electron-updater in der asar** (Task 1b): erster CI-Build ist der Lackmustest. Falls „Cannot find module" → expliziter `files:`-Eintrag.
2. **oneClick perMachine:false**: per-User-Install landet unter `%LOCALAPPDATA%\Programs\Pulse` — passt zu unsigniert + kein UAC. Falls Tester einen System-weiten Install wollen, später `perMachine`/`allowToChangeInstallationDirectory` öffnen.
3. **Sidecar in den extraResources**: NSIS packt `extraResources` genauso wie portable → der hq-sidecar-Resolver (`process.resourcesPath`) muss weiter greifen. Im Test-Build prüfen, dass HQ-Streaming nach Installer-Install funktioniert.
