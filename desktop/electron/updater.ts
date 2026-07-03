/**
 * Pulse desktop shell — Auto-Update (electron-updater, generic feed).
 *
 * Prüft beim Start gegen https://howispulse.com/updates/win/latest.yml (die
 * Feed-URL kommt aus electron-builder.yml `publish:` → electron-builder backt sie
 * als `app-update.yml` in resources/, electron-updater liest sie selbst). Bei
 * `autoDownload=true` (Default) lädt der Updater das Update sofort herunter; ist
 * es fertig (`update-downloaded`), schicken wir ein `updates:ready`-Event an den
 * Renderer, der ein „Update bereit – neu starten"-Banner zeigt (sonner). Klickt
 * der User den Button → `updates:restart` → `quitAndInstall()`. Tut er nichts,
 * installiert `autoInstallOnAppQuit` (Default true) beim nächsten App-Beenden.
 *
 * Läuft NUR in gepackten Builds (`app.isPackaged`) — in dev ist electron-updater
 * inert und würde nur „No published versions"/„dev-app-update.yml not found"
 * werfen. Der Feed ist Windows-spezifisch (NSIS); auf Linux deckt Flatpak/OSTree
 * die Updates ab, daher zusätzlich auf win32 gaten. Pattern wie `notify.ts`:
 * `wireUpdater(() => mainWindow)` in `app.whenReady()`.
 *
 * macOS ist hier BEWUSST (noch) nicht freigeschaltet: electron-updater verifiziert
 * auf macOS die Code-Signatur des heruntergeladenen .zip (anders als Windows, das
 * nur SHA512 aus latest.yml prüft) — ein unsignierter Build (Stufe A in
 * `docs/plans/2026-06-15-macos-client.md`) kann sich also nicht selbst updaten.
 * Sobald der Mac-Build signiert + notarisiert ist (Stufe B), das Gate auf
 * `process.platform !== 'win32' && process.platform !== 'darwin'` erweitern,
 * `latest-mac.yml`/`.zip` über win-build-analoge CI nach /updates/mac/ pushen und
 * die nginx-Route ergänzen.
 */

import { app, BrowserWindow, ipcMain } from 'electron';

export function wireUpdater(getWindow: () => BrowserWindow | null): void {
  // Nur gepackt + Windows: dev = kein Feed, Linux = Flatpak.
  if (!app.isPackaged || process.platform !== 'win32') return;

  // electron-updater wird NUR in den Windows-Builds mitgeliefert (electron-builder
  // zieht es als Production-Dep in die asar). Das Flatpak/Linux-Bundle enthält es
  // bewusst NICHT (kein node_modules, esbuild-`--external`). Deshalb erst HIER —
  // nach dem win32-Gate — lazy requiren: ein Top-Level-Import würde beim Laden des
  // Moduls ausgeführt und ließe die App auf Linux mit "Cannot find module
  // 'electron-updater'" crashen, bevor das Gate überhaupt greift.
  const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');

  const send = (channel: string, payload?: unknown): void => {
    const win = getWindow();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  };

  // Defaults explizit gesetzt: herunterladen sobald verfügbar, beim Quit
  // installieren (Discord-Stil-Fallback, falls der User das Banner ignoriert).
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Auto-Downgrade erlauben: falls ein Build (z. B. ein Electron-Major-Sprung)
  // nach dem Shippen kritisch problemt, können wir `latest.yml` auf eine ältere
  // Version zurücksetzen und der Updater nimmt sie trotzdem. Default ist false
  // (Schutz vor Downgrade-Schleifen + Reverse-Migration-Risiko); wir setzen es
  // bewusst — Voraussetzung: `store.ts`/Config bleibt abwärtskompatibel (keine
  // Schema-Migrationen, die ein älterer Build nicht versteht).
  autoUpdater.allowDowngrade = true;

  autoUpdater.on('update-available', (info) => send('updates:available', { version: info.version }));
  autoUpdater.on('download-progress', (p) => send('updates:progress', { percent: p.percent }));
  autoUpdater.on('update-downloaded', (info) => send('updates:ready', { version: info.version }));
  // Nur loggen — ein nicht erreichbarer Feed / fehlende Berechtigung darf den
  // Start nicht stören (kein Renderer-Event, sonst nervt es den User bei
  // Offline-Start).
  autoUpdater.on('error', (err) => console.error('[updater]', err));

  // Renderer-getriggerter Sofort-Neustart aus dem Banner-Button.
  // isSilent=true → der NSIS-Installer läuft mit /S durch (kein Wizard, keine
  // Klicks), isForceRunAfter=true → App danach automatisch wieder hochfahren.
  // Wichtig seit der Umstellung auf den assistierten Wizard (electron-builder.yml
  // nsis.oneClick=false): mit isSilent=false würde hier beim Auto-Update der VOLLE
  // Wizard mit Weiter-Klicks aufgehen — unerwünscht. Der gebrandete Wizard ist nur
  // für den manuellen Erst-Install gedacht; In-App-Updates bleiben nahtlos (Discord-
  // Stil). Der Install-beim-Beenden-Pfad (autoInstallOnAppQuit) ist ohnehin still.
  ipcMain.handle('updates:restart', () => {
    autoUpdater.quitAndInstall(true, true);
  });
  // Optionaler manueller Re-Check aus dem Renderer (der Start-Check unten läuft
  // ohnehin automatisch).
  ipcMain.handle('updates:check', () => autoUpdater.checkForUpdates());

  // Initialer Check kurz nach Start — das Fenster ist via whenReady bereits da.
  void autoUpdater.checkForUpdates().catch((e) => console.error('[updater] initial check', e));
}
