/**
 * Pulse desktop shell — Auto-Update (electron-updater, generic feed).
 *
 * UPDATE-SPLASH-VARIANTE:
 * - Beim App-Start wird VOR der Haupt-App ein Splash-Popup angezeigt
 * - Das Splash zeigt Update-Progress (Check → Download → Install)
 * - Erst wenn Update fertig (oder kein Update verfügbar) wird die Haupt-App gestartet
 * - In-App-Toasts für später entdeckte Updates (manueller Re-Check oder
 *   periodischer Re-Check alle RE_CHECK_INTERVAL_MS) zeigen das
 *   „Update bereit — jetzt neu starten?"-Banner im Hauptfenster.
 *
 * Prüft beim Start gegen https://howispulse.com/updates/win/latest.yml.
 * Läuft NUR in gepackten Builds (`app.isPackaged`) — in dev ist electron-updater
 * inert. Windows-only (NSIS); Linux = Flatpak, macOS = unsigniert (DMG-Download).
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';

/** Periodischer Re-Check-Intervall. Holt ein Update herein, das NACH dem
 *  Splash-Check auf den Server gepusht wurde, ohne dass der User die App
 *  neu starten muss. Manueller Trigger via IPC `updates:check`.
 *
 *  Ueberschreibbar via `PULSE_UPDATE_INTERVAL_MS` (ms) — produktiv nicht
 *  gesetzt, nur fuer lokale End-to-End-Tests auf 30 s heruntergeschraubt. */
const RE_CHECK_INTERVAL_MS = Number(process.env.PULSE_UPDATE_INTERVAL_MS) || (60 * 60 * 1000);

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
  // Downgrade bewusst AUS — eine CI-Misconfig, die versehentlich eine alte
  // Version als „latest" pusht, soll bestehende Clients NICHT zurückrollen.
  autoUpdater.allowDowngrade = false;

  return new Promise<void>((resolve) => {
    // `finished` schützt gegen Doppelfeuern (spätere Events während cleanup
    // oder mehrere Listener auf demselben Event). `cleanup()` + `resolve()`
    // sind idempotent: finish() ist die einzige Tür.
    let finished = false;

    /** Entfernt ALLE hier registrierten autoUpdater-Listener — vorher leakte
     *  `download-progress` als einziges `on()`-Event; resultat war ein
     *  Listener auf dem nachfolgenden wireInAppUpdater() plus unser eigener
     *  (Doppel-Progress-Events). */
    const cleanup = (): void => {
      autoUpdater.removeAllListeners('update-available');
      autoUpdater.removeAllListeners('download-progress');
      autoUpdater.removeAllListeners('update-downloaded');
      autoUpdater.removeAllListeners('error');
      autoUpdater.removeAllListeners('update-not-available');
    };

    /** Letzter Schritt jedes Pfads: progress melden, listener abräumen,
     *  Promise resolven. Idempotent — Doppel-Calls durch spätere Events
     *  sind No-ops. */
    const finish = (finalProgress: UpdateProgress): void => {
      if (finished) return;
      finished = true;
      onProgress(finalProgress);
      cleanup();
      resolve();
    };

    logToFile('Starting update check');
    onProgress({ type: 'checking' });

    // ── FIX BUG #1: Alle Listener VOR checkForUpdates() registrieren ──

    // Update verfügbar → Download startet automatisch (autoDownload=true)
    autoUpdater.once('update-available', (info) => {
      logToFile('Update available', { version: info.version });
      console.log('[updater] update available', info.version);
    });

    // Download-Progress — mit on() (nicht once()), weil es viele Events gibt.
    autoUpdater.on('download-progress', (p) => {
      onProgress({
        type: 'downloading',
        percent: p.percent,
        version: p.version ?? undefined,
      });
    });

    // Download fertig → installieren. Cleanup hier erst NACH dem
    // 3-Sek-Splash-Fenster, damit kein Race die Splash-Progress-Events
    // überschreibt.
    autoUpdater.once('update-downloaded', (info) => {
      logToFile('Update downloaded', { version: info.version });
      console.log('[updater] update downloaded', info.version);

      onProgress({ type: 'installing', version: info.version });

      // 2s Sichtbarkeit für "Update wird installiert"
      setTimeout(() => {
        finish({ type: 'ready', version: info.version });

        // 1s nach "bereit" hart installieren — der User hatte keine Wahl,
        // bewusst so (Hybrid mit abbrechbarem In-App-Toast ist eine
        // spaetere Stufe; braeuchte eine eigene „Jetzt installieren"-
        // IPC-Bruecke, die noch nicht existiert).
        setTimeout(() => {
          logToFile('Calling quitAndInstall');
          autoUpdater.quitAndInstall(true, true);
          // Wird nicht erreicht, weil App gleich quitet.
        }, 1000);
      }, 2000);
    });

    // Fehler — Listener feuert auch nach `finish()` von update-downloaded,
    // aber dann ist `finished=true` und der Handler ist ein No-op.
    autoUpdater.once('error', (err) => {
      logToFile('Update error', { message: err?.message });
      console.error('[updater] error', err);
      finish({ type: 'error', message: err?.message ?? 'Unbekannter Fehler' });
    });

    autoUpdater.once('update-not-available', () => {
      logToFile('No update available');
      console.log('[updater] no update available');
      finish({ type: 'no-update' });
    });

    // ── ERST JETZT den Check starten ──
    void autoUpdater.checkForUpdates().catch((e) => {
      logToFile('Check failed', { message: e?.message });
      console.error('[updater] check failed', e);
      finish({ type: 'error', message: e?.message ?? 'Check fehlgeschlagen' });
    });
  });
}

/** In-App-Updater: sendet `updates:available|progress|ready` an den Renderer
 *  (Toast-Block in `+layout.svelte`) und nimmt die zwei IPC-Handler
 *  `updates:restart` + `updates:check` entgegen, die der Renderer über die
 *  preload-Bridge (`window.pulse.updates.*`) feuert. Hängt sich an dieselbe
 *  `autoUpdater`-Singleton-Instanz, die der Splash-Check bereits benutzt —
 *  der Cleanup im Splash-Pfad stellt sicher, dass es keine Doppel-Listener
 *  gibt (siehe `checkAndInstallUpdate` oben). */
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
  // Bewusst AUS — gleiche Begruendung wie im Splash-Pfad oben. Sobald der
  // In-App-Updater seine eigenen Listener anhaengt, duerfen die Defaults
  // nicht versehentlich auf „Downgrade erlaubt" zurueckfallen.
  autoUpdater.allowDowngrade = false;

  // Update verfuegbar / Download-Progress / Installierbereit → Haupt-App.
  // `autoRestart=false` zeigt im Renderer den abbrechbaren „Neu starten"-Button
  // (im Splash-Pfad setzt main den 'ready'-Progress direkt an die Splash und
  // schickt KEIN Renderer-Event — eine Doppel-UI waere hier unnoetig).
  autoUpdater.on('update-available', (info) =>
    send('updates:available', { version: info.version })
  );
  autoUpdater.on('download-progress', (p) =>
    send('updates:progress', { percent: p.percent })
  );
  autoUpdater.on('update-downloaded', (info) => {
    send('updates:ready', { version: info.version, autoRestart: false });
  });
  autoUpdater.on('error', (err) => {
    logToFile('In-app updater error', { message: err?.message });
    console.error('[updater]', err);
  });

  // IPC: Sofort-Neustart aus dem In-App-Banner-Button.
  // `isSilent=false` heisst: Installer darf den User zu sehen kriegen (typischer
  // Pulse-Install ist per-User ohne UAC, also erwarten wir keinen Prompt);
  // `isForceRunAfter=true` startet die App nach dem Install garantiert neu.
  ipcMain.handle('updates:restart', () => {
    autoUpdater.quitAndInstall(false, true);
  });

  // IPC: Manueller Re-Check (z.B. ueber einen spaeteren Tray-Eintrag oder ein
  // Settings-Panel). Promise wird verworfen — der eigentliche Status kommt
  // ueber die `updates:available|progress|ready`-Channels zurueck.
  ipcMain.handle('updates:check', () => {
    void autoUpdater.checkForUpdates().catch((e) => {
      logToFile('Manual check failed', { message: e?.message });
      console.error('[updater] manual check failed', e);
    });
  });
}

/** Periodischer Re-Check im Hintergrund. Loest das „App laeuft den ganzen Tag,
 *  jetzt kommt ein Update"-Problem, ohne dass der User die App neu starten
 *  muss. Der Splash-Check beim Boot laeuft zusaetzlich — ist also redundant,
 *  aber schadet nicht (no-update kommt, kein Download startet). */
export function startPeriodicUpdateChecks(): () => void {
  if (!app.isPackaged || process.platform !== 'win32') {
    return () => undefined;
  }

  const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');
  const handle = setInterval(() => {
    console.log('[updater] periodic re-check');
    void autoUpdater.checkForUpdates().catch((e) => {
      // Periodische Checks duerfen nie die UI stoeren — Fehler nur loggen.
      console.warn('[updater] periodic check failed', e?.message ?? e);
    });
  }, RE_CHECK_INTERVAL_MS);

  return () => clearInterval(handle);
}
