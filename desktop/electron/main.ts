/**
 * Pulse desktop shell — Electron main process (E1a).
 *
 * The Tauri shell this replaced (`desktop/src-tauri/`, removed in E1c) used
 * WebKitGTK on Linux and its WebRTC was too unreliable for LiveKit voice.
 * Electron ships Chromium on every OS → WebRTC works out of the box.
 *
 * Scope:
 *   E1a — a window that loads the SvelteKit app (the Vite dev server at `:5173`
 *         in dev, the static build in prod) + a single-instance lock.
 *   E1b — the GSR sidecar bridge (`sidecar.ts` + the `gsr:*` IPC channels).
 *   E1c — settings persistence: a tiny hand-rolled key-value store in `store.ts`
 *         (`<userData>/pulse-stream.json`, chmod 600 on Linux) exposed over the
 *         `store:*` IPC channels (renderer side: `window.pulse.store.*`).
 *
 * Wayland/NVIDIA note: Electron runs on Wayland via XWayland (X11 backend) by
 * default and that works robustly here. We deliberately set NO Ozone/Wayland
 * flags in E1a — the WebKitGTK DMABUF crash was a Tauri/WebKitGTK problem, not
 * an Electron one. (Native Wayland would be `ozone-platform-hint=auto`, but that
 * can introduce rendering quirks — not in E1a.)
 */

import { app, BrowserWindow, ipcMain, session, desktopCapturer } from 'electron';
import * as path from 'node:path';
// Bundled by esbuild at build time (resolveJsonModule); `../package.json` is
// `desktop/package.json` relative to this source file.
import pkg from '../package.json';
import { getSidecar } from './sidecar';
import { initStore, storeGet, storeGetAll, storeSet } from './store';

const APP_VERSION: string = pkg.version ?? '0.0.0';
// Expose to the preload script (it runs in a separate process and can't import
// the package.json itself once bundled).
process.env.PULSE_APP_VERSION = APP_VERSION;

// Dev: load the running Vite server. Packaged: load the live deployed web app
// (a web-side fix is then visible immediately, no Electron re-release needed —
// the GSR streaming bridge stays local via the preload's `window.pulse`).
const isDev = !app.isPackaged || !!process.env.PULSE_DEV_URL;
const DEV_URL = process.env.PULSE_DEV_URL ?? 'http://localhost:5173';
const PROD_URL = process.env.PULSE_URL ?? 'https://pulse.unicutmedia.com';

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 832,
    minWidth: 940,
    minHeight: 600,
    show: false,
    title: 'Pulse',
    // `dist/main.cjs` lives one level below `electron/`, where icon.png sits.
    icon: path.join(__dirname, '..', 'icon.png'),
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
    void mainWindow.loadURL(PROD_URL);
  }
}

// ── GSR sidecar bridge (E1b) ────────────────────────────────────────────────
// `sidecar.ts` owns the Python child process + the newline-JSON protocol; here
// we only wire it to IPC. The sidecar is still spawned lazily on the first
// `gsr:call` — registering the event callback below does NOT start Python.

function wireSidecar(): void {
  getSidecar().onEvent((ev) => {
    mainWindow?.webContents.send('gsr:event', ev);
  });

  // Generic handler — the renderer calls `gsr:call` with an op name + params.
  // Catch everything so a bad op / dead sidecar surfaces as `{ok:false}` in the
  // renderer instead of an unhandled rejection.
  ipcMain.handle('gsr:call', async (_e, op: string, params: unknown) => {
    try {
      return await getSidecar().call(op, params);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

// ── Settings persistence (E1c) ──────────────────────────────────────────────
// A tiny key-value store backed by `<userData>/pulse-stream.json` (see store.ts).
// `initStore()` loads it on app-ready; the renderer talks to it via `store:*`.
// Handlers catch everything so a bad write surfaces as a logged error, not a
// crash / unhandled rejection in the renderer.

function wireStore(): void {
  ipcMain.handle('store:get', (_e, key: string) => {
    try {
      return storeGet(key);
    } catch (e) {
      console.error('[store] store:get failed:', e);
      return undefined;
    }
  });
  ipcMain.handle('store:getAll', () => {
    try {
      return storeGetAll();
    } catch (e) {
      console.error('[store] store:getAll failed:', e);
      return {};
    }
  });
  ipcMain.handle('store:set', (_e, key: string, value: unknown) => {
    try {
      storeSet(key, value);
    } catch (e) {
      console.error('[store] store:set failed:', e);
    }
  });
}

// ── Screen capture (browser screen-share via LiveKit/WebRTC) ────────────────
// Electron has no built-in screen picker — without a display-media request
// handler, navigator.mediaDevices.getDisplayMedia() in the renderer throws
// "Not supported".
//
// On Linux/Wayland we must NOT call desktopCapturer.getSources() here: that
// opens its own xdg-desktop-portal session/picker, and the subsequent capture
// opens a *second* one — the dialog flickers open/closed/open. Instead we hand
// Chromium a synthetic "whole screen" source; Chromium then drives the portal
// picker itself, exactly once, during the actual capture (and the portal lets
// the user pick which monitor/window regardless of the synthetic id).
// On Windows/macOS `useSystemPicker: true` makes Electron use the OS picker and
// our handler isn't invoked. (A proper in-app source picker is a follow-up —
// the GSR HQ-stream path covers richer capture.)
function wireScreenShare(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      if (process.platform === 'linux') {
        // Synthetic "whole screen" stream id — Chromium maps this to its portal
        // ScreenCast flow on Wayland (the portal picker still lets the user
        // choose a specific monitor/window) and to the primary X screen on X11.
        callback({ video: { id: 'screen:0:0', name: 'Bildschirm' } });
        return;
      }
      // Non-Linux without a system picker: fall back to enumerating sources.
      desktopCapturer
        .getSources({ types: ['screen', 'window'] })
        .then((sources) => callback(sources[0] ? { video: sources[0] } : {}))
        .catch(() => callback({}));
    },
    { useSystemPicker: true }
  );
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

app.whenReady().then(() => {
  initStore();
  wireStore();
  wireSidecar();
  wireScreenShare();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Best-effort sidecar shutdown on quit. Bounded so a stuck child can't hang the
// quit indefinitely — `shutdown()` itself escalates SIGTERM→SIGKILL after a
// short grace, so this outer timeout is just a backstop.
let didShutdownSidecar = false;
app.on('before-quit', (event) => {
  if (didShutdownSidecar) return;
  event.preventDefault();
  didShutdownSidecar = true;
  const done = () => app.quit();
  void Promise.race([
    getSidecar().shutdown(),
    new Promise<void>((r) => setTimeout(r, 3_000)),
  ]).then(done, done);
});
