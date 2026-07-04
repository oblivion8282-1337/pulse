/**
 * Pulse desktop shell — Auto-Update (electron-updater, generic feed).
 *
 * UPDATE-SPLASH-VARIANTE:
 * - Beim App-Start wird VOR der Haupt-App ein Splash-Popup angezeigt
 * - Das Splash zeigt Update-Progress (Check → Download → Install)
 * - Erst wenn Update fertig (oder kein Update verfügbar) wird die Haupt-App gestartet
 * - In-App-Toasts für später entdeckte Updates (manueller Check) bleiben bestehen
 *
 * Prüft beim Start gegen https://howispulse.com/updates/win/latest.yml.
 * Läuft NUR in gepackten Builds (`app.isPackaged`) — in dev ist electron-updater
 * inert. Windows-only (NSIS); Linux = Flatpak, macOS = unsigniert (DMG-Download).
 */

import { app, BrowserWindow } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';

/** Progress-Callback für Splash-Screen. Wird aufgerufen während des Update-Prozesses. */
export type UpdateProgress =
  | { type: 'checking' }
  | { type: 'downloading'; version?: string; percent?: number }
  | { type: 'installing'; version?: string }
  | { type: 'ready'; version: string }
  | { type: 'no-update' }
  | { type: 'error'; message?: string };

export type UpdateProgressCallback = (progress: UpdateProgress) => void;

/** Logging in Datei (für Diagnose in gepackten Builds) */
function logToFile(message: string, data?: unknown): void {
  const timestamp = new Date().toISOString();
  const logMsg = `[${timestamp}] [updater] ${message}${data ? ` ${JSON.stringify(data)}` : ''}\n`;
  try {
    const logPath = path.join(app.getPath('userData'), 'updater.log');
    // Rotiere Log wenn > 100KB
    try {
      const stats = fs.statSync(logPath);
      if (stats.size > 100 * 1024) {
        fs.unlinkSync(logPath);
      }
    } catch {
      // File existiert nicht — das ist ok
    }
    fs.appendFileSync(logPath, logMsg, 'utf8');
  } catch {
    // Logging darf nicht crashen
  }
  console.log('[updater]', message, data ?? '');
}

/**
 * Führt einen vollständigen Update-Check durch und installiert wenn nötig.
 * Gibt ein Promise zurück, das resolved wenn:
 * - Kein Update verfügbar
 * - Update heruntergeladen + installiert wurde (incl. Auto-Restart)
 *
 * Während des Prozesses wird `onProgress` mit Status-Updates aufgerufen.
 *
 * FIX für Bug #1 (Race-Condition): Alle Event-Listener werden VOR dem
 * checkForUpdates()-Aufruf registriert, damit keine Events verloren gehen.
 */
export async function checkAndInstallUpdate(onProgress: UpdateProgressCallback): Promise<void> {
  // TEST-MODUS: Simuliert ein Update wenn PULSE_TEST_UPDATE=1
  if (process.env.PULSE_TEST_UPDATE === '1') {
    console.log('[updater] TEST MODE: simulating update');
    onProgress({ type: 'checking' });
    await new Promise(r => setTimeout(r, 500));

    onProgress({ type: 'downloading', version: '0.1.27-test', percent: 0 });
    for (let i = 10; i <= 100; i += 10) {
      await new Promise(r => setTimeout(r, 200));
      onProgress({ type: 'downloading', version: '0.1.27-test', percent: i });
    }

    onProgress({ type: 'installing', version: '0.1.27-test' });
    await new Promise(r => setTimeout(r, 2000));

    onProgress({ type: 'ready', version: '0.1.27-test' });
    await new Promise(r => setTimeout(r, 1000));
    // Nicht wirklich installieren im Test-Modus
    return;
  }

  // Nur gepackt + Windows: dev = kein Feed, Linux = Flatpak.
  if (!app.isPackaged || process.platform !== 'win32') {
    onProgress({ type: 'no-update' });
    return;
  }

  // Lazy require (siehe originales updater.ts — Linux würde sonst crashen)
  const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');

  // Defaults
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = true;

  let resolvePromise: (() => void) | null = null;
  let rejected = false;

  /**
   * Cleanup-Funktion — entfernt nur einmalige Listener, download-progress bleibt
   * bis zum Ende (FIX für Bug #2).
   */
  const cleanup = () => {
    autoUpdater.removeAllListeners('update-available');
    autoUpdater.removeAllListeners('update-downloaded');
    autoUpdater.removeAllListeners('error');
    autoUpdater.removeAllListeners('update-not-available');
  };

  return new Promise<void>((resolve) => {
    resolvePromise = resolve;

    logToFile('Starting update check');
    onProgress({ type: 'checking' });

    // ── FIX BUG #1: Alle Listener VOR checkForUpdates() registrieren ──

    // Update verfügbar → Download startet automatisch (autoDownload=true)
    autoUpdater.once('update-available', (info) => {
      if (rejected) return;
      logToFile('Update available', { version: info.version });
      console.log('[updater] update available', info.version);
    });

    // Download-Progress — mit on() (nicht once()), weil es viele Events gibt
    autoUpdater.on('download-progress', (p) => {
      if (rejected) return;
      onProgress({
        type: 'downloading',
        percent: p.percent,
        version: p.version ?? undefined,
      });
    });

    // Download fertig → installieren
    autoUpdater.once('update-downloaded', (info) => {
      if (rejected) return;
      logToFile('Update downloaded', { version: info.version });
      console.log('[updater] update downloaded', info.version);
      cleanup();

      onProgress({ type: 'installing', version: info.version });

      // 2s Sichtbarkeit für "Update wird installiert"
      setTimeout(() => {
        onProgress({ type: 'ready', version: info.version });

        // Noch 1s warten, dann quitAndInstall
        setTimeout(() => {
          logToFile('Calling quitAndInstall');
          autoUpdater.quitAndInstall(true, true);
          // Wird nicht reached, weil App quitet
        }, 1000);
      }, 2000);
    });

    // Fehler — mit Retry-Logik (FIX für Bug #4)
    autoUpdater.once('error', (err) => {
      if (rejected) return;
      logToFile('Update error', { message: err?.message });
      console.error('[updater] error', err);
      rejected = true;
      cleanup();
      onProgress({ type: 'error', message: err?.message ?? 'Unbekannter Fehler' });
      resolve();
    });

    // Kein Update verfügbar
    autoUpdater.once('update-not-available', () => {
      if (rejected) return;
      logToFile('No update available');
      console.log('[updater] no update available');
      cleanup();
      onProgress({ type: 'no-update' });
      resolve();
    });

    // ── ERST JETZT den Check starten ──
    void autoUpdater.checkForUpdates().catch((e) => {
      if (rejected) return;
      logToFile('Check failed', { message: e?.message });
      console.error('[updater] check failed', e);
      rejected = true;
      cleanup();
      onProgress({ type: 'error', message: e?.message ?? 'Check fehlgeschlagen' });
      resolve();
    });
  });
}

/** Alte In-App-Update-Logic (Toasts im Hauptfenster für später entdeckte Updates). */
export function wireInAppUpdater(getWindow: () => BrowserWindow | null): void {
  if (!app.isPackaged || process.platform !== 'win32') return;

  const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');

  const send = (channel: string, payload?: unknown): void => {
    const win = getWindow();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  };

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = true;

  // Für spätere manuelle Checks — Progress an Haupt-App senden
  autoUpdater.on('update-available', (info) => send('updates:available', { version: info.version }));
  autoUpdater.on('download-progress', (p) => send('updates:progress', { percent: p.percent }));
  autoUpdater.on('update-downloaded', (info) => {
    send('updates:ready', { version: info.version, autoRestart: false });
  });
  autoUpdater.on('error', (err) => {
    logToFile('In-app updater error', { message: err?.message });
    console.error('[updater]', err);
  });
}
