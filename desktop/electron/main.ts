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

import { app, BrowserWindow, ipcMain, session, desktopCapturer, shell } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { URL } from 'node:url';
// Bundled by esbuild at build time (resolveJsonModule); `../package.json` is
// `desktop/package.json` relative to this source file.
import pkg from '../package.json';
import { getSidecar } from './sidecar';
import { initStore, storeGet, storeGetAll, storeSet } from './store';
import { createTray } from './tray';
import { wireNotify } from './notify';

// Override the user-visible app name BEFORE any other Electron API touches it.
// `app.getName()` falls back to package.json `name`, which is `@dcc/desktop` —
// KDE/Plasma's StatusNotifier surfaces that as "@dcc/desktop status icon" in
// the tray. Set it to "Pulse" instead. `getName()` also drives `userData`, so
// migrate the existing config dir on first run (else `pulse-stream.json` with
// the user's HQ-stream settings would silently appear empty).
(function setupAppName(): void {
  const newName = 'Pulse';
  const configHome = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  const oldDir = path.join(configHome, '@dcc', 'desktop');
  const newDir = path.join(configHome, newName);
  if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
    try {
      fs.renameSync(oldDir, newDir);
      try {
        fs.rmdirSync(path.join(configHome, '@dcc'));
      } catch {
        // parent not empty / already gone — fine
      }
    } catch (e) {
      console.error('[migration] userData rename failed:', e);
    }
  }
  app.setName(newName);
})();

// ── Custom URL-Protocol (pulse://) ──────────────────────────────────────────
// Registers this app as the default handler for `pulse://` URLs on the OS.
// Needed for invite deep-links: clicking `pulse://invite?host=...&code=...` in
// a browser should open (or focus) the running Pulse desktop client and navigate
// to the invite page.
//
// Dev-mode (electron . — `process.defaultApp` is true): Electron sets the
// argv[1] slot to the app-path; we have to pass it explicitly so the OS knows
// which binary to call for `pulse://` when running in dev.
// Prod (packaged / Flatpak): plain `setAsDefaultProtocolClient('pulse')`.
//
// NOTE: On Linux this writes to `~/.local/share/applications/` (a .desktop file
// handled by xdg-open). The Flatpak variant also needs
// `x-scheme-handler/pulse` in the Flatpak manifest's `finish-args`. See TODOs
// in the README / packaging manifest.
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('pulse', process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  }
} else {
  app.setAsDefaultProtocolClient('pulse');
}

const APP_VERSION: string = pkg.version ?? '0.0.0';
// Expose to the preload script (it runs in a separate process and can't import
// the package.json itself once bundled).
process.env.PULSE_APP_VERSION = APP_VERSION;

// Document-Picture-in-Picture explizit anschalten — Chromium hat die API seit
// 116 default-on, aber manche Electron-Builds / Distro-Patches schalten sie
// per Default ab; der Renderer nutzt sie für das ScreenShare-Detach-Fenster.
// Muss VOR app.whenReady() laufen.
app.commandLine.appendSwitch('enable-features', 'DocumentPictureInPictureAPI');

// Linux: Wayland-app_id / X11-WM_CLASS auf den Desktop-File-Namen ziehen, sonst
// fällt Chromium auf "electron" zurück → das Fenster matcht nicht
// `com.howispulse.Pulse.desktop`, und Wayland-Compositoren (Niri, Hyprland,
// Plasma …) zeigen kein App-Icon in der Taskleiste. Der Flatpak-Launcher gibt
// dasselbe Flag mit; diese Zeile deckt Dev-Builds & nicht-Flatpak-Starts ab.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('class', 'com.howispulse.Pulse');
}

// Which web app to load: the local Vite dev server only when PULSE_DEV_URL is
// explicitly set (frontend development) — otherwise the live deployed app, so a
// web-side fix is visible immediately, no Electron re-release needed (the GSR
// streaming bridge stays local via the preload's `window.pulse`).
const DEV_URL = process.env.PULSE_DEV_URL ?? null;
const PROD_URL = process.env.PULSE_URL ?? 'https://howispulse.com';
const TARGET_URL = DEV_URL ?? PROD_URL;
// DevTools no longer pop open on launch. Set PULSE_DEVTOOLS=1 to auto-open them
// (detached); otherwise the standard accelerator (Ctrl+Shift+I) still toggles them.
const OPEN_DEVTOOLS = process.env.PULSE_DEVTOOLS === '1';

let mainWindow: BrowserWindow | null = null;
// Discord-style: closing the window hides it (the tray stays). The only path
// that actually quits is the tray's "Beenden" entry, which sets this flag
// before calling `app.quit()`. The window's `close` handler honours it.
let isQuitting = false;

// ── Deep-Link / Invite-Handler ───────────────────────────────────────────────
// Validates and dispatches `pulse://invite?host=<fqdn>&code=<code>` URLs.
// Security: we parse strictly (URL class + FQDN regex + alphanumeric code) and
// NEVER execute any action derived from the URL without showing a user-visible
// disclaimer first (that's the frontend's job in /invite/[code]?host=…).

/** Valid invite code: 6-32 alphanumeric chars (same shape as the backend issues). */
const INVITE_CODE_RE = /^[A-Za-z0-9_-]{6,64}$/;

/** Rough FQDN check — at least one dot, only label-safe chars, no port injection.
 *  Blocks bare IPv4 (192.168.1.1 etc.) so a malicious link can't trick the renderer
 *  into hitting a private/loopback address. Self-Host muss FQDN haben (LE-Cert
 *  Pflicht für TLS) — IP-Direkt-Connect ist nie ein legitimer Pulse-Use-Case. */
function _isValidFqdn(hostname: string): boolean {
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(hostname)) return false;
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(
    hostname
  );
}

/** Extract a `pulse://` URL from a raw argv array (Windows/Linux cold-start). */
function extractPulseUrl(argv: string[]): string | null {
  return argv.find((a) => a.startsWith('pulse://')) ?? null;
}

/**
 * Buffer for the first deep-link received before the window is ready.
 * Delivered once in the `ready-to-show` callback.
 */
let pendingDeepLink: string | null = extractPulseUrl(process.argv);

function handleDeepLink(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    console.warn('[deep-link] unparseable URL, ignoring:', url);
    return;
  }
  if (parsed.protocol !== 'pulse:') return;
  if (parsed.hostname !== 'invite') {
    console.warn('[deep-link] unknown host, ignoring:', parsed.hostname);
    return;
  }

  const host = parsed.searchParams.get('host') ?? '';
  const code = parsed.searchParams.get('code') ?? '';

  // Strict validation — do NOT send user to an attacker-controlled hostname.
  if (!_isValidFqdn(host)) {
    console.warn('[deep-link] invalid host param, ignoring:', host);
    return;
  }
  if (!INVITE_CODE_RE.test(code)) {
    console.warn('[deep-link] invalid code param, ignoring:', code);
    return;
  }

  const payload = { hostname: host, code };

  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('pulse:invite', payload);
  } else {
    // Window not yet ready — buffer; delivered in createWindow's ready-to-show.
    pendingDeepLink = url;
  }
}

// macOS / some Linux compositors fire open-url for registered scheme handlers.
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

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

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    // Deliver any deep-link that arrived before the window was ready (cold-start).
    if (pendingDeepLink) {
      const url = pendingDeepLink;
      pendingDeepLink = null;
      handleDeepLink(url);
    }
  });
  mainWindow.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    mainWindow?.hide();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Lock navigation + popups to the configured target origin. Without these
  // guards a (hypothetical) XSS on howispulse.com — or a manipulated
  // PULSE_URL env override — could navigate the BrowserWindow to a third-party
  // page that inherits the contextBridge (`window.pulse.gsr.start()` etc.).
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!_isAllowedOrigin(url)) {
      e.preventDefault();
      void shell.openExternal(url);
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (_isAllowedOrigin(url)) return { action: 'allow' };
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  void mainWindow.loadURL(TARGET_URL);
  if (OPEN_DEVTOOLS) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

function _isAllowedOrigin(url: string): boolean {
  try {
    const u = new URL(url);
    const t = new URL(TARGET_URL);
    return u.origin === t.origin;
  } catch {
    return false;
  }
}

// ── GSR sidecar bridge (E1b) ────────────────────────────────────────────────
// `sidecar.ts` owns the Python child process + the newline-JSON protocol; here
// we only wire it to IPC. The sidecar is still spawned lazily on the first
// `gsr:call` — registering the event callback below does NOT start Python.

function wireSidecar(): void {
  getSidecar().onEvent((ev) => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('gsr:event', ev);
    }
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
// Windows: the OS passes the pulse:// URL as an argv entry to the second instance;
// we forward it to the running window via handleDeepLink.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', (_event, argv) => {
  // Check for a deep-link in the new-instance's argv before focusing.
  const url = extractPulseUrl(argv);
  if (url) handleDeepLink(url);

  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  // The window may be hidden in the tray — show() un-hides AND focuses.
  mainWindow.show();
  mainWindow.focus();
});

// ── Notifications (mention/DM toasts) ───────────────────────────────────────
// IPC wiring lives in `notify.ts` (mirrors the `tray.ts` pattern). The renderer
// decides WHEN to fire (only when unfocused); main shows unconditionally so
// there's a single source of truth for that decision.

// ── PTT ─────────────────────────────────────────────────────────────────────
// TODO: global PTT needs a native key-listener (uiohook-napi); Electron's
// `globalShortcut` only fires on press, not press+release, so it can't do
// hold-to-talk. The in-window PTT in VoiceChannelView.svelte (@svelte-put/shortcut)
// still works.

app.whenReady().then(() => {
  initStore();
  wireStore();
  wireSidecar();
  wireScreenShare();
  wireNotify(() => mainWindow);
  createWindow();
  createTray(
    () => mainWindow,
    () => {
      isQuitting = true;
      app.quit();
    }
  );
});

// With close-to-tray, `window-all-closed` only fires after a real quit (when
// `isQuitting` is set and the window is destroyed). On non-darwin we still want
// to follow through and exit then.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Best-effort sidecar shutdown on quit. Bounded so a stuck child can't hang the
// quit indefinitely — `shutdown()` itself escalates SIGTERM→SIGKILL after a
// short grace, so this outer timeout is just a backstop.
//
// Also flips `isQuitting` so the window's close-to-hide handler steps aside
// for any quit path (tray menu, OS logout, programmatic `app.quit()`).
let didShutdownSidecar = false;
app.on('before-quit', (event) => {
  isQuitting = true;
  if (didShutdownSidecar) return;
  event.preventDefault();
  didShutdownSidecar = true;
  const done = () => app.quit();
  void Promise.race([
    getSidecar().shutdown(),
    new Promise<void>((r) => setTimeout(r, 3_000)),
  ]).then(done, done);
});
