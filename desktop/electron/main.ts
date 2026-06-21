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

import { app, BrowserWindow, Menu, ipcMain, session, desktopCapturer, shell, nativeImage } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { URL } from 'node:url';
// Injected by esbuild's `--define` at build time (see `esbuild.mjs`) so only
// the version string is baked in, not the whole `package.json` object.
declare const __APP_VERSION__: string;
import { getSidecar } from './sidecar';
import { initStore, storeGet, storeGetAll, storeSet, storeSetBatch } from './store';
import { createTray } from './tray';
import { wireNotify } from './notify';
import { wirePower } from './power';
import { wireClipboard } from './clipboard';
import { wireUpdater } from './updater';
import { handleDeepLink, extractPulseUrl, takePendingInvite } from './deeplink';

// Linux audio: name our PulseAudio/PipeWire streams "Pulse" instead of the
// Chromium default. The GSR HQ-stream excludes our own audio from desktop
// capture via `app-inverse:Pulse` (else our playback of voice participants is
// recaptured into the stream → echo). PULSE_PROP is read by libpulse when
// Chromium's audio service connects; setting it here (before any Electron API)
// propagates to that child process. No-op on Windows/macOS.
//   IMPORTANT: the GSR sidecar STRIPS PULSE_PROP before launching
//   gpu-screen-recorder — GSR is a grandchild and would otherwise rename its
//   OWN libpulse capture node ("gsr-combined-*") to "Pulse", breaking its
//   internal self-linking and yielding a SILENT stream. See
//   streaming/gsr-sidecar/stream_controller.py.
if (process.platform === 'linux' && !process.env.PULSE_PROP) {
  process.env.PULSE_PROP = 'node.name=Pulse';
}

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

const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';
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
//
// Security (finding 163): PULSE_URL is a developer-only override, not a
// user-facing setting. In packaged builds we ignore it entirely to prevent a
// malicious .desktop file or wrapper script from shifting the trusted origin.
// In dev/unpackaged builds we accept it but require an https:// URL so
// `file://` and `http://` payloads cannot be used to bypass the origin guard.
// Security: PULSE_DEV_URL is only valid in unpackaged builds (like PULSE_URL)
// and must use http: or https: to prevent file:// bypass of the origin guard.
let DEV_URL: string | null = null;
const _rawDevUrl = process.env.PULSE_DEV_URL;
if (_rawDevUrl && !app.isPackaged) {
  try {
    const u = new URL(_rawDevUrl);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      DEV_URL = _rawDevUrl;
    } else {
      console.warn('[startup] PULSE_DEV_URL ignored — must be http:// or https://, got:', u.protocol);
    }
  } catch {
    console.warn('[startup] PULSE_DEV_URL ignored — not a valid URL:', _rawDevUrl);
  }
} else if (_rawDevUrl && app.isPackaged) {
  console.warn('[startup] PULSE_DEV_URL ignored in packaged build (developer-only override).');
}
const _rawPulseUrl = process.env.PULSE_URL;
let PROD_URL = 'https://howispulse.com';
if (!DEV_URL && _rawPulseUrl && !app.isPackaged) {
  try {
    const u = new URL(_rawPulseUrl);
    if (u.protocol === 'https:') {
      PROD_URL = _rawPulseUrl;
    } else {
      console.warn('[startup] PULSE_URL ignored — must be https://, got:', u.protocol);
    }
  } catch {
    console.warn('[startup] PULSE_URL ignored — not a valid URL:', _rawPulseUrl);
  }
} else if (_rawPulseUrl && app.isPackaged) {
  console.warn('[startup] PULSE_URL ignored in packaged build (developer-only override).');
}
const TARGET_URL = DEV_URL ?? PROD_URL;
// Pre-computed origin of the target URL to avoid re-parsing on every navigation event.
const TARGET_ORIGIN = new URL(TARGET_URL).origin;
// DevTools no longer pop open on launch. Set PULSE_DEVTOOLS=1 to auto-open them
// (detached); otherwise Ctrl+Shift+I / F12 toggle them via the before-input-event
// handler in createWindow (the default-menu accelerator is gone — menu removed).
const OPEN_DEVTOOLS = process.env.PULSE_DEVTOOLS === '1';

let mainWindow: BrowserWindow | null = null;
// Discord-style: closing the window hides it (the tray stays). The only path
// that actually quits is the tray's "Beenden" entry, which sets this flag
// before calling `app.quit()`. The window's `close` handler honours it.
let isQuitting = false;

// ── Deep-Link / Invite-Handler ───────────────────────────────────────────────
// Validation + buffering lives in `deeplink.ts` (kept out of this file for the
// code-size cap). Here we only wire the Electron events to those helpers.

// macOS / some Linux compositors fire open-url for registered scheme handlers.
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url, () => mainWindow);
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
      // Keep timers + media running at full rate when the window is
      // minimized/occluded. Default (true) throttles a backgrounded
      // renderer: a watch-party host's <video> stalls while is_playing stays
      // true, so it broadcasts a frozen position and viewers loop on backward
      // drift-seeks. Also keeps the voice/PTT timers honest in the tray.
      backgroundThrottling: false,
      // Watch-party videos (YouTube/Twitch/native) must start playing the
      // instant a party is created/joined — with sound. Chromium's default
      // gates autoplay-with-audio behind a fresh user gesture, which the async
      // player load loses. The desktop shell is trusted, so lift the gate.
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    // The pending invite payload (if any) is delivered via the pull-based
    // `invite:getPending` IPC handler once the renderer's onMount fires.
    // We do NOT push it here because ready-to-show precedes the SvelteKit
    // onMount callback, so any webContents.send here would be lost.
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
      _openExternalIfWebUrl(url);
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!_isAllowedOrigin(url)) {
      _openExternalIfWebUrl(url);
      return { action: 'deny' };
    }
    // Allow — no preload (browser-like popup, see did-create-window), but lift
    // the autoplay gate so a detached watch-party plays immediately, like the
    // main window.
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        webPreferences: { autoplayPolicy: 'no-user-gesture-required' },
      },
    };
  });
  // Electron creates the allowed popup at about:blank and — in this
  // Electron/Chromium build — does NOT auto-navigate it to the requested URL,
  // so detached stream/watch windows stayed blank (white). Force the load here.
  // We deliberately do NOT give the child the contextBridge preload: the
  // detached viewer needs nothing from `window.pulse`, and running it as a
  // plain (browser-like, `isElectron()===false`) window matches the path that
  // already works in a real browser. Re-apply the off-origin nav guard though.
  mainWindow.webContents.on('did-create-window', (child, { url }) => {
    if (url) void child.loadURL(url);
    child.webContents.on('will-navigate', (e, navUrl) => {
      if (!_isAllowedOrigin(navUrl)) {
        e.preventDefault();
        _openExternalIfWebUrl(navUrl);
      }
    });
    child.webContents.setWindowOpenHandler(({ url: childUrl }) => {
      if (_isAllowedOrigin(childUrl)) return { action: 'allow' };
      _openExternalIfWebUrl(childUrl);
      return { action: 'deny' };
    });
  });

  // Reload + DevTools accelerators used to come from Electron's default menu,
  // which we remove (setApplicationMenu(null)) to hide the menu bar. Re-add just
  // those shortcuts via before-input-event so the bar stays gone but F5 / reload
  // and the DevTools toggle work again.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const wc = mainWindow?.webContents;
    if (!wc) return;
    const mod = input.control || input.meta; // Ctrl (win/linux) or Cmd (macOS)
    const key = input.key.toLowerCase(); // 'F5'/'F12'/'R' come uppercased — normalise
    // Plain reload: F5 / Ctrl|Cmd+R. Force-reload (bypass cache): Shift+F5,
    // Ctrl+F5 (Windows convention), Ctrl|Cmd+Shift+R.
    const reload = (key === 'f5' && !input.shift && !mod) || (mod && key === 'r' && !input.shift);
    const forceReload =
      (key === 'f5' && (input.shift || mod)) || (mod && key === 'r' && input.shift);
    if (reload) {
      event.preventDefault();
      wc.reload();
    } else if (forceReload) {
      event.preventDefault();
      wc.reloadIgnoringCache();
    } else if (
      key === 'f12' ||
      (mod && input.shift && key === 'i') || // Ctrl/Cmd+Shift+I (win/linux)
      (input.meta && input.alt && key === 'i') // Cmd+Alt+I (macOS)
    ) {
      event.preventDefault();
      wc.toggleDevTools();
    }
  });

  void mainWindow.loadURL(TARGET_URL);
  if (OPEN_DEVTOOLS) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

function _isAllowedOrigin(url: string): boolean {
  try {
    const u = new URL(url);
    return u.origin === TARGET_ORIGIN;
  } catch {
    return false;
  }
}

/** Off-origin-Links nur an den System-Browser geben, wenn sie wirklich
 * Web-URLs sind. `shell.openExternal` reicht alles an die OS-Shell durch —
 * ein kompromittierter Renderer könnte sonst per `file://`/`smb://` etc.
 * lokale Dateien oder beliebige Protokoll-Handler öffnen (ShellExecute unter
 * Windows). Alles außer http(s) wird still verworfen. */
function _openExternalIfWebUrl(url: string): void {
  let proto: string;
  try {
    proto = new URL(url).protocol;
  } catch {
    return;
  }
  if (proto === 'https:' || proto === 'http:') void shell.openExternal(url);
}

// ── GSR sidecar bridge (E1b) ────────────────────────────────────────────────
// `sidecar.ts` owns the Python child process + the newline-JSON protocol; here
// we only wire it to IPC. The sidecar is still spawned lazily on the first
// `gsr:call` — registering the event callback below does NOT start Python.

/** Allowed GSR ops (finding 156) — any op not in this set is silently rejected
 *  with {ok: false} to prevent a compromised renderer from invoking unexpected
 *  sidecar operations. The set contains exactly the ops declared in pulse.d.ts
 *  and exposed via the preload. */
const ALLOWED_GSR_OPS = new Set([
  'health',
  'gpu_info',
  'list_profiles',
  'list_monitors',
  'list_windows',
  'list_application_audio',
  'build_argv',
  'start',
  'stop',
]);

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
    // Validate op against the allowlist (finding 156).
    if (!ALLOWED_GSR_OPS.has(op)) {
      return { ok: false, error: 'unknown op' };
    }
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

/** Allowed keys for the persistent stream-settings store (finding 162).
 *  Any store:set call with a key not in this set is silently rejected to
 *  prevent a compromised renderer from injecting arbitrary keys or bloating
 *  the store file. */
const ALLOWED_STORE_KEYS = new Set([
  'profile_name',
  'server_name',
  'capture_source',
  'audio_mode',
  'excluded_apps',
  'overrides',
  'use_overrides',
  'custom_servers',
  // Multi-Server-Liste (vormals localStorage `pulse.servers`) — auf dem Desktop
  // in den chmod-600-Tresor verschoben statt im Klartext-Profil zu liegen.
  'pulse.servers',
]);

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
  // Synchronous snapshot read — the store is already fully in memory after
  // `initStore()` (runs in whenReady, before any renderer code), so this is a
  // cheap in-memory copy. Needed because the multi-server list must be readable
  // synchronously at app boot (serversStore.init() runs before first paint and
  // the whole boot chain depends on it). `ipcMain.on` + `e.returnValue` is the
  // sync IPC form; fired exactly once per launch.
  ipcMain.on('store:getAllSync', (e) => {
    try {
      e.returnValue = storeGetAll();
    } catch (err) {
      console.error('[store] store:getAllSync failed:', err);
      e.returnValue = {};
    }
  });
  ipcMain.handle('store:set', (_e, key: string, value: unknown) => {
    if (!ALLOWED_STORE_KEYS.has(key)) {
      console.warn('[store] store:set rejected unknown key:', key);
      return;
    }
    try {
      storeSet(key, value);
    } catch (e) {
      console.error('[store] store:set failed:', e);
    }
  });
  // Atomic batch write — avoids N parallel rename() races (finding 158).
  ipcMain.handle('store:setAll', (_e, values: Record<string, unknown>) => {
    if (!values || typeof values !== 'object') return;
    try {
      // Filter to only allowed keys before batch write.
      const filtered: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(values)) {
        if (!ALLOWED_STORE_KEYS.has(key)) {
          console.warn('[store] store:setAll rejected unknown key:', key);
          continue;
        }
        filtered[key] = value;
      }
      // Single atomic persist for all keys.
      storeSetBatch(filtered);
    } catch (e) {
      console.error('[store] store:setAll failed:', e);
    }
  });
}

// ── Invite deep-link pull handler ────────────────────────────────────────────
// The renderer calls this once on mount to consume any deep-link that arrived
// before the listener was ready. Clears the buffer on read (one-shot).
function wireInvitePull(): void {
  ipcMain.handle('invite:getPending', () => takePendingInvite());
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
  if (url) handleDeepLink(url, () => mainWindow);

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
  // Dev-run Dock icon (macOS): an unpackaged `electron .` shows the default
  // Electron icon in the Dock. The packaged .app gets the Pulse icon from
  // electron-builder (build-resources/icon.icns); for the dev run set it at
  // runtime. No-op when packaged (icon comes from the bundle) or off-macOS.
  if (process.platform === 'darwin' && !app.isPackaged && app.dock) {
    const iconPath = path.join(__dirname, '..', '..', 'build-resources', 'icon.png');
    try {
      const img = nativeImage.createFromPath(iconPath);
      if (!img.isEmpty()) app.dock.setIcon(img);
    } catch {
      // dev-only cosmetic — ignore
    }
  }

  // DIAG: jeder Renderer-/GPU-Crash mit Grund ins Log (sonst still). Hilft beim
  // Debuggen der abgedockten Popup-Fenster.
  app.on('web-contents-created', (_e, contents) => {
    contents.on('render-process-gone', (_ev, details) => {
      console.error('[render-process-gone]', contents.getURL().slice(0, 80), JSON.stringify(details));
    });
    contents.on('unresponsive', () => console.error('[unresponsive]', contents.getURL().slice(0, 80)));
  });
  app.on('child-process-gone', (_e, details) => {
    console.error('[child-process-gone]', JSON.stringify(details));
  });
  // Pulse ist eine Web-App im Fenster — Electrons Default-Menü (File/Edit/View/
  // Window/Help) hat hier keinen Sinn. Komplett entfernen statt nur ausblenden.
  Menu.setApplicationMenu(null);
  initStore();
  wireStore();
  wireInvitePull();
  wireSidecar();
  wireScreenShare();
  wireNotify(() => mainWindow);
  // Display-sleep inhibitor — renderer toggles it while a watch-party / HQ
  // stream is actively playing (`window.pulse.power.keepAwake`).
  wirePower();
  // Native clipboard + dropped-file byte access — lets paste + drag-drop of
  // images/files work in the sandboxed remote renderer (`window.pulse.clipboard`
  // / `window.pulse.files`).
  wireClipboard();
  // Auto-Update (Windows, gepackt) — no-op in dev / auf Linux.
  wireUpdater(() => mainWindow);
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
