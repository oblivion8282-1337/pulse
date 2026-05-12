/**
 * Pulse desktop shell — Electron main process (E1a).
 *
 * Replaces the Tauri shell (`desktop/src-tauri/`, still present, removed in E1c)
 * because Tauri uses WebKitGTK on Linux and its WebRTC is too unreliable for
 * LiveKit voice. Electron ships Chromium on every OS → WebRTC works out of the box.
 *
 * E1a scope: a window that loads the SvelteKit app (the Vite dev server at
 * `:5173` in dev, the static build in prod). Single-instance lock. Nothing else
 * yet — the GSR sidecar bridge is E1b, persistence (`electron-store`) is E1c.
 *
 * Wayland/NVIDIA note: Electron runs on Wayland via XWayland (X11 backend) by
 * default and that works robustly here. We deliberately set NO Ozone/Wayland
 * flags in E1a — the WebKitGTK DMABUF crash was a Tauri/WebKitGTK problem, not
 * an Electron one. (Native Wayland would be `ozone-platform-hint=auto`, but that
 * can introduce rendering quirks — not in E1a.)
 */

import { app, BrowserWindow } from 'electron';
import * as path from 'node:path';
// Bundled by esbuild at build time (resolveJsonModule); `../package.json` is
// `desktop/package.json` relative to this source file.
import pkg from '../package.json';

const APP_VERSION: string = pkg.version ?? '0.0.0';
// Expose to the preload script (it runs in a separate process and can't import
// the package.json itself once bundled).
process.env.PULSE_APP_VERSION = APP_VERSION;

// In dev we load the running Vite server; in a packaged app we load the static build.
const isDev = !app.isPackaged || !!process.env.PULSE_DEV_URL;
const DEV_URL = process.env.PULSE_DEV_URL ?? 'http://localhost:5173';

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 832,
    minWidth: 940,
    minHeight: 600,
    show: false,
    title: 'Pulse',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (isDev) {
    void mainWindow.loadURL(DEV_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    // Prod layout: this file is `desktop/electron/dist/main.cjs`, the SvelteKit
    // static build lives at `web/build/`. TODO(T6): verify/adjust once the
    // Electron packaging (electron-builder) lays the files out — in E1a the dev
    // path is the tested one.
    void mainWindow.loadFile(path.join(__dirname, '../../../web/build/index.html'));
  }
}

// ── Single-instance lock ────────────────────────────────────────────────────
// Second launch hands focus to the running window instead of starting a 2nd one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

// ── PTT ─────────────────────────────────────────────────────────────────────
// TODO: global PTT needs a native key-listener (uiohook-napi); Electron's
// `globalShortcut` only fires on press, not press+release, so it can't do
// hold-to-talk. The in-window PTT in VoiceChannelView.svelte (@svelte-put/shortcut)
// still works. Notifications: TODO E1c (could be a small `notify(title, body)`
// IPC handler doing `new Notification(...).show()` — left out of E1a).

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
