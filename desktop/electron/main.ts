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

import { app, BrowserWindow, Menu, dialog, ipcMain, session, desktopCapturer, shell, nativeImage } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { URL } from 'node:url';
// Injected by esbuild's `--define` at build time (see `esbuild.mjs`) so only
// the version string is baked in, not the whole `package.json` object.
declare const __APP_VERSION__: string;
// Build-Mode (client | server), ebenfalls per esbuild-define (PULSE_BUILD_MODE).
// 'server' = Pulse Server-App: lädt lokales server.html, HostLifecycle im
// Lochungs-Modus, kein Client-Sidecar/Updater/DeepLink.
declare const __APP_MODE__: 'client' | 'server';
const SERVER_MODE = __APP_MODE__ === 'server';
import {
  MAX_STREAM_SLOTS,
  allSidecars,
  getLinuxBackend,
  getSidecar,
  resetSpawnTargetCache,
} from './sidecar';
import { onSidecarEventForUpload } from './experimental-log-upload';
import { initStore, storeGet, storeGetAll, storeSet, storeSetBatch } from './store';
import { createTray, applyTrayStatus, setTrayImageFromDataUrl } from './tray';
import { wireNotify } from './notify';
import { wirePower } from './power';
import { wireClipboard } from './clipboard';
import { startUpdater } from './updater';
import { wireGlobalShortcuts } from './shortcuts';
import { handleDeepLink, extractPulseUrl, takePendingInvite } from './deeplink';
import { HostLifecycle } from './hostLifecycle';
import type { HostDeps } from './hostLifecycle';
import { ContainerBackendManager, resolveImage } from './localBackend/containerBackendManager';
import { wslReady, installWsl, inFlatpak } from './localBackend/containerRuntime';
import { volumeSizeBytes, exportVolume } from './localBackend/dataTools';
import { applyAutostart } from './autostart';
import {
  redeemBootstrap, loadCreds, saveCreds, clearCreds,
  probeUrl, sanitize,
} from './localBackend/pairing';
import { provision, deleteInstanceRegistration, fetchCloudStatus } from './serverProvision';
import { runGiveUp } from './serverGiveUp';
import { checkReachability } from './localBackend/reachability';
import { mapMediaPorts } from './localBackend/portMapper';
import { checkCredsSupersede } from './serverSupersede';

/** Intervall für den periodischen Ablöse-Check (③c-Ergänzung) — 10 Min sind
 *  träge genug, um den Registry-Token-Realm nicht spürbar zu belasten, aber
 *  schnell genug, dass ein Zombie-Gerät binnen Minuten stoppt statt Tage. */
const SUPERSEDE_CHECK_INTERVAL_MS = 10 * 60_000;

/** Update-Check-Intervall für den Dauerläufer-Container: 24 h — der Pull ist
 *  nach dem ersten Mal nur ein Digest-Abgleich, aber häufiger bringt nichts
 *  (Recreate unterbricht den Server kurz). Zusätzlich einmal beim App-Boot. */
const CONTAINER_UPDATE_INTERVAL_MS = 24 * 60 * 60_000;

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
  const newName = SERVER_MODE ? 'Pulse Server' : 'Pulse';
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
if (!SERVER_MODE) {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('pulse', process.execPath, [
        path.resolve(process.argv[1]),
      ]);
    }
  } else {
    app.setAsDefaultProtocolClient('pulse');
  }
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
  app.commandLine.appendSwitch('class', SERVER_MODE ? 'com.howispulse.PulseServer' : 'com.howispulse.Pulse');
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
    title: SERVER_MODE ? 'Pulse Server' : 'Pulse',
    // `dist/main.cjs` lives one level below `electron/`, where icon.png sits.
    // Server-App: eigenes (violettes) Icon, sonst sind die beiden Fenster im
    // Fensterwechsler nicht auseinanderzuhalten.
    icon: path.join(__dirname, '..', SERVER_MODE ? 'icon-server.png' : 'icon.png'),
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
    // `quitOnClose` (User-Setting, „App"-Tab): Fenster-X beendet die App
    // wirklich statt sie ins Tray zu minimieren. isQuitting setzen, damit der
    // before-quit-Handler (Sidecar-Shutdown) sauber greift.
    const quit = isQuitting || storeGet('quitOnClose') === true;
    if (quit) {
      isQuitting = true;
      return;
    }
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

  if (SERVER_MODE) {
    // Server-App: schon gepaart → lokales server.html; sonst Login-Phase bei
    // howispulse.com (normaler Pulse-Login), danach Wechsel auf server.html.
    if (loadCreds({ get: storeGet, set: storeSet })) {
      mainWindow.loadFile(path.join(__dirname, 'server.html'));
    } else {
      mainWindow.loadURL(PROD_URL);
      startLoginWatch(mainWindow);
    }
  } else {
    void mainWindow.loadURL(TARGET_URL);
    if (OPEN_DEVTOOLS) mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

/** Server-App: wechselt nach erfolgreichem Login vom howispulse.com-Login auf
 *  das lokale server.html.
 *
 *  Primärsignal ist die SPA-Navigation nach /app — sie feuert im selben Moment
 *  wie der Login-Erfolg. Der frühere 1,5-s-Cookie-Poll allein ließ die volle
 *  Chat-Oberfläche bis zum nächsten Tick aufblitzen; er bleibt nur als Netz
 *  für Wege ohne Navigation (z.B. Session war beim Start schon gültig). */
function startLoginWatch(win: BrowserWindow): void {
  let done = false;
  const toServer = () => {
    if (done || win.isDestroyed()) return;
    done = true;
    clearInterval(timer);
    void win.loadFile(path.join(__dirname, 'server.html'));
  };
  const onNav = (_e: unknown, url: string) => {
    try {
      if (new URL(url).pathname.startsWith('/app')) toServer();
    } catch { /* unparsebare URL → ignorieren */ }
  };
  win.webContents.on('did-navigate-in-page', onNav);
  win.webContents.on('did-navigate', onNav);
  // Poll-Fallback für Wege ohne Navigation (Session war beim Start schon gültig).
  // `timer` wird erst asynchron (im Callback/`toServer`) gelesen → const genügt.
  const timer = setInterval(async () => {
    if (win.isDestroyed()) { clearInterval(timer); return; }
    try {
      const cookies = await session.defaultSession.cookies.get({ name: 'pulse_session', url: PROD_URL });
      if (cookies.length) toServer();
    } catch { /* ignore — retry */ }
  }, 1500);
  win.once('closed', () => clearInterval(timer));
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

// ── Host-Lifecycle bridge (③a/③c) ──────────────────────────────────────────
// Verdrahtet HostLifecycle (hostLifecycle.ts) + ContainerBackendManager +
// Reachability + PortMapper mit dem Renderer über host:* IPC-Kanäle.
// ③c: Identität/Relay/probeUrl kommen aus dem Cloud-Pairing (pairing.ts);
// der ganze Server-Stack läuft als EIN allinone-Container (inkl. frpc-Tunnel).

function wireHost(getWin: () => Electron.BrowserWindow | null): void {
  const manager = new ContainerBackendManager();
  const hostStore = { get: storeGet, set: (k: string, v: unknown) => storeSet(k, v) };
  let creds = loadCreds(hostStore);

  const deps: HostDeps = {
    // Windows + Podman: podman machine braucht WSL2. Docker Desktop verwaltet
    // seine WSL-Umgebung selbst → Check nur für den Podman-Pfad.
    checkPrereqs: async () => {
      if (process.platform !== 'win32') return 'ok';
      const rt = await manager.runtime();
      if (rt?.kind !== 'podman') return 'ok';
      return (await wslReady()) ? 'ok' : 'needs-windows-setup';
    },
    startBackend: async ({ onProgress }) => {
      if (!creds) throw new Error('host not paired yet');
      await manager.start({
        userData: app.getPath('userData'),
        creds,
        onProgress,
      });
    },
    stopBackend: () => manager.stop(),
    checkReachability: async () => {
      // Test-Seam: Diagnose überspringen (E2E electron-apphost.spec + Maschinen,
      // deren Firewall die STUN/UDP-Probe blockt und die Diagnose 'unknown' liefert).
      if (process.env.PULSE_HOST_ASSUME_REACHABLE === '1') {
        return { verdict: 'reachable' as const, publicIp: null };
      }
      const r = await checkReachability({ probeUrl: creds ? probeUrl(creds) : '' });
      return { verdict: r.verdict, publicIp: r.publicIp };
    },
    mapPorts: async (stunIp) => {
      const r = await mapMediaPorts({ stunIp });
      return { verdict: r.verdict, openPorts: r.openPorts, failedPorts: r.failedPorts };
    },
    relayUrl: () => (creds?.relaySubdomain ? `https://${creds.relaySubdomain}` : null),
  };
  const hl = new HostLifecycle(deps, SERVER_MODE ? { holePunch: true } : {});
  hl.onPhase((e) => {
    getWin()?.webContents.send('host:phase', e);
    // Jeder 'live'-Übergang (Start ODER Boot-Zustands-Abgleich) startet den
    // Cloud-Status-Poll; das Flag darin verhindert Doppel-Läufe.
    if (e.phase === 'live') void pollCloudStatus();
  });

  // Zustands-Abgleich: `hl`s `_last` lebt nur in-memory — nach einem App-
  // Neustart weiß sie nichts vom Container, der dank `--restart unless-
  // stopped` weiterlief. Fragt den echten Zustand ab und hebt die Phase auf
  // 'live', wenn er läuft (markLive() ist selbst ein No-Op außerhalb 'idle',
  // stört also weder eine laufende Sequenz noch 'superseded').
  const syncLifecycleFromContainer = async (): Promise<void> => {
    if (!SERVER_MODE) return;
    const running = await manager.isContainerRunning().catch(() => false);
    if (running) hl.markLive(deps.relayUrl());
  };

  // Ablöse-Erkennung: periodischer Creds-Check gegen den Registry-Token-Realm
  // (serverSupersede.ts). Ein eindeutiges 401 heißt: ein Re-Bootstrap auf
  // einem ANDEREN Gerät hat clientSecret rotiert — dieses Gerät ist Zombie.
  // Netzwerkfehler/403/5xx sind fail-safe: keine Aktion.
  const checkSupersedeOnce = async (): Promise<void> => {
    if (!SERVER_MODE || !creds) return;
    const verdict = await checkCredsSupersede(creds);
    if (verdict !== 'superseded') return;
    await manager.stop().catch(() => {}); // Creds bleiben erhalten (Diagnose)
    hl.markSuperseded();
  };

  // Update-Check im Betrieb: Dauerläufer (Container überlebt App-Neustarts)
  // bekämen sonst nie Patches — nur der "Server starten"-Klick pullte. Nur bei
  // Phase 'live'; Pull-Fehler (offline) bleiben still bis zum nächsten Intervall.
  const maybeUpdateContainer = async (): Promise<void> => {
    if (!SERVER_MODE || hl.getStatus().phase !== 'live') return;
    const verdict = await manager.checkImageUpdate().catch(() => 'none' as const);
    if (verdict === 'update') await hl.applyUpdate();
  };

  // Cloud-Registrierungs-Status: sobald 'live' erreicht ist, den Directory-
  // Heartbeat abfragen und das Ergebnis an die UI pushen — einmal sofort,
  // dann alle 60s, bis er registriert ist (danach ändert sich nichts mehr).
  // Ein Flag verhindert parallele Poller (mehrere 'live'-Übergänge).
  let cloudStatusPolling = false;
  const pollCloudStatus = async (): Promise<void> => {
    if (!SERVER_MODE || !creds || cloudStatusPolling) return;
    if (hl.getStatus().phase !== 'live') return;
    cloudStatusPolling = true;
    try {
      while (hl.getStatus().phase === 'live') {
        const registered = creds ? await fetchCloudStatus(creds.cloudOrigin, creds.instanceId) : null;
        getWin()?.webContents.send('host:cloudStatus', { registered });
        if (registered === true) return; // registriert bleibt registriert
        await new Promise((r) => setTimeout(r, 60_000));
      }
    } finally {
      cloudStatusPolling = false;
    }
  };

  // Autostart-Abgleich: Schalter-Zustand lebt im Store, der OS-Zustand wird
  // hier idempotent nachgezogen (applyAutostart ist electron-frei → Deps hier).
  const osApplyAutostart = (enabled: boolean): { ok: boolean } =>
    applyAutostart(enabled, {
      platform: process.platform,
      setLoginItems: (openAtLogin) => app.setLoginItemSettings({ openAtLogin }),
      flatpak: inFlatpak(),
      execPath: process.execPath,
      home: os.homedir(),
    });

  // Default AN beim ERSTEN Pairing (Server soll ohne Zutun dauerlaufen) —
  // danach entscheidet nur noch der Schalter, nie wieder der Default.
  const ensureAutostartDefault = (): void => {
    if (!SERVER_MODE || storeGet('serverAutostart') !== undefined) return;
    storeSet('serverAutostart', true);
    osApplyAutostart(true);
  };

  if (SERVER_MODE) {
    // Boot-Sequenz: erst Zustands-Abgleich (Update-Check braucht Phase 'live'),
    // dann Ablöse-Check, dann Update-Check.
    void (async () => {
      await syncLifecycleFromContainer();
      await checkSupersedeOnce();
      await maybeUpdateContainer();
    })();
    setInterval(() => { void checkSupersedeOnce(); }, SUPERSEDE_CHECK_INTERVAL_MS).unref();
    setInterval(() => { void maybeUpdateContainer(); }, CONTAINER_UPDATE_INTERVAL_MS).unref();
    // Gepaart + Schalter an → OS-Autostart bei jedem Boot nachziehen (heilt
    // z.B. eine von Hand gelöschte .desktop-Datei).
    if (creds && storeGet('serverAutostart') === true) osApplyAutostart(true);
  }

  // Server-App: privilegierte Host-IPC (provision/start/stop/pair/unpair) nur
  // vom lokalen server.html (file://) zulassen — NICHT von der during der
  // Login-Phase geladenen howispulse.com-Seite (remote). Verhindert, dass eine
  // kompromittierte Remote-Seite den Server provisioniert/startet. Im Client-
  // Modus ohne Wirkung (SERVER_MODE=false → immer erlaubt; dort ruft die
  // vertraute Web-App das Host-IPC auf, bis App-Hosting entfernt ist).
  const localSenderOnly = (e: { sender?: { getURL?: () => string } }): boolean =>
    !SERVER_MODE || (e.sender?.getURL?.().startsWith('file:') ?? false);

  ipcMain.handle('host:start', (e) => {
    if (!localSenderOnly(e)) return;
    return hl.start();
  });
  ipcMain.handle('host:stop', (e) => {
    if (!localSenderOnly(e)) return;
    return hl.stop();
  });
  ipcMain.handle('host:status', () => hl.getStatus());
  // server.html ruft das bei jedem UI-Refresh — Zustands-Abgleich ist ein
  // No-Op außerhalb 'idle', also billig genug für jeden Aufruf.
  ipcMain.handle('host:refresh', async () => {
    await syncLifecycleFromContainer();
    return hl.getStatus();
  });
  // UI-Gating: gibt es eine Container-Runtime (Host-Podman/Docker)? Ohne die
  // zeigt die App-Hosting-Karte den Setup-Hinweis statt des Start-Knopfs.
  ipcMain.handle('host:runtime', () => manager.runtimeAvailable());
  // Windows-Erststart-Assistent: WSL2 mit UAC-Elevation installieren. Nach
  // Erfolg ist meist ein Neustart nötig — die Karte erklärt das.
  ipcMain.handle('host:setupWindows', async (e) => (localSenderOnly(e) ? { ok: await installWsl() } : { ok: false }));
  ipcMain.handle('host:pair', async (e, token: unknown) => {
    if (!localSenderOnly(e)) return { paired: false, error: 'forbidden' };
    if (typeof token !== 'string' || !token) return { paired: false, error: 'invalid token' };
    try {
      // Dev: gegen die lokale Dev-Cloud (Vite-Proxy → auth-svc) pairen statt
      // howispulse.com — sonst redeemt ein lokal gemintetes Bootstrap-Token gegen
      // die Prod-Cloud, die es nicht kennt. PULSE_DEV_URL ist nur im Dev gesetzt.
      const cloudOrigin = creds?.cloudOrigin ?? DEV_URL ?? 'https://howispulse.com';
      const fresh = await redeemBootstrap(token, cloudOrigin);
      saveCreds(hostStore, fresh);
      creds = fresh;
      ensureAutostartDefault();
      return { paired: true, status: sanitize(fresh) };
    } catch {
      // Generische Meldung — NIE eine aus dem Netz-/Fetch-Layer stammende
      // Fehlermeldung an den Renderer geben (könnte Token/Secret enthalten).
      return { paired: false, error: 'pairing failed' };
    }
  });
  ipcMain.handle('host:getPairing', () => sanitize(creds));
  ipcMain.handle('host:unpair', (e) => {
    if (!localSenderOnly(e)) return;
    clearCreds(hostStore);
    creds = null;
    // "Gerät zurücksetzen" nach einer Ablöse: der Container wurde schon vor
    // 'superseded' gestoppt (checkSupersedeOnce) — nur die Phase muss zurück
    // auf 'idle', sonst hängt die UI im Ablöse-Hinweis fest.
    if (hl.getStatus().phase === 'superseded') hl.resetToIdle();
  });
  // Login-basierte Auto-Provision (Server-App): findet die aktive Instanz des
  // eingeloggten Users, mintet + redeemt den Bootstrap-Token via Session-Cookie
  // — kein manuelles Token-Einfügen. ("einloggen, dann starten".)
  ipcMain.handle('host:provision', async (e, opts?: unknown) => {
    if (!localSenderOnly(e)) return { ok: false, error: 'forbidden' };
    // Übernahme-Bestätigung nur als exaktes true durchreichen — alles andere
    // aus dem Renderer bleibt der vorsichtige Kein-reset-Pfad.
    const confirmTakeover =
      typeof opts === 'object' && opts !== null &&
      (opts as { confirmTakeover?: unknown }).confirmTakeover === true;
    const result = await provision(PROD_URL, { confirmTakeover });
    if (result.ok) {
      creds = result.creds;
      saveCreds(hostStore, result.creds);
      ensureAutostartDefault();
      return { ok: true };
    }
    // Übernahme-Frage ist kein Fehler — Provisionierung pausiert nur, bis der
    // User im UI bestätigt oder abbricht.
    if (result.needsTakeoverConfirm) return { ok: false, needsTakeoverConfirm: true };
    // Der Renderer zeigt den Text nur im alert() — ohne Log ist ein Fehlschlag
    // nachträglich nicht diagnostizierbar. `error` trägt nie Token/Secrets.
    console.error('[provision] fehlgeschlagen:', result.error);
    return { ok: false, error: result.error };
  });
  // "In der Cloud registriert & auffindbar" (serverCloudStatus.ts): fragt den
  // Directory-Heartbeat der Instanz ab — ehrliches Signal, dass der Ausgang
  // funktioniert und Freunde den Server finden. null bei jedem Fehler.
  ipcMain.handle('host:cloudStatus', async (e) => {
    if (!localSenderOnly(e) || !creds) return { registered: null };
    return { registered: await fetchCloudStatus(creds.cloudOrigin, creds.instanceId) };
  });
  // Autostart-Schalter: Store ist die Wahrheit, OS-Zustand wird nachgezogen.
  ipcMain.handle('host:getAutostart', () => ({
    enabled: storeGet('serverAutostart') === true,
  }));
  ipcMain.handle('host:setAutostart', (e, enabled: unknown) => {
    if (!localSenderOnly(e)) return { ok: false };
    const on = enabled === true;
    storeSet('serverAutostart', on);
    return osApplyAutostart(on);
  });
  // "Deine Daten"-Karte: belegte Volume-Größe + Datum des letzten Exports.
  ipcMain.handle('host:dataInfo', async () => {
    const lastBackupAt = (storeGet('pulse.host.lastBackupAt') as number | undefined) ?? null;
    let sizeBytes: number | null = null;
    const rt = await manager.runtime().catch(() => null);
    if (rt && creds) {
      const running = await manager.isContainerRunning().catch(() => false);
      sizeBytes = await volumeSizeBytes(rt, resolveImage().image, running).catch(() => null);
    }
    return { sizeBytes, lastBackupAt };
  });
  // Export: Container stoppen (falls läuft) → Volume als tar in die vom User
  // gewählte Datei streamen → Container wieder starten (nur wenn er lief).
  // Schritte gehen als host:exportStep-Events an die Karte.
  ipcMain.handle('host:exportData', async (e) => {
    if (!localSenderOnly(e) || !creds) return { ok: false, error: 'forbidden' };
    const win = getWin();
    if (!win) return { ok: false, error: 'kein Fenster' };
    const sel = await dialog.showSaveDialog(win, {
      defaultPath: `pulse-server-backup-${new Date().toISOString().slice(0, 10)}.tar`,
      filters: [{ name: 'TAR-Archiv', extensions: ['tar'] }],
    });
    if (sel.canceled || !sel.filePath) return { ok: false, canceled: true };
    const rt = await manager.runtime().catch(() => null);
    if (!rt) return { ok: false, error: 'Keine Container-Runtime gefunden.' };
    const step = (s: string): void => getWin()?.webContents.send('host:exportStep', s);
    const wasRunning = await manager.isContainerRunning().catch(() => false);
    try {
      if (wasRunning) { step('stopping'); await manager.stop(); }
      step('exporting');
      const result = await exportVolume(rt, resolveImage().image, sel.filePath);
      if (result.ok) storeSet('pulse.host.lastBackupAt', Date.now());
      return result;
    } finally {
      // Immer wieder hochfahren, wenn er vorher lief — auch nach Export-Fehler.
      if (wasRunning) { step('restarting'); await hl.start().catch(() => {}); }
    }
  });
  // "Server aufgeben": vollständiger Aufgabe-Flow (Sequenz + Teil-Fehler-
  // Semantik in serverGiveUp.ts — hier nur die echten Ops). Im superseded-
  // Zustand sind die Creds bereits entwertet → Cloud-Löschung überspringen
  // (der Zweitknopf dort räumt nur das Gerät auf).
  ipcMain.handle('host:giveUp', async (e, opts?: unknown) => {
    if (!localSenderOnly(e) || !creds) return { ok: false };
    const deleteData = (opts as { deleteData?: boolean } | undefined)?.deleteData === true;
    const skipCloud = hl.getStatus().phase === 'superseded';
    const { cloudOrigin, instanceId } = creds;
    return runGiveUp({ deleteData, skipCloud }, {
      removeContainer: () => manager.removeContainer(),
      deleteCloudRegistration: () => deleteInstanceRegistration(cloudOrigin, instanceId),
      removeAutostart: () => {
        storeSet('serverAutostart', false);
        osApplyAutostart(false);
      },
      clearPairing: () => {
        clearCreds(hostStore);
        creds = null;
        hl.resetToIdle();
      },
      removeDataVolume: () => manager.removeDataVolume(),
    });
  });

  // Lebenszyklus: beim echten Beenden den Stack sauber stoppen.
  app.on('before-quit', () => { void manager.stop(); });
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
  'list_monitors',
  'list_windows',
  'list_application_audio',
  'build_argv',
  'start',
  'stop',
]);

/** Clamp a renderer-supplied slot to a valid stream slot (0..MAX_STREAM_SLOTS-1).
 *  A bad/absent value falls back to the primary slot 0 — never throws. */
function normaliseSlot(slot: unknown): number {
  const n = typeof slot === 'number' ? slot : 0;
  return Number.isInteger(n) && n >= 0 && n < MAX_STREAM_SLOTS ? n : 0;
}

function wireSidecar(): void {
  // One sidecar manager per slot; tag each slot's events with its slot so the
  // renderer can route them to the right stream's state. Registering the
  // callback does NOT spawn the child (still lazy on the first `call()`).
  for (let slot = 0; slot < MAX_STREAM_SLOTS; slot++) {
    getSidecar(slot).onEvent((ev) => {
      // Experimental-Version: bei Stream-Ende/Fehler die sidecar.log hochladen
      // (no-op, wenn die Rust-Version aus ist — prüft den Store selbst).
      onSidecarEventForUpload(ev, slot);
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('gsr:event', { ...ev, slot });
      }
    });
  }

  // Generic handler — the renderer calls `gsr:call` with an op name + params +
  // an optional slot. Catch everything so a bad op / dead sidecar surfaces as
  // `{ok:false}` in the renderer instead of an unhandled rejection.
  ipcMain.handle('gsr:call', async (_e, op: string, params: unknown, slot?: unknown) => {
    // Validate op against the allowlist (finding 156).
    if (!ALLOWED_GSR_OPS.has(op)) {
      return { ok: false, error: 'unknown op' };
    }
    try {
      return await getSidecar(normaliseSlot(slot)).call(op, params);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // Welcher Linux-Sidecar läuft (rust/gsr) und warum — der Kompatibilitäts-Tab
  // zeigt das an. Reine Pfadauflösung, startet nichts; `null` auf anderen
  // Plattformen oder wenn gar kein Sidecar auffindbar ist (getLinuxBackend()
  // wirft nicht — Auflösungsfehler sind dort bereits `null`).
  ipcMain.handle('gsr:backend', () => getLinuxBackend());
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
  // Capture source for the second HQ stream (slot 1).
  'capture_source_1',
  'audio_mode',
  // Persisted stream-settings that were missing from the allowlist (they are
  // in the renderer's PERSIST_KEYS, so without these the store rejected them).
  'audio_app',
  'excluded_apps',
  'overrides',
  'use_overrides',
  'show_cursor',
  'av_offset_ms',
  'custom_servers',
  // Multi-Server-Liste (vormals localStorage `pulse.servers`) — auf dem Desktop
  // in den chmod-600-Tresor verschoben statt im Klartext-Profil zu liegen.
  'pulse.servers',
  // Erster „gemischter" Key: Renderer toggelt ihn im „App"-Tab
  // (window.pulse.store.set), der Main-Prozess liest ihn synchron im
  // Fenster-close-Handler (quitOnClose → wirklich beenden statt Tray).
  'quitOnClose',
  // Kompatibilitäts-Tab (nur Linux-Desktop): Notbremse zurück auf den älteren
  // Python/GSR-Sidecar. Default (Key fehlt/false) = Rust. Renderer setzt ihn,
  // resolveLinuxSpawn() (sidecar.ts) liest ihn beim nächsten Spawn.
  'useLegacyGsrSidecar',
  // Diagnose-Logs des Linux-Sidecars hochladen. Eigener Opt-in, default aus —
  // hing früher am Rust-Toggle; seit Rust der Standard ist, wäre das eine
  // stille Telemetrie für jeden Linux-Nutzer gewesen.
  'uploadDiagnosticLogs',
  // HINWEIS: `pulse.host.creds` (③c-Pairing-Credentials) steht BEWUSST NICHT
  // hier. Der Main-Prozess schreibt sie via pairing.ts::saveCreds über einen
  // DIREKTEN storeSet-Aufruf (store.ts kennt keine Allowlist — die gilt nur für
  // die store:set-IPC-Kanäle). Würde der Key hier stehen, könnte der Renderer
  // die Creds über store:set überschreiben — unnötiges Schreib-Surface.
]);

/** Schlüssel, die der Renderer NIE lesen darf (③c-Sicherheitsinvariante).
 *  `pulse.host.creds` enthält `client_secret` + `relay_tunnel_token` im Klartext.
 *  Diese leben ausschließlich im Main-Prozess; der Renderer bekommt nur den
 *  sanitisierten Status über `host:getPairing`. Die store:read-Kanäle
 *  (get/getAll/getAllSync) MÜSSEN diesen Schlüssel ausblenden — sonst läge er
 *  über `window.pulse.store.get(...)` und passiv via `getAllSync()` (serversStore
 *  beim Boot) offen. (Schreibseitig ist der Key gar nicht erst in der Allowlist.) */
const RENDERER_BLOCKED_STORE_KEYS = new Set(['pulse.host.creds']);

/** Kopie ohne die renderer-gesperrten Schlüssel — für die store:getAll(Sync)-Kanäle. */
function stripBlockedKeys(all: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(all)) {
    if (!RENDERER_BLOCKED_STORE_KEYS.has(k)) out[k] = v;
  }
  return out;
}

function wireStore(): void {
  ipcMain.handle('store:get', (_e, key: string) => {
    if (RENDERER_BLOCKED_STORE_KEYS.has(key)) {
      console.warn('[store] store:get rejected blocked key:', key);
      return undefined;
    }
    try {
      return storeGet(key);
    } catch (e) {
      console.error('[store] store:get failed:', e);
      return undefined;
    }
  });
  ipcMain.handle('store:getAll', () => {
    try {
      return stripBlockedKeys(storeGetAll());
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
      e.returnValue = stripBlockedKeys(storeGetAll());
    } catch (err) {
      console.error('[store] store:getAllSync failed:', err);
      e.returnValue = {};
    }
  });

  // Echter Rechnername fürs Geräte-Label (z.B. "Pulse Desktop · michaels-thinkpad").
  // Nur die Desktop-App kann den Hostnamen lesen — im Browser gibt es dafür keine
  // API. Sync (sendSync) wie store:getAllSync, einmal beim Build des Labels.
  ipcMain.on('app:deviceNameSync', (e) => {
    try {
      e.returnValue = os.hostname();
    } catch (err) {
      console.error('[app] app:deviceNameSync failed:', err);
      e.returnValue = '';
    }
  });
  ipcMain.handle('store:set', (_e, key: string, value: unknown) => {
    if (!ALLOWED_STORE_KEYS.has(key)) {
      console.warn('[store] store:set rejected unknown key:', key);
      return;
    }
    try {
      storeSet(key, value);
      // Umschalten zwischen Rust- und GSR-Sidecar: Spawn-Cache invalidieren
      // und laufende (idle) Sidecar-Prozesse neu starten, damit die Umschaltung
      // beim nächsten Stream greift — ohne Pulse-Neustart. Ein evtl. gerade
      // laufender Test-Stream endet dabei (bewusste Nutzeraktion).
      if (key === 'useLegacyGsrSidecar') {
        resetSpawnTargetCache();
        void Promise.all(allSidecars().map((m) => m.shutdown())).catch((e) =>
          console.error('[store] sidecar restart after useLegacyGsrSidecar toggle failed:', e),
        );
      }
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

async function bootClient(): Promise<void> {
  // Dev-run Dock icon (macOS)
  if (process.platform === 'darwin' && !app.isPackaged && app.dock) {
    const iconPath = path.join(__dirname, '..', '..', 'build-resources', 'icon.png');
    try {
      const img = nativeImage.createFromPath(iconPath);
      if (!img.isEmpty()) app.dock.setIcon(img);
    } catch {
      // dev-only cosmetic — ignore
    }
  }

  // DIAG: Renderer-/GPU-Crash logging
  app.on('web-contents-created', (_e, contents) => {
    contents.on('render-process-gone', (_ev, details) => {
      console.error('[render-process-gone]', contents.getURL().slice(0, 80), JSON.stringify(details));
    });
    contents.on('unresponsive', () => console.error('[unresponsive]', contents.getURL().slice(0, 80)));
  });
  app.on('child-process-gone', (_e, details) => {
    console.error('[child-process-gone]', JSON.stringify(details));
  });

  // Kein Menü
  Menu.setApplicationMenu(null);

  // Store init (nicht Fenster-abhängig)
  initStore();
  wireStore();
  wireInvitePull();

  // Auto-Update läuft im Hintergrund (kein Boot-Splash mehr): die Haupt-App
  // startet sofort, `startUpdater` (weiter unten) lädt ein Update still herunter
  // und zeigt den „Update bereit"-Prompt im Hauptfenster-Renderer. Details:
  // updater.ts.
  wireHost(() => mainWindow);
  wireSidecar();
  wireScreenShare();
  wireNotify(() => mainWindow);
  wirePower();
  wireClipboard();
  wireGlobalShortcuts(() => mainWindow);

  createWindow();
  createTray(
    () => mainWindow,
    () => {
      isQuitting = true;
      app.quit();
    }
  );

  // Auto-Update: registriert die Renderer-Events + IPC-Handler und startet den
  // Boot- + periodischen Hintergrund-Check in EINEM Aufruf. Inert (Cleanup =
  // no-op), wenn kein gepackter Windows-Build (siehe updater.ts::startUpdater).
  // Die Cleanup-Funktion auf Modul-Scope, damit `before-quit` sie immer findet.
  stopUpdater = startUpdater(() => mainWindow);

  // Tray-Status IPC
  ipcMain.on('tray:setStatus', (_e, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return;
    const p = payload as Record<string, unknown>;
    const bool = (k: string): boolean | undefined => {
      const v = p[k];
      return typeof v === 'boolean' ? v : undefined;
    };
    const num = (k: string): number | undefined => {
      const v = p[k];
      return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
    };
    applyTrayStatus({
      muted: bool('muted'),
      deafened: bool('deafened'),
      unread: num('unread'),
      mentions: num('mentions'),
    });
  });

  // Tray-Image IPC
  ipcMain.handle('tray:setImage', (_e, dataUrl: unknown) => {
    if (typeof dataUrl !== 'string') return false;
    setTrayImageFromDataUrl(dataUrl);
    return true;
  });
}

// Server-App-Boot: kein Update-Splash, kein Client-Sidecar/ScreenShare/Updater —
// nur Host-IPC (Lochungs-Modus) + Fenster (server.html) + Tray + Basis-IPC.
async function bootServer(): Promise<void> {
  // initStore() ZUERST: wireHost() liest beim Verdrahten die Pairing-Creds
  // (loadCreds); ohne initStore() ist jeder storeGet/storeSet ein No-Op → die
  // App vergisst ihr Pairing bei jedem Neustart und landet wieder im Login.
  initStore();
  wireStore();
  wireHost(() => mainWindow);
  wireNotify(() => mainWindow);
  wirePower();
  wireClipboard();
  createWindow();
  createTray(
    () => mainWindow,
    () => { isQuitting = true; app.quit(); },
    { variant: 'server' },
  );
}

app.whenReady().then(() => void (SERVER_MODE ? bootServer() : bootClient()));

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
// Modul-Scope, damit `before-quit` ihn auch dann finden kann, wenn Quit
// feuert bevor `bootClient` den Timer ueberhaupt initialisiert hat.
// Initial ein no-op — sobald der Timer wirklich laeuft, wird die Funktion
// in `bootClient` ueberschrieben.
let stopUpdater: () => void = () => undefined;
app.on('before-quit', (event) => {
  isQuitting = true;
  stopUpdater();
  if (didShutdownSidecar) return;
  event.preventDefault();
  didShutdownSidecar = true;
  const done = () => app.quit();
  void Promise.race([
    Promise.all(allSidecars().map((s) => s.shutdown())),
    new Promise<void>((r) => setTimeout(r, 3_000)),
  ]).then(done, done);
});
