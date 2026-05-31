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
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';

export function wireUpdater(getWindow: () => BrowserWindow | null): void {
  // Nur gepackt + Windows: dev = kein Feed, Linux = Flatpak.
  if (!app.isPackaged || process.platform !== 'win32') return;

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

  autoUpdater.on('update-available', (info) => send('updates:available', { version: info.version }));
  autoUpdater.on('download-progress', (p) => send('updates:progress', { percent: p.percent }));
  autoUpdater.on('update-downloaded', (info) => send('updates:ready', { version: info.version }));
  // Nur loggen — ein nicht erreichbarer Feed / fehlende Berechtigung darf den
  // Start nicht stören (kein Renderer-Event, sonst nervt es den User bei
  // Offline-Start).
  autoUpdater.on('error', (err) => console.error('[updater]', err));

  // Renderer-getriggerter Sofort-Neustart aus dem Banner-Button.
  // isSilent=false (NSIS-Fortschritt zeigen), isForceRunAfter=true (App danach
  // wieder hochfahren).
  ipcMain.handle('updates:restart', () => {
    autoUpdater.quitAndInstall(false, true);
  });
  // Optionaler manueller Re-Check aus dem Renderer (der Start-Check unten läuft
  // ohnehin automatisch).
  ipcMain.handle('updates:check', () => autoUpdater.checkForUpdates());

  // Initialer Check kurz nach Start — das Fenster ist via whenReady bereits da.
  void autoUpdater.checkForUpdates().catch((e) => console.error('[updater] initial check', e));
}
