/**
 * Pulse desktop shell — Auto-Update (electron-updater, generic feed).
 *
 * HINTERGRUND-MODELL (kein Boot-Splash mehr):
 * - Die Haupt-App startet SOFORT, nie hinter einem Update-Fenster.
 * - Der Update-Check + Download laufen im Hintergrund (autoDownload). Fortschritt
 *   und der „Update bereit"-Prompt erscheinen als Toast IM Hauptfenster-Renderer
 *   (`updates:available|progress|ready` → Banner in `+layout.svelte`).
 * - „Neu starten" ruft `quitAndInstall(false, true)` → der bekannte, SICHTBARE
 *   NSIS-Installer läuft (kein stiller Hintergrund-Lauf, damit der User Feedback
 *   sieht) und startet Pulse danach neu (Finish-Checkbox `runAfterFinish`).
 * - Klickt der User NICHT: `autoInstallOnAppQuit` installiert das schon
 *   heruntergeladene Update beim nächsten echten Beenden still — niemand bleibt
 *   auf einer alten Version hängen (wichtig für Tray-Dauerläufer, die die App
 *   selten wirklich schließen).
 *
 * Feed: https://howispulse.com/updates/win/latest.yml. Läuft nur in gepackten
 * Windows-Builds (NSIS) — Linux = Flatpak, macOS = unsigniert (DMG-Download).
 *
 * LOKALER TEST (ohne Image-Push): `PULSE_DEV_UPDATE=1` hebt die
 * `app.isPackaged`-Sperre auf und setzt `forceDevUpdateConfig`, sodass der ganze
 * Check→Download→„Update bereit"-Fluss unter `pnpm dev` gegen einen lokalen Feed
 * läuft (`dev-app-update.yml` → z.B. http://localhost:8888/). Siehe README.
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';

/** Periodischer Re-Check-Intervall. Holt ein Update herein, das NACH dem Boot-
 *  Check auf den Server gepusht wurde, ohne dass der User neu starten muss.
 *  Überschreibbar via `PULSE_UPDATE_INTERVAL_MS` (ms) — produktiv ungesetzt, nur
 *  für lokale End-to-End-Tests heruntergeschraubt. */
const RE_CHECK_INTERVAL_MS = Number(process.env.PULSE_UPDATE_INTERVAL_MS) || (60 * 60 * 1000);

/** Verzögerung des ersten Checks nach dem Boot. Gibt dem Renderer Zeit, seine
 *  `updates:*`-Listener in onMount zu registrieren, bevor das erste Event feuert
 *  — sonst könnte ein sehr schneller `update-available`-Toast verpuffen (der
 *  entscheidende `ready`-Prompt kommt aber ohnehin erst nach dem Download). */
const INITIAL_CHECK_DELAY_MS = Number(process.env.PULSE_UPDATE_INITIAL_DELAY_MS) || 4000;

/** Logging in Datei (für Diagnose in gepackten Builds). */
function logToFile(message: string, data?: unknown): void {
  const timestamp = new Date().toISOString();
  const logMsg = `[${timestamp}] [updater] ${message}${data ? ` ${JSON.stringify(data)}` : ''}\n`;
  try {
    const logPath = path.join(app.getPath('userData'), 'updater.log');
    try {
      // Rotiere Log wenn > 100KB
      if (fs.statSync(logPath).size > 100 * 1024) fs.unlinkSync(logPath);
    } catch {
      // File existiert nicht — ok
    }
    fs.appendFileSync(logPath, logMsg, 'utf8');
  } catch {
    // Logging darf nie crashen
  }
  console.log('[updater]', message, data ?? '');
}

/** Dev-Test-Modus: `PULSE_DEV_UPDATE=1` in einem UNGEPACKTEN Build. Lässt den
 *  echten electron-updater-Fluss lokal laufen (gegen `dev-app-update.yml`). */
function isDevUpdateMode(): boolean {
  return process.env.PULSE_DEV_UPDATE === '1' && !app.isPackaged;
}

/** Ist der Updater in diesem Build aktiv? Gepackt + Windows (NSIS-Feed), oder
 *  der lokale Dev-Test-Modus. Sonst inert (dev, Linux/Flatpak, macOS). */
function updaterActive(): boolean {
  return isDevUpdateMode() || (app.isPackaged && process.platform === 'win32');
}

/** Lazy-require + gemeinsame Konfiguration der `autoUpdater`-Singleton. Alle
 *  Einstiegspunkte teilen dieselbe Instanz, damit es keine Doppel-Listener /
 *  widersprüchlichen Defaults gibt. Nur aufrufen, wenn `updaterActive()`. */
function getAutoUpdater(): import('electron-updater').AppUpdater {
  const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Downgrade bewusst AUS — eine CI-Misconfig, die versehentlich eine alte
  // Version als „latest" pusht, soll bestehende Clients NICHT zurückrollen.
  autoUpdater.allowDowngrade = false;
  if (isDevUpdateMode()) {
    // Ohne das überspringt electron-updater den Check in einem ungepackten Build.
    autoUpdater.forceDevUpdateConfig = true;
    const cfg = process.env.PULSE_DEV_UPDATE_CONFIG;
    if (cfg) autoUpdater.updateConfigPath = cfg;
  }
  return autoUpdater;
}

/** Startet den kompletten Updater-Lebenszyklus in EINEM Aufruf: Renderer-
 *  Events (`updates:available|progress|ready` → Toast-Block in `+layout.svelte`),
 *  die IPC-Handler `updates:restart` + `updates:check` (Renderer via
 *  `window.pulse.updates.*`) und die Checks (Boot + periodisch). Listener werden
 *  bewusst VOR dem ersten Check registriert — deshalb ein Aufruf statt zwei
 *  getrennter Funktionen (kein „wire before check"-Ordering-Vertrag zwischen
 *  Call-Sites). Gibt eine Cleanup-Funktion zurück, die die Timer stoppt (no-op,
 *  wenn der Updater in diesem Build inert ist). */
export function startUpdater(getWindow: () => BrowserWindow | null): () => void {
  if (!updaterActive()) return () => undefined;

  const autoUpdater = getAutoUpdater();

  const send = (channel: string, payload?: unknown): void => {
    const win = getWindow();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  };

  const check = (reason: string): void => {
    logToFile(`Update check (${reason})`);
    void autoUpdater.checkForUpdates().catch((e) => {
      // Checks dürfen nie die UI stören — Fehler nur loggen.
      logToFile('Check failed', { reason, message: e?.message });
    });
  };

  autoUpdater.on('update-available', (info) => {
    logToFile('Update available', { version: info.version });
    send('updates:available', { version: info.version });
  });
  autoUpdater.on('download-progress', (p) =>
    send('updates:progress', { percent: p.percent })
  );
  autoUpdater.on('update-downloaded', (info) => {
    logToFile('Update downloaded', { version: info.version });
    // `autoRestart=false` → der Renderer zeigt den abbrechbaren „Neu starten"-
    // Button. Wer nicht klickt, bekommt das Update via autoInstallOnAppQuit beim
    // nächsten echten Beenden.
    send('updates:ready', { version: info.version, autoRestart: false });
  });
  autoUpdater.on('error', (err) => {
    logToFile('Updater error', { message: err?.message });
    console.error('[updater]', err);
  });

  // „Neu starten"-Button: sichtbarer Installer (isSilent=false) + garantierter
  // Neustart danach (isForceRunAfter=true). Der assistierte NSIS-Wizard zeigt
  // seinen Fortschritt und startet Pulse über die vorangehakte Finish-Checkbox
  // (runAfterFinish) neu — der User sieht Feedback statt eines stillen Hängers.
  ipcMain.handle('updates:restart', () => {
    logToFile('quitAndInstall (user clicked restart)');
    autoUpdater.quitAndInstall(false, true);
  });
  // Manueller Re-Check (z.B. späterer Tray-Eintrag / Settings-Panel). Status
  // kommt über die `updates:*`-Channels zurück.
  ipcMain.handle('updates:check', () => check('manual'));

  // Boot-Check kurz verzögert (Renderer-Listener sind dann registriert), danach
  // periodisch. Der load-bearing `ready`-Prompt kommt ohnehin erst nach dem
  // Download, überlebt also jede Renderer-Startlatenz.
  const first = setTimeout(() => check('boot'), INITIAL_CHECK_DELAY_MS);
  const interval = setInterval(() => check('periodic'), RE_CHECK_INTERVAL_MS);

  return () => {
    clearTimeout(first);
    clearInterval(interval);
  };
}
