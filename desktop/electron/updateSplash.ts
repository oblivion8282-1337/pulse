/**
 * Boot-Update-Splash — gemeinsam für Client- und Server-App-Boot.
 *
 * Erzeugt das frameless Splash-Fenster, das VOR dem Hauptfenster den
 * electron-updater-Check macht (Check → Download → Install), und kapselt den
 * Ablauf (dom-ready warten, Progress ans Splash forwarded, no-update/error-
 * Sichtbarkeits-Timeouts). Beide Boot-Pfade (`bootWithUpdateCheck` im Client,
 * `bootServer` in der Server-App) nutzen dieselbe Logik — nur das Fenster-Icon
 * unterscheidet sich (`iconBasename`: 'icon.png' vs 'icon-server.png').
 *
 * Extrahiert aus `main.ts` (verhaltensidentisch); der Caller besitzt den
 * Splash-Ref (setzt ihn via `onClosed` auf null) und entscheidet nach
 * `{updated}`, ob er die Haupt-App startet oder zurückkehrt (quitAndInstall
 * feuert dann).
 */
import { BrowserWindow } from 'electron';
import * as path from 'node:path';
import { checkAndInstallUpdate } from './updater';

/** Erzeugt das Splash-Fenster. `iconBasename` wählt das Icon unter
 *  `process.resourcesPath/build-resources/` (Client 'icon.png', Server
 *  'icon-server.png'). `onClosed` feuert, wenn das Fenster schließt — der
 *  Caller nullt dort seinen Splash-Ref, damit der Boot-Aftermath-Cleanup kein
 *  geschlossenes Fenster mehr anfasst. */
export function createUpdateSplashWindow(
  iconBasename: string,
  onClosed?: () => void,
): BrowserWindow {
  // Splash-HTML und Icon liegen im gepackten Build NICHT im `__dirname` (asar
  // virtualisiert das), sondern unter `process.resourcesPath` als extraResources
  // (siehe electron-builder.yml). `closable: true` (statt false) — falls der
  // Splash-Check haengt und das Promise nicht resolves, kann der User ihn
  // wegklicken statt in einer weissen Flaeche gefangen zu sein.
  const splash = new BrowserWindow({
    width: 480,
    height: 360,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: true,
    frame: false,
    show: false,
    title: 'Pulse Update',
    icon: path.join(process.resourcesPath, 'build-resources', iconBasename),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (onClosed) splash.on('closed', onClosed);
  splash.once('ready-to-show', () => splash.show());
  splash.loadFile(
    path.join(process.resourcesPath, 'build-resources', 'update-splash.html')
  );

  return splash;
}

/** Führt den Boot-Update-Check gegen das Splash-Fenster aus.
 *  - Wartet auf dom-ready (500-ms-Fallback), damit der IPC-Handler im Splash
 *    registriert ist, bevor Progress-Events gesendet werden.
 *  - Ruft `checkAndInstallUpdate` und forwardet jeden Progress ans Splash.
 *  - 'no-update' schließt das Splash nach 300 ms, 'error' nach 1000 ms.
 *  - Gibt `{updated}` zurück. Bei `updated: true` MUSS der Caller ohne
 *    Haupt-App zurückkehren (quitAndInstall feuert ~1 s nach 'ready'), sonst
 *    blitzt das Hauptfenster kurz auf, bevor der Installer quitet. */
export async function runStartupUpdateCheck(
  splash: BrowserWindow,
): Promise<{ updated: boolean }> {
  // Warte auf dom-ready, damit das Splash-Fenster komplett geladen ist
  // und der IPC-Handler registriert wurde, bevor wir Events senden.
  await new Promise<void>((resolve) => {
    if (splash.isDestroyed()) {
      resolve();
      return;
    }
    splash.webContents.once('dom-ready', () => resolve());
    // Fallback: Falls dom-ready nicht feuert (extrem unwahrscheinlich), nach 500ms weiter.
    setTimeout(() => resolve(), 500);
  });

  // Update-Check mit Progress-Callback an Splash.
  const { updated } = await checkAndInstallUpdate((progress) => {
    if (!splash.isDestroyed()) {
      splash.webContents.send('update-progress', progress);
    }

    // UX: "no-update"/"error" → Splash schneller schließen.
    if (progress.type === 'no-update') {
      // 300ms Sichtbarkeit für "Kein Update verfügbar" — kurzer Flash,
      // fühlt sich nicht wie ein Hängen an.
      setTimeout(() => {
        if (!splash.isDestroyed()) splash.close();
      }, 300);
    } else if (progress.type === 'error') {
      // 1s Sichtbarkeit für Fehlermeldungen.
      setTimeout(() => {
        if (!splash.isDestroyed()) splash.close();
      }, 1000);
    }
  });

  return { updated };
}
