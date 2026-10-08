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
 *   E1b — the sidecar bridge (`sidecar.ts` + the `sidecar:*` IPC channels).
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

import { app, BrowserWindow, Menu, dialog, ipcMain, session, desktopCapturer, screen, shell, nativeImage, Notification, powerSaveBlocker } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { URL } from 'node:url';
import { execFile } from 'node:child_process';
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
  getSidecar,
  onSidecarCreated,
  sidecarRunning,
} from './sidecar';
import { playerManager, recordingDir, shadowClipPath } from './player';
import { auftragLesen, EingabeWeiche, erfassungSchalten } from './remoteInput';
import { RemoteEingabe } from './remoteInputHost';
import { zielFuerAblage, rolleLesen, endeAnstoss } from './ablageWeiche';
import { migriereAufStandardAn, onSidecarEventForUpload } from './experimental-log-upload';
import { initStore, storeGet, storeGetAll, storeSet, storeSetBatch } from './store';
import { istRendererGesperrt } from './storeSchluessel';
import { createTray, recreateTray, applyTrayStatus, setTrayImageFromDataUrl } from './tray';
import { wireNotify } from './notify';
import { wireSicherungRuecklauf } from './sicherungRuecklauf';
import { wirePower } from './power';
import { wireClipboard } from './clipboard';
import { startUpdater } from './updater';
import { wireGlobalShortcuts } from './shortcuts';
import { handleDeepLink, extractPulseUrl, takePendingInvite, isValidFqdn } from './deeplink';
import { HostLifecycle } from './hostLifecycle';
import type { HostDeps } from './hostLifecycle';
import { ContainerBackendManager, resolveImage, HOST_HTTP_PORT, setzeContainerWelt } from './localBackend/containerBackendManager';
import { NativeBackendManager, setzeNativeWelt } from './localBackend/nativeBackend/nativeBackendManager';
import { NATIVE_PORTS } from './localBackend/nativeBackend/types';
import { wslReady, installWslErgebnis, inFlatpak } from './localBackend/containerRuntime';
import { volumeSizeBytes, exportVolume, importVolume, lastAutoBackupAt } from './localBackend/dataTools';
import { httpHealth } from './localBackend/health';
import { lebtLivekitSignalweg, medienRundtrip, type ProbeSchritt } from './localBackend/medienprobe';
import { applyAutostart } from './autostart';
import {
  redeemBootstrap, loadCreds, saveCreds, clearCreds, loadCredsFuer, saveCredsFuer,
  probeUrl, sanitize, type BootstrapCreds,
} from './localBackend/pairing';
import { provision, deleteInstanceRegistration, fetchCloudStatus, fetchMe, setzeMintRueckruf } from './serverProvision';
import {
  createTokenGetter, saveAuth, loadAuth, clearAuth, revokeRefresh,
  WEB_ACCESS_KEY, WEB_REFRESH_KEY,
} from './serverAuth';
import { runGiveUp } from './serverGiveUp';
import { checkReachability } from './localBackend/reachability';
import { mapMediaPorts, loescheMappings } from './localBackend/portMapper';
import { diagnostiziere } from './localBackend/netdiag';
import { checkCredsSupersede, checkInstanceDeleted } from './serverSupersede';

/** Intervall für den periodischen Ablöse-Check (③c-Ergänzung) — 10 Min sind
 *  träge genug, um den Registry-Token-Realm nicht spürbar zu belasten, aber
 *  schnell genug, dass ein Zombie-Gerät binnen Minuten stoppt statt Tage. */
const SUPERSEDE_CHECK_INTERVAL_MS = 10 * 60_000;

/** Update-Check-Intervall für den Dauerläufer-Container: 24 h — der Pull ist
 *  nach dem ersten Mal nur ein Digest-Abgleich, aber häufiger bringt nichts
 *  (Recreate unterbricht den Server kurz). Zusätzlich einmal beim App-Boot. */
const CONTAINER_UPDATE_INTERVAL_MS = 24 * 60 * 60_000;

// Linux audio: name our PulseAudio/PipeWire streams "Pulse" instead of the
// Chromium default. Der HQ-Stream schliesst den eigenen Ton damit von der
// Desktop-Aufnahme aus (sonst wird die Wiedergabe der Sprach-Teilnehmer wieder
// mit aufgenommen → Echo); der Sidecar hängt seinen Ausschluss an genau diesen
// `node.name` (`capture/audio_router.rs`). PULSE_PROP liest libpulse, wenn
// Chromiums Audio-Dienst sich verbindet; hier gesetzt (vor jedem Electron-API)
// erbt der Kindprozess ihn. Kein Effekt auf Windows/macOS.
//
//   Hier stand bis zum 2026-08-27 ein Warnhinweis, der Sidecar müsse
//   PULSE_PROP vor dem Start abstreifen: der alte Python-Weg startete
//   `gpu-screen-recorder` als ENKELPROZESS, und der hätte sonst seinen eigenen
//   Aufnahme-Knoten in „Pulse" umbenannt und sich selbst stummgeschaltet. Der
//   Rust-Sidecar nimmt über PipeWire selbst auf, es gibt keinen Enkel mehr —
//   der Hinweis ist mit dem Python-Weg gegenstandslos geworden.
if (process.platform === 'linux' && !process.env.PULSE_PROP) {
  process.env.PULSE_PROP = 'node.name=Pulse';
}

// ── Dev-only: Zweitinstanz für den P2P-Selbsttest ────────────────────────────
// `PULSE_DEV_ZWEITINSTANZ=1` startet die App als zweites, UNABHÄNGIGES Fenster
// mit eigenem Profilverzeichnis: eigenes Login, keine Gerät-Registrierung, kein
// Streit um die Single-Instance-Sperre. Damit lässt sich der komplette
// Fernsteuerungs-Weg (Host und Steuernder) auf EINER Maschine testen — genau
// dafür ist er gebaut. In verpackten Builds ohne Wirkung auf den Regelbetrieb;
// die Umgebungsvariable muss bewusst gesetzt sein.
const DEV_ZWEITINSTANZ = process.env.PULSE_DEV_ZWEITINSTANZ === '1';
if (DEV_ZWEITINSTANZ) {
  app.setPath('userData', path.join(app.getPath('appData'), 'Pulse Zweitinstanz (Dev)'));
}

// Override the user-visible app name BEFORE any other Electron API touches it.
// `app.getName()` falls back to package.json `name`, which is `@dcc/desktop` —
// KDE/Plasma's StatusNotifier surfaces that as "@dcc/desktop status icon" in
// the tray. Set it to "Pulse" instead. `getName()` also drives `userData`, so
// migrate the existing config dir on first run (else `pulse-stream.json` with
// the user's HQ-stream settings would silently appear empty).
(function setupAppName(): void {
  // Eine Dev-Instanz gegen einen anderen Stack (PULSE_DEV_URL, nur ungepackt)
  // bekommt ein EIGENES Profil: sonst teilt sie Session und Krypto-Identität
  // mit der produktiven App — der Konto-Wechsel dort würde an der
  // Geräte-Wand (409) hängen — und der Single-Instance-Lock würde gegen eine
  // laufende Pulse.exe entscheiden. Gleiche Regel wie unter Linux
  // (seit 2026-09-02: ~/.config/Pulse-Dev).
  let newName = 'Pulse';
  if (SERVER_MODE) {
    newName = 'Pulse Server';
  } else if (process.env.PULSE_DEV_URL && !app.isPackaged) {
    newName = 'Pulse-Dev';
  }
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
// web-side fix is visible immediately, no Electron re-release needed (the sidecar
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
const OPEN_DEVTOOLS = process.env.PULSE_DEVTOOLS === '1' && !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
// Discord-style: closing the window hides it (the tray stays). The only path
// that actually quits is the tray's "Beenden" entry, which sets this flag
// before calling `app.quit()`. The window's `close` handler honours it.
let isQuitting = false;
/** Der Nutzer hat bewusst beendet (Tray „Beenden", Server-App-Knopf, Fenster-X
 *  mit quitOnClose) — im Gegensatz zu einem Ende, das das System auslöst
 *  (Herunterfahren, Abmelden der Desktop-Sitzung, SIGTERM). Nur ein bewusstes
 *  Beenden stoppt den Server-Container (Linux-Scan 2026-10-08, s. before-quit). */
let nutzerBeendet = false;
// Der Tray-"Beenden"-Callback — Client- und Server-Boot teilen ihn.
const quitApp = (): void => {
  isQuitting = true;
  nutzerBeendet = true;
  app.quit();
};

/** An das Hauptfenster senden — no-op, wenn es (oder seine webContents) schon
 *  weg sind. Ersetzt den dreifach kopierten Guard in den Sidecar-/Player-
 *  Ereignis-Relays. */
function sendToMainWindow(channel: string, payload: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

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
    // Server-App per Autostart: kein Fenster — sie läuft im Hintergrund, die
    // Benachrichtigung aus bootServer macht sie sichtbar (Scan 2026-10-08:
    // vorher öffnete sich das Fenster bei jedem Windows-Login).
    if (SERVER_MODE && process.argv.includes('--autostarted')) return;
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
      if (!isQuitting) nutzerBeendet = true; // Fenster-X mit quitOnClose
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
  // page that inherits the contextBridge (`window.pulse.sidecar.start()` etc.).
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
    // main window. `preload: null` ERZWINGT „browser-like" ab sofort: Electron-
    // Popups erben die webPreferences inklusive contextBridge-Preload — der
    // frühere Kommentar nahm das Gegenteil an. Explicit null strips the bridge,
    // damit ein Kind-Fenster nie `window.pulse` bekommt (Security-Scan
    // 2026-09-18). Typing sagt `preload?: string` — die Runtime nimmt null als
    // „kein Preload", der Cast umgeht nur die lückenhafte Typing.
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        webPreferences: {
          autoplayPolicy: 'no-user-gesture-required',
          preload: null as unknown as string,
        },
      },
    };
  });
  // Electron creates the allowed popup at about:blank and — in this
  // Electron/Chromium build — does NOT auto-navigate it to the requested URL,
  // so detached stream/watch windows stayed blank (white). Force the load here.
  // The child deliberately runs WITHOUT the contextBridge preload (stripped
  // via `preload: null` in the window-open override above — Security-Scan
  // 2026-09-18): the detached viewer needs nothing from `window.pulse`, and
  // running it as a plain (browser-like, `isElectron()===false`) window
  // matches the path that already works in a real browser. Re-apply the
  // off-origin nav guard though.
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

  // Fernsteuerung: der Renderer ist die einzige Stelle, die `remoteInputEnd`
  // ruft — und beim Neuladen (F5/Strg+R) oder nach einem abgestuerzten Renderer
  // kommt sie nie dazu. Der Sidecar-Prozess ueberlebt beides, also bliebe am
  // System gedrueckt, was in dem Moment gedrueckt war. Deshalb haengt das
  // Aufraeumen hier am Fenster, nicht am Renderer (s. `fernsteuerungAufraeumen`).
  mainWindow.webContents.on('did-start-navigation', (...args: unknown[]) => {
    // ZWEI SIGNATUREN, wie bei `console-message` weiter unten: neuer ein
    // Ereignis-Objekt mit den Feldern, aelter die Stellung
    // (event, url, isInPlace, isMainFrame, …).
    const d = args[0] as { isMainFrame?: boolean; isSameDocument?: boolean } | undefined;
    const hauptrahmen = typeof d?.isMainFrame === 'boolean' ? d.isMainFrame : args[3] === true;
    const imSelbenDokument =
      typeof d?.isSameDocument === 'boolean' ? d.isSameDocument : args[2] === true;
    // Nur echte Seitenwechsel des Hauptrahmens. Die SPA-Navigation der Web-App
    // und jedes eingebettete Fremdfenster (Watch-Party) feuern hier ebenfalls —
    // darauf die Eingabe freizugeben hiesse, eine laufende Fernsteuerung
    // abzuwuergen, weil jemand ein Video geoeffnet hat.
    if (!hauptrahmen || imSelbenDokument) return;
    fernsteuerungAufraeumen('Seitenwechsel/Neuladen');
  });
  mainWindow.webContents.on('render-process-gone', () =>
    fernsteuerungAufraeumen('Renderer weg'),
  );

  // Reload + DevTools accelerators used to come from Electron's default menu,
  // which we remove (setApplicationMenu(null)) to hide the menu bar. Re-add just
  // those shortcuts via before-input-event so the bar stays gone but F5 / reload
  // and the DevTools toggle work again. DevTools-Shortcuts NUR in ungepackten
  // Builds (Security-Scan 2026-09-18): im Produktiv-Build gibt es kein F12/
  // Ctrl+Shift+I — sonst inspiziert jeder lokale Nutzer (oder Renderer-
  // Social Engineering) die `window.pulse`-Bridge per Tastendruck.
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
      !app.isPackaged &&
      (key === 'f12' ||
        (mod && input.shift && key === 'i') || // Ctrl/Cmd+Shift+I (win/linux)
        (input.meta && input.alt && key === 'i')) // Cmd+Alt+I (macOS)
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
      // Startadresse NIE die Wurzel: `/` ist seit 2026-09-09 die Cloud-
      // Landingpage. Server-App-Login → `/login` (NICHT `/app`: jede
      // Navigation dorthin gilt startLoginWatch als Login-Erfolg);
      // Normal-App → `/app` (die Hülle schickt Ohne-Sitzung nach /login).
      mainWindow.loadURL(new URL('/login', TARGET_URL).href);
      startLoginWatch(mainWindow, TARGET_URL);
    }
  } else {
    void mainWindow.loadURL(new URL('/app', TARGET_URL).href);
    if (OPEN_DEVTOOLS) mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

/** Nach dem Login die Web-App-Tokens in den durablen Store der Server-App
 *  übernehmen — damit die Cloud-Calls (me/cloudStatus/provision/giveUp)
 *  App-Neustarts überleben (serverAuth).
 *
 *  Zwei Quellen, der Reihe nach:
 *  1. LEGACY: Token-Paar im localStorage der Cloud-Seite (bis Security-Audit
 *     2026-09-16 — der refresh_token lebte dort).
 *  2. COOKIE-MODUS (aktuelle Web-App): localStorage ist leer, der refresh
 *     reist im HttpOnly-pulse_rt-Cookie. Ein in-page /api/auth/refresh mit
 *     credentials:'include' mintet den access_token im Body — und der Browser
 *     persistiert die rotierte pulse_rt gleich mit in den Cookie-Store (das
 *     ist der entscheidende Punkt: net.request mit handgebautem Cookie-Header
 *     würde die Rotation VERWERFEN und den rt damit töten). Der gespeicherte
 *  refreshToken bleibt leer — createTokenGetter überspringt den Body-Refresh
 *  dann, und serverProvision mintet über den Cookie nach. */
async function captureAuthTokens(win: BrowserWindow): Promise<void> {
  try {
    const t = await win.webContents.executeJavaScript(
      `({ a: window.localStorage.getItem(${JSON.stringify(WEB_ACCESS_KEY)}), r: window.localStorage.getItem(${JSON.stringify(WEB_REFRESH_KEY)}) })`,
      true,
    );
    if (t && typeof t.a === 'string' && typeof t.r === 'string' && t.a && t.r) {
      saveAuth({ get: storeGet, set: storeSet }, { accessToken: t.a, refreshToken: t.r });
      return;
    }
    const minted = await win.webContents.executeJavaScript(
      `fetch('/api/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: '{}' })
         .then(r => r.ok ? r.json() : null).catch(() => null)`,
      true,
    ) as { access_token?: unknown } | null;
    if (minted && typeof minted.access_token === 'string' && minted.access_token) {
      saveAuth({ get: storeGet, set: storeSet }, { accessToken: minted.access_token, refreshToken: '' });
    }
  } catch { /* localStorage/fetch nicht lesbar → Cookie-Fallback */ }
}

/** Server-App: wechselt nach erfolgreichem Login vom howispulse.com-Login auf
 *  das lokale server.html.
 *
 *  Primärsignal ist die SPA-Navigation nach /app — sie feuert im selben Moment
 *  wie der Login-Erfolg. Der frühere 1,5-s-Cookie-Poll allein ließ die volle
 *  Chat-Oberfläche bis zum nächsten Tick aufblitzen; er bleibt nur als Netz
 *  für Wege ohne Navigation (z.B. Session war beim Start schon gültig). */
function startLoginWatch(win: BrowserWindow, loginOrigin: string): void {
  let done = false;
  const toServer = async () => {
    if (done || win.isDestroyed()) return;
    done = true;
    clearInterval(timer);
    // Tokens VOR dem Wechsel auf server.html greifen — danach ist die
    // Cloud-Seite (mit localStorage + Cookie-Kontext) weg.
    await captureAuthTokens(win);
    if (win.isDestroyed()) return;
    void win.loadFile(path.join(__dirname, 'server.html'));
  };
  const onNav = (_e: unknown, url: string) => {
    try {
      if (new URL(url).pathname.startsWith('/app')) toServer();
    } catch { /* unparsebare URL → ignorieren */ }
  };
  win.webContents.on('did-navigate-in-page', onNav);
  win.webContents.on('did-navigate', onNav);
  // Poll-Fallback für Wege ohne Navigation (Session war beim Start schon
  // gültig). Der Cookie gehört zur LOGIN-Cloud — hartcodiertes PROD_URL fand
  // im Dev-Cloud-Betrieb nie einen pulse_session und ließ das Fenster auf der
  // Login-Seite hängen.
  const timer = setInterval(async () => {
    if (win.isDestroyed()) { clearInterval(timer); return; }
    try {
      const cookies = await session.defaultSession.cookies.get({ name: 'pulse_session', url: loginOrigin });
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
  // Backend-Wahl: Windows fährt NATIV (Prozessbaum statt Container) — kein
  // WSL2, keine Virtualisierung im BIOS. PULSE_HOST_BACKEND=container optiert
  // den Podman/Docker-Pfad zurück (Dev/Test). Andere Plattformen bleiben beim
  // Container (macOS: gebündeltes Podman; Linux: System-Runtime).
  const NATIVE_BACKEND =
    process.platform === 'win32' && process.env.PULSE_HOST_BACKEND !== 'container';
  const manager: ContainerBackendManager | NativeBackendManager = NATIVE_BACKEND
    ? new NativeBackendManager()
    : new ContainerBackendManager();
  const hostStore = { get: storeGet, set: storeSet };
  // Welche Runtime den Server trägt, wird gemerkt (Linux-Scan 2026-10-08):
  // ohne Merker nahm die App bei jedem Start Podman vor Docker — kam Podman
  // neben einem Docker-Server dazu, entstand still ein leerer Server.
  if (manager instanceof ContainerBackendManager) {
    manager.setzeRuntimeMerker({
      lesen: () => {
        const k = storeGet('pulse.host.runtime');
        return k === 'podman' || k === 'docker' ? k : null;
      },
      schreiben: (kind) => storeSet('pulse.host.runtime', kind),
    });
  }
  // Benutzer-Welten (2026-10-01): die Welt (Container/Volume/Creds) gehört dem
  // Konto, das in der Server-App angemeldet ist. Beim Benutzerwechsel stoppt
  // die alte Welt (Daten bleiben im Volume), die des neuen Kontos kommt dran.
  const legacyCreds = loadCreds(hostStore);
  let weltUser: string | null = (storeGet('pulse.host.weltUser') as string | undefined) ?? null;
  let creds: BootstrapCreds | null = null;
  /** Jede creds-Änderung läuft hierdurch: der Manager braucht den aktuellen
   *  Stand für den Abschieds-Call beim Stopp — auch wenn er den Container
   *  dieser Sitzung nur adoptiert hat (nie start() sah). */
  const setCreds = (c: BootstrapCreds | null): void => {
    creds = c;
    manager.setzeCreds(c);
  };
  /** Realm-Kette wie login/logout/me/provision: gepairt → Instanz-Cloud,
   *  sonst Dev-URL, sonst Produktion. Bei jedem Aufruf frisch lesen — die
   *  Creds können sich zwischen zwei Aufrufen ändern. */
  const realmOrigin = (): string => creds?.cloudOrigin ?? DEV_URL ?? PROD_URL;
  if (weltUser && String(legacyCreds?.ownerId ?? '') !== weltUser) {
    setCreds(loadCredsFuer(hostStore, weltUser));
    setzeContainerWelt(`u${weltUser}`);
    setzeNativeWelt(`u${weltUser}`);
  } else {
    setCreds(legacyCreds); // Bestands-Welt: suffix-lose Namen, ohne Migration
  }
  // Durabler Cloud-Login (serverAuth): liefert einen gültigen Bearer-Token für
  // die Cloud-Calls und refresht bei Ablauf (überlebt App-Neustarts). null →
  // keine/tote Tokens → die Calls fallen auf den 30-Min-Cookie zurück bzw.
  // melden "nicht eingeloggt".
  const getAccessToken = createTokenGetter(hostStore);
  // Cookie-Mint-Rückruf (serverProvision): über den pulse_rt-Cookie gemintete
  // Access-Tokens dauerhaft im Store ablegen — der rt selbst bleibt im
  // HttpOnly-Cookie-Store der Session (30 Tage, überlebt App-Neustarts).
  setzeMintRueckruf((_origin, tokens) => {
    saveAuth(hostStore, tokens);
  });

  /** Die Container-Welt, die der Manager GERADE sieht ('null' = Legacy). */
  let aktiveContainerWelt: string | null = weltUser && String(legacyCreds?.ownerId ?? '') !== weltUser
    ? `u${weltUser}`
    : null;

  /** Benutzerwechsel: nur bei ECHTEM Weltwechsel anhalten (der erste /me auf
   *  der eigenen Bestands-Welt darf den laufenden Server nicht anfassen).
   *  Daten bleiben immer im Volume. */
  // Serialisiert (Scan 2026-10-08): zwei schnelle /me-Antworten hintereinander
  // dürfen nicht zwei Weltwechsel ineinander verschränken.
  let weltwechsel: Promise<void> = Promise.resolve();
  function wendeBenutzerAn(userId: string): Promise<void> {
    const lauf = weltwechsel.then(() => wendeBenutzerAnJetzt(userId));
    weltwechsel = lauf.catch(() => {});
    return lauf;
  }
  async function wendeBenutzerAnJetzt(userId: string): Promise<void> {
    const legacy = loadCreds(hostStore);
    const gehoertLegacy = String(legacy?.ownerId ?? '') === userId;
    const alteWelt = aktiveContainerWelt;
    const neueWelt: string | null = gehoertLegacy ? null : `u${userId}`;
    if (weltUser === userId && aktiveContainerWelt === neueWelt) return;
    if (neueWelt !== aktiveContainerWelt) {
      // Eine noch laufende Start-Sequenz der ALTEN Welt erst abwarten — sonst
      // sähe der Lauf-Check „läuft nicht", die alte Welt käme danach hoch und
      // die neue scheiterte an belegten Ports. `hl.stop()` setzt die Phase
      // zugleich auf idle (die UI zeigte sonst die alte Welt als live).
      await hl.warteAufStart();
      const lief = await manager.isContainerRunning().catch(() => false);
      if (lief) await hl.stop();
    }
    weltUser = userId;
    storeSet('pulse.host.weltUser', userId);
    setCreds(gehoertLegacy ? legacy : loadCredsFuer(hostStore, userId));
    setzeContainerWelt(neueWelt);
    setzeNativeWelt(neueWelt);
    const weltGewechselt = neueWelt !== alteWelt;
    aktiveContainerWelt = neueWelt;
    await syncLifecycleFromContainer().catch(() => {});
    // Modell „Anmeldung startet die Welt": wechselt die Welt und das neue
    // Konto hat einen eingerichteten Server, startet er von selbst.
    if (weltGewechselt && creds) void hl.start().catch(() => {});
    // Der Weltwechsel ändert ggf. NICHTS an der Phase (idle → idle), aber
    // SEHR WOHL am Pairing-Sichtbild (creds der neuen Welt) — ohne dieses
    // Event zeigte die UI weiter die Knöpfe der VORHERIGEN Welt.
    getWin()?.webContents.send('host:phase', {
      phase: hl.getStatus().phase,
      detail: null,
    });
  }

  const deps: HostDeps = {
    // Windows + Podman: podman machine braucht WSL2. Docker Desktop verwaltet
    // seine WSL-Umgebung selbst → Check nur für den Podman-Pfad. NATIV
    // (Windows-Default): keine Virtualisierung nötig — nur gebündelte Binaries.
    checkPrereqs: async () => {
      if (NATIVE_BACKEND) {
        return (await manager.runtimeAvailable()) ? 'ok' : 'not-possible-here';
      }
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
    // Router-Freigaben (NAT-PMP/PCP) mit abbauen: vorher stoppte der Stopp
    // nur die Erneuerung, die Ports blieben bis zu 1 h offen (Scan 2026-10-08).
    stopBackend: async () => {
      await manager.stop();
      await loescheMappings().catch(() => {});
    },
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
  // Solange der Server live ist, darf der Rechner nicht von selbst in den
  // Ruhezustand gehen (GNOME/KDE-Auto-Suspend am Netzteil): sonst ist der
  // Server offline, während die App „live" zeigt (Linux-Scan 2026-10-08).
  // Nur im Server-Modus, und nur gegen das AUTOMATISCHE Schlafen — ein
  // bewusstes Zuklappen oder „Bereitschaft" bleibt dem Nutzer.
  let schlafSperre: number | null = null;
  hl.onPhase((e) => {
    if (SERVER_MODE) {
      if (e.phase === 'live' && schlafSperre === null) {
        schlafSperre = powerSaveBlocker.start('prevent-app-suspension');
      } else if (e.phase !== 'live' && e.phase !== 'preparing' && schlafSperre !== null) {
        powerSaveBlocker.stop(schlafSperre);
        schlafSperre = null;
      }
    }
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
    if (running) {
      hl.markLive(deps.relayUrl());
      // Container lief über den App-Neustart hinweg weiter → der Host-UDP-
      // Relay (Win/Mac, Direktpfad-Port) muss trotzdem neu hoch (er lebt im
      // Electron-Prozess, nicht im Container).
      void manager.ensureRelay();
    }
  };

  // Ablöse-Erkennung: periodischer Creds-Check gegen den Registry-Token-Realm
  // (serverSupersede.ts). Ein eindeutiges 401 heißt: ein Re-Bootstrap auf
  // einem ANDEREN Gerät hat clientSecret rotiert — dieses Gerät ist Zombie.
  // Zusätzlich: steht die Instanz auf der öffentlichen Gelöscht-Liste, ist das
  // Pairing wertlos (Registry gibt dann 403, nie 401) → 'deleted', die UI
  // bietet "Neu einrichten" an. Netzwerkfehler/5xx sind fail-safe: keine Aktion.
  const checkSupersedeOnce = async (): Promise<void> => {
    if (!SERVER_MODE || !creds) return;
    const verdict = await checkCredsSupersede(creds);
    if (verdict === 'superseded') {
      await manager.stop().catch(() => {}); // Creds bleiben erhalten (Diagnose)
      hl.markSuperseded('rotated');
      return;
    }
    if (verdict === 'unknown' && (await checkInstanceDeleted(creds))) {
      await manager.stop().catch(() => {});
      hl.markSuperseded('deleted');
    }
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
        const c = creds;
        const registered = c
          ? await fetchCloudStatus(c.cloudOrigin, c.instanceId, () => getAccessToken(c.cloudOrigin))
          : null;
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
      // `args` wirkt nur unter Windows (Run-Key-Zeile) — ohne den Schalter
      // erkannte die App dort nie, dass sie per Autostart kam.
      setLoginItems: (openAtLogin) =>
        app.setLoginItemSettings({ openAtLogin, args: ['--autostarted'] }),
      flatpak: inFlatpak(),
      execPath: process.execPath,
      home: os.homedir(),
    });

  // Kein stiller Autostart-Default mehr: Autostart läuft ausschließlich, wenn
  // der Nutzer den Schalter in den Settings aktiviert (Befund 2026-10-04 —
  // der alte „Default AN beim ersten Pairing" ließ den Daemon unbemerkt im
  // Hintergrund laufen). `serverAutostart` bleibt bis zur ersten bewussten
  // Setzung undefined; der Boot-Abgleich unten greift nur bei `=== true`.

  if (SERVER_MODE) {
    // Boot-Sequenz: erst Zustands-Abgleich (Update-Check braucht Phase 'live'),
    // dann Ablöse-Check, dann Update-Check.
    void (async () => {
      await syncLifecycleFromContainer();
      // Eingerichtete, angemeldete Welt startet beim Boot von selbst (Scan
      // 2026-10-08): nativ gibt es kein `--restart unless-stopped`, und der
      // einzige Startweg war bisher der `host:me`-Abgleich — der braucht die
      // Cloud. Beim Windows-Login per Autostart ist das Netz oft noch nicht
      // da, der Server blieb dann aus. Abgemeldet (keine Tokens) bleibt die
      // Welt aus — „Abmelden stoppt die Welt" gilt über den Neustart hinweg.
      if (creds && loadAuth(hostStore) && hl.getStatus().phase === 'idle') {
        await hl.start().catch(() => {});
      }
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

  ipcMain.handle('host:start', async (e) => {
    if (!localSenderOnly(e)) return;
    await hl.start();
    // Start gescheitert → sofort die Ursache prüfen: eine gelöschte/abgelöste
    // Instanz würde sonst als generisches "Pause — bitte erneut versuchen"
    // enden und erst der 10-Min-Tick brächte die ehrliche Meldung.
    if (hl.getStatus().phase === 'something-paused') void checkSupersedeOnce();
  });
  ipcMain.handle('host:stop', (e) => {
    if (!localSenderOnly(e)) return;
    return hl.stop();
  });
  // „Server-App beenden"-Knopf in server.html — derselbe Weg wie der Tray-
  // Eintrag „Beenden". Nötig, weil GNOME ohne AppIndicator-Erweiterung kein
  // Tray-Symbol zeigt: das Fenster-X versteckt nur, die App war dort sonst
  // gar nicht zu beenden (Linux-Scan 2026-10-08).
  ipcMain.handle('host:quit', (e) => {
    if (!localSenderOnly(e)) return;
    quitApp();
  });
  ipcMain.handle('host:status', () => hl.getStatus());
  // server.html ruft das bei jedem UI-Refresh — Zustands-Abgleich ist ein
  // No-Op außerhalb 'idle', also billig genug für jeden Aufruf.
  ipcMain.handle('host:refresh', async (e) => {
    // Entscheidung 6.6: dasselbe Gate wie start/stop — der Aufruf führt
    // einen podman/docker-inspect aus; eine fern geladene howispulse.com-
    // Seite soll ihn nicht in Dauerschleife treten können.
    if (!localSenderOnly(e)) return hl.getStatus();
    await syncLifecycleFromContainer();
    return hl.getStatus();
  });
  // UI-Gating: gibt es eine Container-Runtime (Host-Podman/Docker)? Ohne die
  // zeigt die App-Hosting-Karte den Setup-Hinweis statt des Start-Knopfs.
  ipcMain.handle('host:runtime', () => manager.runtimeAvailable());
  // Windows-Erststart-Assistent: WSL2 mit UAC-Elevation installieren. Nach
  // Erfolg ist meist ein Neustart nötig — die Karte erklärt das.
  ipcMain.handle('host:setupWindows', async (e) =>
    (localSenderOnly(e) ? await installWslErgebnis() : { ok: false, neustartNoetig: false, abgebrochen: false }));
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
      setCreds(fresh);
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
    setCreds(null);
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
    console.log('[provision] begin, weltUser =', weltUser);
    // Übernahme-Bestätigung nur als exaktes true durchreichen — alles andere
    // aus dem Renderer bleibt der vorsichtige Kein-reset-Pfad.
    const confirmTakeover =
      typeof opts === 'object' && opts !== null &&
      (opts as { confirmTakeover?: unknown }).confirmTakeover === true;
    console.log('[provision] cloud call …');
    // Realm-Kette wie login/logout/me: gepairt → Instanz-Cloud, sonst Dev-URL,
    // sonst Produktion. Hartcodiertes PROD_URL fragte im Dev-Cloud-Betrieb
    // nach der falschen Session → "bitte zuerst einloggen" trotz Login.
    const provisionOrigin = realmOrigin();
    const result = await provision(provisionOrigin, { confirmTakeover }, () => getAccessToken(provisionOrigin));
    // Nur das Ergebnis, nie `result` selbst: bei Erfolg trägt es die
    // vollständigen Zugangsdaten (client_secret, Tunnel-Token).
    console.log('[provision] fertig:', result.ok ? `ok, Instanz ${result.creds.instanceId}` : 'nicht ok');
    if (result.ok) {
      setCreds(result.creds);
      // Bestands-Welt bleibt am Legacy-Schlüssel (suffix-lose Namen); jedes
      // andere Konto bekommt eigene Creds + eine eigene Welt.
      const legacyOwner = String(loadCreds(hostStore)?.ownerId ?? '');
      if (legacyOwner === String(result.creds.ownerId)) saveCreds(hostStore, result.creds);
      saveCredsFuer(hostStore, String(result.creds.ownerId), result.creds);
      weltUser = String(result.creds.ownerId);
      storeSet('pulse.host.weltUser', weltUser);
      // Container- UND native Welt plus der Merker, welche Welt der Manager
      // sieht — sonst startete nativ ein „Einrichten" vor dem ersten /me in
      // das Datenverzeichnis der Legacy-Welt (Scan 2026-10-08).
      const neueWelt = legacyOwner === weltUser ? null : `u${weltUser}`;
      setzeContainerWelt(neueWelt);
      setzeNativeWelt(neueWelt);
      aktiveContainerWelt = neueWelt;
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
    const c = creds;
    return { registered: await fetchCloudStatus(c.cloudOrigin, c.instanceId, () => getAccessToken(c.cloudOrigin)) };
  });
  // "Angemeldet als …": der eingeloggte Cloud-User (serverProvision.fetchMe).
  // Vor dem Pairing über PROD_URL (Login-Session), danach über die cloudOrigin
  // der Creds. null bei fehlender Session → die UI blendet die Zeile aus.
  ipcMain.handle('host:me', async (e) => {
    if (!localSenderOnly(e)) return null;
    // Dasselbe Realm wie host:login/-logout (realmOrigin).
    const origin = realmOrigin();
    const tokens = loadAuth(hostStore);
    const me = await fetchMe(origin, () => getAccessToken(origin)).catch(() => null);
    // Die Anmeldung bestimmt die Welt: beim ersten /me nach Login/Start auf
    // den angemeldeten Benutzer umschalten (asynchron — der Aufruf kehrt
    // sofort zurück, die Welt wechselt im Hintergrund).
    if (me && me.id) {
      void wendeBenutzerAn(String(me.id))
        .then(async () => {
          // Auch ohne Weltwechsel: gehört dem Konto ein Server und er läuft
          // nicht (z. B. nach geordnetem Stoppen), startet die Anmeldung ihn.
          if (creds && !(await manager.isContainerRunning().catch(() => false))) {
            await hl.start().catch(() => {});
          }
        })
        .catch(() => {});
    }
    // hatTokens: Escape-Hatch für die UI — Tokens vorhanden, aber /me fällt
    // durch (falsches Realm, abgelaufen, Netz) → "Abmelden" zeigen statt
    // "Anmelden", sonst hängt der User in einer Session fest, die er nicht
    // mehr loswird (beide Knöpfe wären falsch versteckt).
    return me ? { ...me, hatTokens: !!tokens } : { hatTokens: !!tokens };
  });
  // "Abmelden": Session-Cookies der Cloud löschen und zurück zum Login
  // navigieren — danach kann sich ein ANDERER User anmelden. Das Pairing
  // (Geräte-Creds) bleibt bewusst unangetastet; wer den Server wechseln will,
  // richtet ihn nach dem Neu-Login über "Server einrichten" neu ein (mit der
  // Übernahme-Warnung). startLoginWatch lädt nach erfolgreichem Login wieder
  // server.html.
  // "Anmelden" (ohne Pairing anzufassen): zum Login navigieren, damit ein
  // gepairter Server OHNE gültige Session (z.B. Erst-Migration auf den durablen
  // Login) eine Cloud-Session etablieren kann. startLoginWatch übernimmt nach
  // dem Login die Tokens (captureAuthTokens) und lädt server.html zurück.
  ipcMain.handle('host:login', async (e) => {
    if (!localSenderOnly(e)) return { ok: false };
    const win = getWin();
    if (win && !win.isDestroyed()) {
      // Dasselbe Realm wie die Status-Abfrage (host:me, realmOrigin).
      const loginOrigin = realmOrigin();
      await win.loadURL(loginOrigin + '/login');
      startLoginWatch(win, loginOrigin);
    }
    return { ok: true };
  });
  ipcMain.handle('host:logout', async (e) => {
    if (!localSenderOnly(e)) return { ok: false };
    // Dasselbe Realm wie login/me (realmOrigin) — gilt unverändert für den
    // ganzen Handler: das Pairing (creds) bleibt beim Logout bewusst angetastet.
    const origin = realmOrigin();
    // Durablen Refresh-Token serverseitig entwerten (best effort) + lokal löschen.
    const tokens = loadAuth(hostStore);
    if (tokens) await revokeRefresh(origin, tokens.refreshToken);
    clearAuth(hostStore);
    // Cookies UND localStorage der Cloud-Origin wischen — Letzteres ist zwingend:
    // die Web-App hält access_/refresh_token in localStorage und würde sich sonst
    // beim Zurück-zum-Login automatisch wieder als der ALTE User anmelden
    // (→ Logout wirkungslos). clearStorageData deckt beides ab.
    try {
      await session.defaultSession.clearStorageData({ origin, storages: ['cookies', 'localstorage'] });
    } catch { /* best effort */ }
    // Benutzer-Welt stoppen (Daten bleiben im Volume) — der nächste Login
    // startet die Welt des jeweiligen Kontos. Über den Lifecycle, damit die
    // Phase auf 'idle' fällt: `syncLifecycleFromContainer` kann nur auf
    // 'live' heben, nie senken — die UI blieb vorher nach dem Abmelden auf
    // 'live' stehen und der Cloud-Status-Poll lief weiter.
    await hl.stop();
    const win = getWin();
    if (win && !win.isDestroyed()) {
      await win.loadURL(new URL('/login', origin).href);
      startLoginWatch(win, origin);
    }
    return { ok: true };
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
  ipcMain.handle('host:dataInfo', async (e) => {
    // Dasselbe Gate wie host:refresh (Linux-Scan 2026-10-08): der Aufruf
    // startet bis zu zwei Wegwerf-Container (`du -sk /data`) — die in der
    // Login-Phase geladene Cloud-Seite soll ihn nicht in Schleife treten.
    if (!localSenderOnly(e)) return { sizeBytes: null, lastBackupAt: null, lastAutoBackupAt: null };
    const lastBackupAt = (storeGet('pulse.host.lastBackupAt') as number | undefined) ?? null;
    let sizeBytes: number | null = null;
    let lastAutoBackup: number | null = null;
    const rt = await manager.runtime().catch(() => null);
    if (NATIVE_BACKEND && rt) {
      // Nativer Pfad: kein Volume — Größen aus dem Datenverzeichnis.
      const info = await (manager as NativeBackendManager).dataInfo().catch(() => null);
      if (info) { sizeBytes = info.sizeBytes; lastAutoBackup = info.lastAutoBackupAt; }
    } else if (rt && rt.kind !== 'native' && creds) {
      const running = await manager.isContainerRunning().catch(() => false);
      sizeBytes = await volumeSizeBytes(rt, resolveImage().image, running).catch(() => null);
      // Automatische pg_dumps des Backup-Services — ohne sie würde die UI
      // „Noch kein Backup erstellt" zeigen, obwohl täglich gesichert wird.
      lastAutoBackup = await lastAutoBackupAt(rt, resolveImage().image, running).catch(() => null);
    }
    return { sizeBytes, lastBackupAt, lastAutoBackupAt: lastAutoBackup };
  });
  // Verbindungs-Check (Stufe 2, Plan 2026-09-30): lokale Glieder — nur die
  // App kann sie sehen — plus DIESELBE Cloud-Kette wie die Instance-Diagnose
  // im Web. Auth als Weg 1 (Pairing-Creds, der Installer-Weg): das Fenster
  // hält zwar einen Session-Cookie, aber Renderer-Fetches auf die Cloud
  // rennen in CORS (server.html lebt auf file://) — der Main-Prozess
  // authentifiziert sich stattdessen als die Instanz selbst.
  ipcMain.handle('host:verbindungstest', async (e) => {
    if (!localSenderOnly(e) || !creds) return { ok: false, error: 'forbidden' };
    const deutsch = app.getLocale().toLowerCase().startsWith('de');
    const S = (de: string, en: string): string => (deutsch ? de : en);
    const lokal: {
      schritt: string; titel: string; ok: boolean; was_ist: string; was_tun: string; einzelheit?: string;
    }[] = [];
    const push = (
      schritt: string, titel: string, ok: boolean, was_ist: string, was_tun: string,
      einzelheit?: string,
    ): void => {
      lokal.push({ schritt, titel, ok, was_ist, was_tun, ...(einzelheit ? { einzelheit } : {}) });
    };

    const rt = await manager.runtime().catch(() => null);
    if (NATIVE_BACKEND) {
      push(
        'runtime', S('Server-Komponenten', 'Server components'), !!rt,
        S('Die gebündelten Server-Bausteine fehlen auf diesem Gerät.',
          'The bundled server components are missing on this device.'),
        S('Server-App neu installieren.', 'Reinstall the server app.'),
      );
    } else {
      // „Installiert, aber nicht benutzbar" (Docker-Dienst aus, kein Recht an
      // docker.sock, Podman ohne subuid) bekommt seinen eigenen Grund —
      // vorher stand hier „nicht gefunden", obwohl das Programm da war.
      const problem = manager instanceof ContainerBackendManager
        ? await manager.runtimeProblem().catch(() => null)
        : null;
      push(
        'runtime', S('Container-Runtime', 'Container runtime'), !!rt && !problem,
        problem ?? S('Docker oder Podman wurde auf diesem Gerät nicht gefunden.',
          'Docker or Podman was not found on this device.'),
        problem
          ? S('Den genannten Grund beheben und die Server-App neu starten.',
            'Fix the reason above and restart the server app.')
          : S('Podman (empfohlen) oder Docker installieren und die Server-App neu starten.',
            'Install Podman (recommended) or Docker and restart the server app.'),
      );
    }
    const laeuft = rt ? await manager.isContainerRunning().catch(() => false) : false;
    push(
      'container',
      NATIVE_BACKEND ? S('Server-Prozesse', 'Server processes') : S('Server-Container', 'Server container'),
      laeuft,
      NATIVE_BACKEND
        ? S('Die Server-Prozesse laufen nicht.', 'The server processes are not running.')
        : S('Der Server-Container ist gestoppt.', 'The server container is stopped.'),
      S('Knopf „Server starten“ oben betätigen.', 'Press the "Start server" button above.'),
    );
    let healthOk = false;
    if (rt && laeuft) {
      // host-Networking (Windows: Container in der podman-VM) bindet 8080 an
      // die VM-IP; sonst am veröffentlichten 127.0.0.1-Port — wie in start().
      // Nativ: Caddys Desktop-Port. `httpHealth` wirft nie, sondern liefert
      // false — das frühere `.then(() => true)` machte das Glied deshalb
      // IMMER grün (Scan 2026-10-08), und nativ fragte es obendrein den
      // Container-Port ab, auf dem dort niemand lauscht.
      const vmIp = rt.kind === 'podman' && process.platform === 'win32'
        ? await manager.vmIp().catch(() => null)
        : null;
      const url = rt.kind === 'native'
        ? `http://127.0.0.1:${NATIVE_PORTS.caddyDesktop}/api/chat/health`
        : `http://${vmIp ?? '127.0.0.1'}:${vmIp ? 8080 : HOST_HTTP_PORT}/api/chat/health`;
      healthOk = await httpHealth(url);
    }
    push(
      'health', S('Innere Gesundheit', 'Inner health'), healthOk,
      S('Der Container antwortet am Verwaltungsport nicht.',
        'The container does not answer on its management port.'),
      S('Eine Minute warten. Bleibt der Schritt rot: Server stoppen und wieder starten.',
        'Wait a minute. If it stays red: stop and start the server again.'),
    );
    const backup = rt && laeuft && rt.kind !== 'native'
      ? await lastAutoBackupAt(rt, resolveImage().image, true).catch(() => null)
      : NATIVE_BACKEND && laeuft
        ? await (manager as NativeBackendManager).dataInfo().then((i) => i.lastAutoBackupAt).catch(() => null)
        : null;
    // Windows-Container-Betrieb: der Medienweg hängt an den Host-Relays in die
    // VM. Ein Relay ohne gebundene Ports (Port belegt, VM-IP gewechselt) war
    // bislang in keinem Glied zu sehen (Scan 2026-10-08).
    if (rt?.kind === 'podman' && process.platform === 'win32' && laeuft
      && manager instanceof ContainerBackendManager) {
      await manager.ensureRelay().catch(() => {});
      const z = manager.relayZustand();
      push(
        'relays', S('Medien-Weiterleitung', 'Media forwarding'),
        z.mirrored || z.udpPorts.length > 0,
        S('Die Weiterleitung für Sprache und Bild in die Server-VM steht nicht.',
          'Forwarding of voice and video into the server VM is not up.'),
        S('Server stoppen und starten. Bleibt es rot: prüfen, ob ein anderes Programm die Ports 7882–7892 belegt.',
          'Stop and start the server. If it stays red: check whether another program uses ports 7882–7892.'),
        z.mirrored
          ? S('WSL im Mirrored-Modus — keine Weiterleitung nötig.', 'WSL in mirrored mode — no forwarding needed.')
          : `VM ${z.vmIp ?? '?'} · UDP ${z.udpPorts.join(', ') || '—'} · TCP ${z.tcpPorts.join(', ') || '—'}`,
      );
    }
    // Linux + Docker-Bridge: LiveKit sieht im Container nur 172.17.x und per
    // STUN die öffentliche Adresse, nicht die LAN-Adresse dieses Rechners —
    // und kann in der Bridge keine zusätzliche ankündigen (mediatransportutil:
    // NodeIP wird bei use_external_ip von STUN überschrieben). Geräte im
    // selben WLAN brauchen dann Hairpin-NAT am Router oder einen Browser, der
    // seine echten Adressen zeigt. Unter rootless Podman/pasta sieht der
    // Container die LAN-Adresse selbst — dort trägt der Weg (Linux-E2E).
    if (rt?.kind === 'docker' && process.platform === 'linux' && laeuft) {
      push(
        'heimnetz-sprache', S('Sprache im Heimnetz', 'Voice on the home network'), false,
        S('Mit Docker kennt der Sprachserver die Adresse dieses Rechners im Heimnetz nicht. Geräte im selben WLAN kommen je nach Router und Browser nicht in den Sprachkanal; Gäste aus dem Internet sind nicht betroffen. Streams sind nicht betroffen.',
          'With Docker the voice server does not know this computer\'s home-network address. Devices on the same Wi-Fi may fail to join voice, depending on router and browser; guests from the internet are not affected. Streams are not affected.'),
        S('Wenn Geräte im WLAN nicht in den Sprachkanal kommen: den Server mit Podman statt Docker betreiben. Ein Wechsel geht derzeit nur über Export, Neueinrichtung und Import der Daten.',
          'If devices on the Wi-Fi cannot join voice: run the server with Podman instead of Docker. Switching currently requires exporting, setting up again and importing your data.'),
      );
    }
    // Nativ (Windows) gibt es keinen Backup-Dienst (`components.ts`) — der
    // Container-Text „sichert täglich selbst" wäre dort eine falsche
    // Beruhigung (Scan 2026-10-08). Stattdessen der Handgriff, der wirklich
    // sichert: der Export.
    push(
      'backup', S('Automatisches Backup', 'Automatic backup'), !!backup,
      NATIVE_BACKEND
        ? S('Auf diesem Gerät läuft keine automatische Sicherung.',
          'No automatic backup runs on this device.')
        : S('Es gibt noch keinen automatischen Datenbank-Snapshot.',
          'There is no automatic database snapshot yet.'),
      NATIVE_BACKEND
        ? S('Regelmäßig unter „Deine Daten" mit „Alles exportieren" eine Sicherung anlegen und sie außerhalb dieses Geräts aufbewahren.',
          'Use "Export everything" under "Your data" regularly and keep the file off this device.')
        : S('Nichts zu tun — der Backup-Service sichert täglich selbst; nach der Erstinstallation dauert es bis zum ersten Lauf.',
          'Nothing to do — the backup service backs up daily on its own; after first setup the first run takes a while.'),
    );

    // Medien: Signalweg zu LiveKit + WHIP/WHEP-Rundtrip (nur mit laufendem
    // Container und Relay-Adresse sinnvoll; dass echte Medien-Pakete auch von
    // AUSSEN durchkommen, beweist der erste echte Teilnehmer im Heimnetz-Fall
    // nicht — die Probe läuft im selben Netz wie der Server).
    if (rt && laeuft && creds) {
      const relay = creds.relaySubdomain ?? creds.hostname;
      if (relay) {
        const signalOk = await lebtLivekitSignalweg(relay);
        push(
          'livekit-signal', S('Sprache (Signalweg)', 'Voice (signaling)'), signalOk,
          S('Über die Relay-Adresse kommt kein Kontakt zum Sprachserver zustande.',
            'No contact with the voice server via the relay address.'),
          S('Server läuft? Kurz warten und erneut prüfen. Bleibt es rot: Server stoppen und starten.',
            'Server running? Wait a moment and check again. If it stays red: stop and start the server.'),
        );
        // Sitzungs-Cookie des Fensters — der Cloud-Ticket braucht ihn.
        const cookies = await session.defaultSession.cookies
          .get({ name: 'pulse_session', url: creds.cloudOrigin }).catch(() => []);
        const sessionCookie = cookies[0]?.value ? `pulse_session=${cookies[0].value}` : '';
        const medien = await medienRundtrip({
          relayHost: relay,
          cloudOrigin: creds.cloudOrigin,
          sessionCookie,
          sprache: deutsch ? 'de' : 'en',
        }).catch((err: Error) => ({
          ok: false, befund: 'abgebrochen',
          was_ist: S('Die Stream-Prüfung brach mit einem Fehler ab.',
            'The stream check aborted with an error.'),
          was_tun: S('Erneut prüfen. Bleibt es rot: Server stoppen und starten.',
            'Check again. If it stays red: stop and start the server.'),
          einzelheit: err.message,
        } as ProbeSchritt));
        // „Signalweg", nicht „Senden + Empfangen": die Probe prüft WHIP/WHEP-
        // Signalisierung über HTTP, kein ICE — ob UDP-Medien durch eine
        // Firewall kommen, sieht sie nicht (Linux-Scan 2026-10-08).
        push('medien', S('Streams (Signalweg)', 'Streams (signaling)'), medien.ok,
          medien.was_ist, medien.was_tun, medien.einzelheit);
      }
    }

    let cloud: unknown = null;
    let cloudFehler: string | null = null;
    try {
      const r = await fetch(
        `${creds.cloudOrigin}/api/auth/selfhost/diagnose/${creds.instanceId}`,
        {
          method: 'POST',
          headers: {
            'x-pulse-client-id': creds.clientId,
            'x-pulse-client-secret': creds.clientSecret,
            'Accept-Language': deutsch ? 'de' : 'en',
          },
        },
      );
      if (r.ok) cloud = await r.json();
      else cloudFehler = `HTTP ${r.status}`;
    } catch (err) {
      cloudFehler = (err as Error).message;
    }
    return { ok: true, lokal, cloud, cloudFehler };
  });
  // Export: Container stoppen (falls läuft) → Volume als tar in die vom User
  // gewählte Datei streamen → Container wieder starten (nur wenn er lief).
  // Schritte gehen als host:exportStep-Events an die Karte.
  // Gemeinsamer Rahmen für Export/Import: Container stoppen (falls läuft),
  // Operation ausführen, IMMER wieder hochfahren, wenn er vorher lief — auch
  // nach einem Fehler. Schritte gehen als host:exportStep-Events an die Karte.
  const step = (s: string): void => getWin()?.webContents.send('host:exportStep', s);
  // Über den Lebenszyklus (Linux-Scan 2026-10-08): vorher hielt dieser Weg
  // ihn nicht an — ein fälliges Update oder ein `host:me`-Start konnte mitten
  // in einen bis zu 60-minütigen Import laufen und Postgres auf einem Volume
  // starten, das gerade getauscht wird.
  const withContainerStopped = <T>(op: () => Promise<T>): Promise<T> =>
    hl.pausiertFuer(() => manager.isContainerRunning(), () => op(), step);

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
    return withContainerStopped(async () => {
      step('exporting');
      // Nativer Pfad: tar aus dem Datenverzeichnis statt Volume-Export.
      if (rt.kind === 'native') {
        const result = await (manager as NativeBackendManager).exportData(sel.filePath as string);
        if (result.ok) storeSet('pulse.host.lastBackupAt', Date.now());
        return result;
      }
      const result = await exportVolume(rt, resolveImage().image, sel.filePath as string);
      if (result.ok) storeSet('pulse.host.lastBackupAt', Date.now());
      return result;
    });
  });
  // Import: Gegenstück zum Export — Backup-tar wählen, Container stoppen
  // (falls läuft), /data ERSETZEN (importVolume leert vorher), Container
  // wieder starten. Die Bestätigung ("ersetzt alle aktuellen Daten") holt die
  // UI VOR diesem Aufruf ein; Schritte laufen über denselben
  // host:exportStep-Kanal ('stopping'/'importing'/'restarting').
  ipcMain.handle('host:importData', async (e) => {
    if (!localSenderOnly(e) || !creds) return { ok: false, error: 'forbidden' };
    const win = getWin();
    if (!win) return { ok: false, error: 'kein Fenster' };
    const sel = await dialog.showOpenDialog(win, {
      filters: [{ name: 'TAR-Archiv', extensions: ['tar'] }],
      properties: ['openFile'],
    });
    if (sel.canceled || !sel.filePaths[0]) return { ok: false, canceled: true };
    const rt = await manager.runtime().catch(() => null);
    if (!rt) return { ok: false, error: 'Keine Container-Runtime gefunden.' };
    return withContainerStopped(async () => {
      step('importing');
      if (rt.kind === 'native') {
        const r = await (manager as NativeBackendManager).importData(sel.filePaths[0]);
        // Das ganze Ergebnis, nicht `r.ok`: server.js liest `r.ok` und
        // `r.error` — mit dem nackten Boolean meldete ein ERFOLGREICHER
        // nativer Import „Import fehlgeschlagen: unbekannt" (Scan 2026-10-08).
        return r;
      }
      return importVolume(rt, resolveImage().image, sel.filePaths[0]);
    });
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
      deleteCloudRegistration: () => deleteInstanceRegistration(cloudOrigin, instanceId, () => getAccessToken(cloudOrigin)),
      removeAutostart: () => {
        storeSet('serverAutostart', false);
        osApplyAutostart(false);
      },
      clearPairing: () => {
        clearCreds(hostStore);
        setCreds(null);
        hl.resetToIdle();
      },
      removeDataVolume: () => manager.removeDataVolume(),
    });
  });

  // Lebenszyklus: beim echten Beenden den Stack sauber stoppen — über den
  // gebündelten before-quit-Handler unten, der darauf WARTET. Ein eigenes
  // `void manager.stop()` hier lief gegen `app.quit()` und verlor: nativ
  // blieben Postgres und die Python-Dienste als Waisen stehen (Windows beendet
  // Kinder nicht mit dem Elternteil), und der nächste NSIS-Update scheiterte
  // an den gesperrten Dateien (Scan 2026-10-08).
  hostBackendStoppen = async (anlass) => {
    // Container-Weg: nur ein bewusstes Beenden stoppt den Container. Endet die
    // App, weil das System herunterfährt oder die Sitzung endet, bleibt er
    // stehen — ein `docker stop` hier markierte ihn als „vom Nutzer gestoppt",
    // und `--restart unless-stopped` brachte ihn nach dem Neustart NICHT
    // wieder (Linux-Scan 2026-10-08). Nativ stirbt der Prozessbaum ohnehin
    // mit der Sitzung — dort immer geordnet stoppen (Postgres-Checkpoint).
    if (anlass === 'system' && !NATIVE_BACKEND) return;
    await manager.stop();
    await loescheMappings().catch(() => {});
  };
}

// ── Sidecar bridge (E1b) ────────────────────────────────────────────────
// `sidecar.ts` owns the platform sidecar child process + the newline-JSON
// protocol; here we only wire it to IPC. The sidecar is still spawned lazily
// on the first `sidecar:call` — registering the event callback below does NOT
// start it.

/** Allowed sidecar ops (finding 156) — any op not in this set is silently rejected
 *  with {ok: false} to prevent a compromised renderer from invoking unexpected
 *  sidecar operations. The set contains exactly the ops declared in pulse.d.ts
 *  and exposed via the preload. */
const ALLOWED_SIDECAR_OPS = new Set([
  // Bughunt Pass 4 REGRESSION FIX: 'health' wurde im Ponytail-Durchlauf
  // versehentlich mit dem toten player.health together entfernt — der
  // Sidecar health probe ist aber der EINZIGE Weg, stream.sidecarAvailable
  // zu setzen. Ohne diesen Op startet der Sidecar nie und der Raketen-
  // Knopf bleibt für immer unsichtbar.
  'health',
  'gpu_info',
  'list_monitors',
  'list_windows',
  'list_application_audio',
  'build_argv',
  'start',
  'stop',
  // **Direktverbindung (P2P):** SDP-Austausch mit dem Sidecar des Platzes und
  // das Lösen der Direktverbindung. Keine Zuordnung, keine Rechte-Entscheidung
  // — die Sitzung dahinter hat der Consent schon geprüft (`remote_signal`
  // fließt nur in aktiven Sitzungen); hier geht es nur um die ZULEITUNG.
  'direct_offer',
  'direct_stop',
]);

/** Clamp a renderer-supplied slot to a valid stream slot (0..MAX_STREAM_SLOTS-1).
 *  A bad/absent value falls back to the primary slot 0 — never throws. */
function normaliseSlot(slot: unknown): number {
  const n = typeof slot === 'number' ? slot : 0;
  return Number.isInteger(n) && n >= 0 && n < MAX_STREAM_SLOTS ? n : 0;
}

/**
 * Fernsteuerung, Host-Seite: Buchfuehrung darueber, welche Stream-Plaetze eine
 * Eingabe-Sitzung haben (s. `remoteInputHost.ts`).
 *
 * Auf Modulebene statt in `wireSidecar()`, weil nicht nur die IPC-Handler sie
 * brauchen: bei einem Neuladen des Renderers muss auch der Fensterteil unten
 * herankommen (s. `fernsteuerungAufraeumen`).
 */
const remoteEingabe = new RemoteEingabe(
  (slot, op, params) => getSidecar(slot).call(op, params),
  MAX_STREAM_SLOTS,
  // Ein Platz ohne laufenden Sidecar ist ein unbekannter Platz. Die Auskunft
  // muss von hier kommen: `remoteInputHost.ts` bleibt electron-frei, und
  // `getSidecar()` waere die falsche Frage — sie legt den Verwalter an.
  sidecarRunning,
);

/**
 * Alles fallen lassen, was an einer Fernsteuerung haengt.
 *
 * Gerufen, wenn die Gegenstelle im Renderer verschwindet: Neuladen (F5,
 * Strg+R), abgestuerzter Renderer, Wechsel der geladenen Seite. `#reset()` im
 * Renderer laeuft dabei NICHT — und der Sidecar-Prozess lebt weiter. Ohne
 * dieses Aufraeumen bliebe am System gedrueckt, was im Moment des Neuladens
 * gedrueckt war: im Spiel liefe die W-Taste weiter, und niemand kann sie
 * loslassen, weil die Sitzung, die sie gedrueckt hat, nicht mehr existiert.
 */
function fernsteuerungAufraeumen(grund: string): void {
  // **Die Zwischenablage zuerst, und ohne die Abkuerzung darunter.** Der
  // Host-Sidecar haelt sie womoeglich mit verzoegertem Rendern; nach einem
  // Neuladen lebt er mit `wach = true` weiter, waehrend niemand mehr zuhoert.
  // Jedes lokale Strg+V des Host-Nutzers loeste dann `WM_RENDERFORMAT` aus,
  // ein `hol` ginge ins Leere, und nach der Abruf-Frist bekaeme er zwei
  // Sekunden spaeter NICHTS — fuer den Rest des Streams, samt verlorenem
  // Vorbestand (Befund B1). Der Steuernde hat das Problem nicht, er wird ueber
  // `input_capture:false` mit abgeraeumt.
  //
  // Vor der Abkuerzung, weil die Ablage auch ohne eine einzige Eingabe-Sitzung
  // beansprucht sein kann: `beginn` haengt an der Sitzung, nicht an Frames.
  ablageAufraeumen();
  const offen = remoteEingabe.offen();
  const angemeldet = eingabeWeiche.angemeldet();
  if (offen.length === 0 && angemeldet.length === 0) return;
  console.log('[fernsteuerung] aufgeraeumt wegen', grund, { offen, angemeldet });
  void remoteEingabe.beenden(); // Host: alles Gedrueckte freigeben
  // Steuernder: die ERFASSUNG im Player-Fenster ausschalten (Bughunt R2).
  // Der Player ist ein eigener Prozess und ueberlebt den Renderer — ohne
  // diesen Ruf blieben Erfassung, Zeigerfang, Fern-Vorhalt und die gesenkte
  // Jitter-Geduld fuer den Rest des Fensters an: ein Fenster, das Maus und
  // Tastatur schluckt und nirgendwohin leitet, ohne einen Weg hinaus (das
  // Griff-Menue verlangt eine aktive Sitzung, die es nicht mehr gibt). Die
  // Hoch-Ereignisse, die der Player daraufhin nachreicht, verpuffen hier
  // bewusst — es gibt keinen Renderer mehr, der sie absetzen koennte; die
  // Host-Seite gibt ueber remote_input_end selbst frei.
  for (const session of angemeldet) {
    void playerManager
      .call('input_capture', { session, enabled: false })
      .catch(() => undefined);
  }
  eingabeWeiche.alleAbmelden(); // Steuernder: Zuordnungen zeigen ins Leere
}

/**
 * Den Host-Sidecars sagen, dass ihre Ablage-Sitzung vorbei ist.
 *
 * **Nur an LAUFENDE Sidecars** (`sidecarRunning`): `getSidecar()` spawnt lazy,
 * ein Ruf an einen unbelegten Platz startete also einen Prozess, nur um ihm zu
 * sagen, dass er nichts zu tun hat — dieselbe Zurueckhaltung, die
 * `remoteInputHost.ts` an drei Stellen uebt.
 *
 * Ein `ende` an einen Sidecar, der nie ein `beginn` gesehen hat, ist folgenlos:
 * seine Zustandsmaschine ist nicht wach und seine Plattform nicht wirksam.
 * Gebucht wird hier nichts — welcher Platz Traeger war, weiss der Renderer, und
 * den gibt es in diesem Moment gerade nicht mehr.
 */
function ablageAufraeumen(): void {
  for (let slot = 0; slot < MAX_STREAM_SLOTS; slot++) {
    if (!sidecarRunning(slot)) continue;
    void getSidecar(slot)
      .call('ablage', { data: endeAnstoss() })
      .catch(() => undefined);
  }
}

function wireSidecar(): void {
  // One sidecar manager per slot; tag each slot's events with its slot so the
  // renderer can route them to the right stream's state. Registering the
  // callback does NOT spawn the child (still lazy on the first `call()`).
  //
  // Über einen Hook statt einer Schleife über alle Slots: die Obergrenze ist
  // eine reine Sicherungsschranke (99), keine erwartete Streamzahl. Eine
  // Schleife legte für jeden, der einen einzigen Schirm teilt, 99 Verwalter
  // samt Rückruf an. So entsteht der Verwalter eines Slots erst, wenn der
  // Renderer ihn wirklich anspricht — und bekommt seine Verdrahtung im selben
  // Zug, noch bevor der erste `call()` etwas senden kann.
  onSidecarCreated((manager, slot) => {
    manager.onEvent((ev) => {
      // Experimental-Version: bei Stream-Ende/Fehler die sidecar.log hochladen
      // (no-op, wenn die Rust-Version aus ist — prüft den Store selbst).
      onSidecarEventForUpload(ev, slot);
      sendToMainWindow('sidecar:event', { ...ev, slot });
    });
  });

  // Generic handler — the renderer calls `sidecar:call` with an op name + params +
  // an optional slot. Catch everything so a bad op / dead sidecar surfaces as
  // `{ok:false}` in the renderer instead of an unhandled rejection.
  // ShadowPlay: die letzten 30 Sekunden des SENDENDEN Stroms sichern.
  // Eigener Kanal statt sidecar:call — der Zielpfad wird HIER gebaut (wie
  // player:record; der Renderer haelt nie einen Pfad in der Hand), derselbe
  // Speicherort wie die Player-Aufnahmen, inklusive der eingestellten
  // Ordnerwahl.
  ipcMain.handle('sidecar:clip', async (_e, slot: unknown, seconds?: unknown) => {
    try {
      const ziel = shadowClipPath();
      return await getSidecar(normaliseSlot(slot)).call('clip_save', {
        path: ziel,
        // Der ganze Puffer, nicht ein Bruchteil (Michaels Wunsch 2026-09-27):
        // der Ring haelt 90 s, der Knopf sichert den aktuellen Stand.
        seconds: Number(seconds) || 90,
      });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle('sidecar:call', async (_e, op: string, params: unknown, slot?: unknown) => {
    // Validate op against the allowlist (finding 156).
    if (!ALLOWED_SIDECAR_OPS.has(op)) {
      return { ok: false, error: 'unknown op' };
    }
    try {
      return await getSidecar(normaliseSlot(slot)).call(op, params);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // Fernsteuerung, Host-Seite: die im Renderer empfangenen `remote_input`-Frames
  // in den Sidecar des gemeinten Stream-Platzes. Eigene Kanäle statt `sidecar:call`
  // — der Hauptprozess führt Buch darüber, welche Plätze eine Eingabe-Sitzung
  // haben, damit „alles loslassen" beim Ende genau die erreicht und keinen
  // Sidecar startet, der nichts zu tun hat (s. `remoteInputHost.ts`).
  ipcMain.handle(
    'sidecar:remoteInput',
    (_e, slot: unknown, sessionId: unknown, frames: unknown, hostAktiv: unknown) =>
      remoteEingabe.frames(slot, sessionId, frames, hostAktiv === true),
  );
  ipcMain.handle('sidecar:remoteInputEnd', () => remoteEingabe.beenden());

  // Fernsteuerung, Host-Seite: dem Sidecar eines Platzes sagen, dass seine
  // Ablage-Sitzung vorbei ist. Der Renderer ruft das beim TRAEGERWECHSEL
  // (`$lib/remote/ablageTraeger.ts::traegerWechsel`).
  //
  // **Der `sidecarRunning`-Riegel ist der ganze Zweck dieses Kanals** — und
  // zugleich der Plattform-Unterschied, ohne dass hier ein
  // `process.platform` stuende: `getSidecar()` spawnt lazy, ein Ruf an einen
  // Platz ohne laufenden Sidecar startete also einen Prozess, nur um ihm zu
  // sagen, dass er nichts zu tun hat (Befund B7). Auf Windows ist der alte
  // Traeger nach `stop` weg, der Riegel greift, und es bleibt beim bisherigen
  // Verhalten. Auf macOS bleibt der Sidecar warm (`mac-hq-sidecar/
  // src/dispatch.rs`: kein `exit_after`) — er lebt, bekommt sein `ende` und
  // gibt die Zwischenablage des Nutzers frei, statt sie bis zum App-Ende
  // belegt zu halten.
  ipcMain.handle('sidecar:ablageEnde', async (_e, slot: unknown) => {
    const platz = normaliseSlot(slot);
    if (!sidecarRunning(platz)) return { ok: true, note: 'kein laufender Sidecar' };
    try {
      return await getSidecar(platz).call('ablage', { data: endeAnstoss() });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // Fernsteuerung — geteilte Zwischenablage (`$lib/remote/ablage.ts`). Der
  // Hauptprozess deutet die Nutzlast nicht, er entscheidet nur, wohin sie
  // geht (`ablageWeiche.ts`). Sie traegt die Huelle aus `ablageHuelle.ts`
  // (`{rahmen:…}` von der Gegenseite, `{anstoss:…}` vom eigenen Renderer) —
  // gesetzt wird sie im Renderer, geoeffnet erst im Player. Die Rolle wird
  // NICHT aus der Sitzungsnummer
  // erschlossen (das brach: ein Host, der nebenbei den Strom eines Dritten im
  // nativen Player anschaut, traegt ebenfalls eine Sitzungsnummer > 0 und
  // waere faelschlich als 'controller' gedeutet worden) — sie kommt vom
  // Renderer mit, der sie aus `remoteAblage.start(rolle, …)` kennt, und wird
  // hier nur noch geprueft (`rolleLesen`, fail-closed). Zulaessig, weil diese
  // Weiche nur entscheidet, welcher der EIGENEN lokalen Prozesse die Ablage
  // haelt — anders als bei `input_capture` (Sicherheitsentscheidung ueber
  // Eingabe-Injektion, deshalb dort bewusst im Hauptprozess) kostet eine
  // falsche Rolle hier ein fehlgeleitetes Einfuegen, keine Befugnis.
  //
  // Die Host-Haelfte geht an den Sidecar des TRAEGER-Platzes. Welcher das ist,
  // entscheidet der Renderer (`$lib/remote/ablageTraeger.ts`): je Platz laeuft
  // ein eigener Sidecar-Prozess, die Zwischenablage ist aber maschinenweit —
  // beanspruchten alle, ueberschrieben sie sich gegenseitig. Hier wird der
  // Platz nur auf den gueltigen Bereich geklemmt, wie bei `sidecar:call`.
  //
  // **Kein `sidecarRunning`-Riegel wie bei `remoteInput`**, und das ist der
  // Unterschied: dort nennt die GEGENSEITE den Platz, und ein erfundener
  // startete einen Prozess, nur damit er `unknown_slot` antwortet. Hier nennt
  // ihn der eigene Renderer, und er nennt genau den, dessen Stream er selbst
  // laufen sieht.
  ipcMain.handle(
    'sidecar:ablage',
    async (_e, rolleRoh: unknown, session: unknown, data: unknown, slot?: unknown) => {
      const rolle = rolleLesen(rolleRoh);
      if (!rolle) return { ok: false, error: 'unbekannte Rolle' };
      try {
        if (zielFuerAblage(rolle) === 'sidecar') {
          return await getSidecar(normaliseSlot(slot)).call('ablage', { data });
        }
        const s =
          typeof session === 'number' && Number.isInteger(session) && session > 0 ? session : 0;
        return await playerManager.call('ablage', { session: s, data });
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );
}

/**
 * Nativer HQ-Player (`streaming/pulse-player/`). Rein additiv: fehlt das
 * Binary, meldet `player:available` schlicht `false` und der Renderer bleibt
 * auf dem bestehenden WHEP-Weg im `<video>`-Element.
 *
 * Op-Allowlist analog zu `ALLOWED_SIDECAR_OPS` — der Renderer darf nicht beliebige
 * Operationen in den Kindprozess schieben.
 */
// `record`/`clip` fehlen hier bewusst: die tragen einen Dateipfad und laufen
// deshalb ueber eigene Kanaele, bei denen der Hauptprozess das Ziel bestimmt.
// `input_capture` fehlt hier ebenfalls bewusst: die Operation legt zugleich die
// Zuordnung Player-Sitzung -> Fernsteuerungs-Sitzung an, und die gehoert in den
// Hauptprozess (s. `remoteInput.ts`). Sie laeuft deshalb ueber `player:inputCapture`.
// `remote_transport` darf ueber den generischen Kanal: es traegt nur den
// Anzeigetext des Eingabewegs fuers Statistik-Feld (keine Zuordnung, keine
// Eingabe) — anders als `input_capture`, s. oben. `remote_pointer` aus
// demselben Grund: es setzt die FORM des lokalen Zeigers im eigenen Fenster
// (`$lib/remote/zeigerform.ts`), beruehrt also weder Zuordnung noch Eingabe.
const ALLOWED_PLAYER_OPS = new Set([
  'health',
  'open',
  'close',
  'set_option',
  'stats',
  'focus',
  'remote_transport',
  'remote_pointer',
  // Bildschirmliste fuers Menue am Griff — reine Anzeige wie `remote_pointer`,
  // beruehrt weder Zuordnung noch Eingabe.
  'remote_screens',
  // Ob der Anfrage-Knopf in der Bedienleiste erscheint. Ebenfalls reine
  // Anzeige: der Klick kommt als Ereignis zurueck, angefragt wird im Renderer.
  'remote_anfragbar',
  // `ablage` darf ueber den generischen Kanal: der Hauptprozess reicht den
  // Rahmen unveraendert durch und deutet ihn nicht. Er traegt beim Kopieren
  // keinen Inhalt (nur eine Ankuendigung), und beim Abruf ist der Inhalt
  // genau das, was hier niemanden angeht — anders als `input_capture`, das
  // zugleich eine Zuordnung anlegt und deshalb im Hauptprozess bleibt.
  'ablage',
  // **Direktverbindung (P2P):** die zwei Signaling-RPCs des Players. Ebenfalls
  // reine ZULEITUNG — Offer-SDP hinaus, Answer hinein; der Zustandswechsel
  // kommt als Ereignis (`direct_state`) zurück. Rechte und Gegenüber kennt
  // allein die Sitzung im Renderer.
  'direct_start',
  'direct_signal',
]);

/** Zuordnung Player-Sitzung -> Fernsteuerungs-Sitzung (s. `remoteInput.ts`). */
const eingabeWeiche = new EingabeWeiche();

function wirePlayer(): void {
  // Registrieren startet den Prozess NICHT — der Start bleibt lazy bis zum
  // ersten `call()`.
  playerManager.onEvent((ev) => {
    // Eingabe-Frames der Fernsteuerung: eigener Kanal, nicht der allgemeine
    // `player:event`-Strom. Zwei Gruende — sie kommen bis zu 125-mal je Sekunde
    // (der allgemeine Strom ist duenn und wird vollstaendig geloggt), und der
    // Renderer soll sie ohne Umformung absetzen koennen.
    if (ev?.ev === 'player:input') {
      for (const nachricht of eingabeWeiche.verteilen(ev)) {
        sendToMainWindow('player:remoteInput', nachricht);
      }
      return;
    }
    // Chat-Knopf im Player-Fenster: das App-Fenster nach vorne holen. Das kann
    // nur der Hauptprozess — ein `window.focus()` im Renderer bewirkt hier
    // nichts, und das Fenster kann obendrein im Tray versteckt sein
    // (`show()` blendet ein UND fokussiert). Den Chat selbst oeffnet dann der
    // Renderer, der dasselbe Ereignis bekommt.
    if (ev?.ev === 'player:chatRequest' && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
    sendToMainWindow('player:event', ev);
  });

  ipcMain.handle('player:available', () => playerManager.isAvailable());

  // Aufnahme: der Renderer loest nur aus. Zielpfad und Laengenbegrenzung
  // bestimmt der Hauptprozess (s. player.ts) — ein renderer-gewaehlter Pfad
  // waere ein Schreibzugriff an beliebige Stelle.
  //
  // Alle drei teilen dieselbe Absicherung: Sitzung pruefen und jeden Fehler
  // abfangen, damit im Renderer immer ein {ok:false} ankommt statt einer
  // geworfenen IPC-Ausnahme.
  const handleRecording = (
    channel: string,
    run: (session: number, arg: unknown) => Promise<Record<string, unknown>>,
  ): void => {
    ipcMain.handle(channel, async (_e, session: unknown, arg: unknown) => {
      if (typeof session !== 'number') return { ok: false, error: 'session fehlt' };
      try {
        return await run(session, arg);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    });
  };

  handleRecording('player:record', (session) => playerManager.startRecording(session));
  handleRecording('player:stopRecord', (session) =>
    playerManager.call('stop_record', { session }),
  );
  handleRecording('player:clip', (session, seconds) =>
    playerManager.saveClip(session, Number(seconds) || 30),
  );

  // Speicherort der Mitschnitte: der Nutzer waehlt im SYSTEM-Ordnerdialog.
  // Der Dialog laeuft bewusst HIER — der Renderer haelt nie einen Pfad in der
  // Hand, den er setzen koennte; `recordingDir` steht deshalb BEWUSST NICHT
  // in der store:set-Allowlist. Abbrechen veraendert nichts.
  ipcMain.handle('player:chooseRecordingDir', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: 'kein Fenster' };
    const sel = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      // Bewusst ohne Titel: das Betriebssystem liefert die lokalisierte
      // Standard-Überschrift — ein fester Text hier wäre je Sprache falsch.
    });
    if (sel.canceled || !sel.filePaths[0]) return { ok: false, canceled: true };
    storeSet('recordingDir', sel.filePaths[0]);
    return { ok: true, path: sel.filePaths[0] };
  });
  // Effektives Verzeichnis fuer die Anzeige — berechnet der Hauptprozess
  // (player.ts faellt auf den Standard zurueck, wenn der gewaehlte Ordner
  // unbrauchbar wurde). store:get('recordingDir') wuerde nur den ROHEN Wert
  // zeigen, ohne Fallback und Validierung.
  ipcMain.handle('player:recordingDir', () => ({ ok: true, path: recordingDir() }));

  // Fernsteuerung: Eingabe-Erfassung im Player-Fenster schalten und zugleich
  // die Zuordnung zur Fernsteuerungs-Sitzung anlegen. Ohne Zuordnung verwirft
  // `EingabeWeiche` die Frames — die REIHENFOLGE der beiden Schritte ist
  // deshalb sicherheitsrelevant und steht bei `erfassungSchalten`.
  ipcMain.handle('player:inputCapture', async (_e, args: unknown) => {
    const gelesen = auftragLesen(args);
    if (!gelesen.ok) return { ok: false, error: gelesen.error };
    return erfassungSchalten(
      eingabeWeiche,
      (params) => playerManager.call('input_capture', params),
      gelesen.auftrag,
    );
  });

  ipcMain.handle('player:call', async (_e, op: string, params: unknown) => {
    if (!ALLOWED_PLAYER_OPS.has(op)) {
      return { ok: false, error: 'unknown op' };
    }
    try {
      return await playerManager.call(op, (params ?? {}) as Record<string, unknown>);
    } catch (e) {
      // Alles abfangen: ein fehlendes Binary oder ein toter Prozess muss als
      // {ok:false} im Renderer ankommen, damit dieser zurueckfallen kann.
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  // Shutdown haengt NICHT hier an einem eigenen before-quit-Listener — der
  // laeuft gebuendelt mit den Sidecars im bestehenden before-quit-Handler
  // weiter unten (bounded 3s-Race), damit der Player-Prozess nicht
  // unabhaengig vom Rest der Aufraeum-Sequenz wegrennt.
}

// ── Accessibility-Anstoss (macOS, Fernsteuerung Host-Seite) ─────────────────
// Windows braucht keine Freigabe -- das Op gehoert dort zum Programm
// (`win-hq-sidecar`, `health.sidecar.remote_input` steht fest). Auf dem Mac haengt
// jede Eingabe-Injektion des Sidecars an der Bedienungshilfen-Freigabe, und
// TCC ordnet sie dem VERANTWORTLICHEN Prozess zu, nicht dem Kindprozess: der
// vom Hauptprozess gestartete Sidecar erbt Pulses Freigabe (gemessen,
// `docs/plans/2026-08-23-macos-eingabe-messungen.md`, Messung 1). Der Anstoss
// gehoert deshalb genau hierher -- nur hier heisst der Eintrag im
// Systemdialog "Pulse" statt eines Sidecar-Binaernamens. Der Sidecar selbst
// prueft live nur noch einmal nach, ob die geerbte Freigabe fuer IHN gilt
// (`mac-hq-sidecar/src/berechtigung.rs`), fragt aber niemals nach -- ein
// Sidecar, der beim Gesundheitscheck ungefragt einen Systemdialog aufwirft,
// waere eine Zumutung.
// Netzdiagnose für einen Self-Host-Server. Der Renderer sieht jeden
// Fehlschlag als denselben `TypeError: Failed to fetch` — Node kann die Kette
// einzeln abgehen (netdiag.ts). Rein lesend: der Aufruf öffnet keinen Datenweg
// und trifft keine Vertrauensentscheidung, er beschreibt nur, was er vorfindet.
// Security-Audit 2026-09-16 — Schranken für den netdiag-IPC-Kanal.
// Interne Ziele nach Konvention (keine hart garantierte Grenze — PTR/Split-
// Horizon kann intern trotzdem aufgelöst werden; Decke dokumentiert am Aufruf).
const INTERNE_SUFFIXE = [
  'localhost',
  '.local',
  '.lan',
  '.internal',
  '.localdomain',
  '.home',
  '.corp',
  '.intranet',
];
function _istInternesZiel(host: string): boolean {
  return INTERNE_SUFFIXE.some((s) => host === s || host.endsWith(s));
}

function wireNetdiag(): void {
  ipcMain.handle('netdiag:check', async (_e, hostname: unknown) => {
    if (typeof hostname !== 'string' || hostname.length > 255) return null;
    // Nur die beiden Schemata, unter denen ein Pulse-Server überhaupt läuft.
    // Ohne die Schranke wäre der Kanal ein Werkzeug, mit dem der Renderer den
    // Hauptprozess zu beliebigen Verbindungen bewegt.
    if (!/^https?:\/\//i.test(hostname)) return null;
    // Security-Audit 2026-09-16: der Hostname muss einem FQDN/IP-Literal
    // entsprechen (denselben Regeln wie Deep-Links) und KEIN internes Ziel
    // nennen — sonst wäre der Kanal eine Portscan-/SSRF-Primitive gegen das
    // eigene Netz (Docker-Bridge, Router, Cloud-Metadaten). Security-Scan
    // 2026-09-18: auch das DNS-Rebinding-Loch ist zu — netdiag.ts prüft nach
    // der Auflösung jede Adresse auf private Ranges (Resolve-then-check) und
    // pinnt TLS/HTTP danach auf genau die geprüfte IP.
    let host: string;
    try {
      host = new URL(hostname).hostname.toLowerCase();
    } catch {
      return null;
    }
    if (!isValidFqdn(host)) return null;
    if (_istInternesZiel(host)) return null;
    try {
      return await diagnostiziere(hostname);
    } catch {
      return null;
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
  // Quelle (`capture_source`/`capture_source_1`/`capture_sources`) und Ton
  // (`audio_mode`/`audio_app`): der Renderer schreibt sie seit dem 2026-09-20
  // nicht mehr (Dialog-Öffnen resettet auf die Vorgabe). Die Schlüssel
  // bleiben erlaubt, damit bestehende Store-Dateien lesbar bleiben — gelesen
  // wird nichts davon.
  'capture_source',
  'capture_source_1',
  'capture_sources',
  'audio_mode',
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
  // Diagnose-Logs des Linux-Sidecars hochladen. Eigener Opt-in, default aus —
  // hing früher am Rust-Toggle; seit Rust der Standard ist, wäre das eine
  // stille Telemetrie für jeden Linux-Nutzer gewesen.
  'uploadDiagnosticLogs',
  // Nativer HQ-Player (`streaming/pulse-player/`) statt des <video>-WHEP-Wegs.
  // Default aus — experimentell, noch ohne Tonausgabe (siehe player.ts).
  'useNativePlayer',
  // Bughunt Runde 8: der Renderer persistiert den Zweit-Schalter daneben —
  // ohne Allowlist-Eintrag wurde der Schreib still verworfen und der Schalter
  // stand nach jedem Neustart wieder auf false (nur Electron betroffen,
  // der Browser-Fallback nutzt localStorage).
  'nativePlayerOnlyTenBit',
  // Standplatz-Geräte. Alle vier liegen im selben chmod-600-Tresor wie die
  // Stream-Einstellungen, und alle vier MÜSSEN hier stehen: die Allowlist
  // verwirft unbekannte Schlüssel still (nur `console.warn`), der Renderer
  // behält seinen Stand im Speicher und merkt nichts — bis zum Neuladen. Genau
  // so gesehen am 2026-08-16: das Gerät stand nach jedem Reload auf „offline"
  // und musste neu eingetragen werden, weil `remote.geraete` nie geschrieben
  // wurde. Wer hier eine fünfte Standplatz-Einstellung ergänzt, ergänzt sie
  // auch in dieser Liste.
  //
  // Welche Kennung dieser Rechner auf welchem Server hat — die Antwort auf
  // „welches der eingetragenen Geräte bin ich" (`devices/anmeldung.svelte.ts`).
  'remote.geraete',
  // Die Dauerfreigabe: wer ohne Rückfrage übernehmen darf und wie lange
  // (`remote/standplatz.svelte.ts`). Ohne Persistenz galt sie nur bis zum
  // nächsten Neuladen — und ein unbeaufsichtigter Rechner fragte danach
  // wieder jemanden, der nicht davorsitzt.
  'remote.standplatz',
  // Das Protokoll: wer wann wie lange übernommen hat (`remote/protokoll.svelte.ts`).
  'remote.protokoll',
  // Womit das Gerät überträgt, wenn es aus der Ferne geweckt wird
  // (`devices/profil.svelte.ts`) — getrennt von den Stream-Einstellungen des
  // Besitzers, deshalb ein eigener Schlüssel.
  'remote.standplatzProfil',
  // Merker des einmaligen Umzugs der alten lokalen Standplatz-Freigabeliste
  // auf den Server (`remote/standplatz.svelte.ts`, seit 2026-08-20 entscheidet
  // dort `device_grants`, nicht mehr diese Liste). Ohne diesen Schlüssel wird
  // der Merker verworfen, der Client hält den Umzug bei JEDEM Start erneut für
  // unerledigt und fragt die Server-Liste jedes Mal wieder ab.
  'remote.standplatz.umgezogen',
  // Der Name DIESES Rechners, schon VOR der Eintragung speicherbar
  // (`devices/rechnerName.svelte.ts`). Ohne Allowlist-Eintrag verwirft
  // store:setAll ihn still — exakt derselbe Befund wie bei `remote.geraete`
  // (2026-08-16): der Renderer behält den Stand im Speicher, alles sieht
  // richtig aus, bis zum Neuladen.
  'remote.rechner-name',
  // HINWEIS: `pulse.host.creds` (③c-Pairing-Credentials) steht BEWUSST NICHT
  // hier. Der Main-Prozess schreibt sie via pairing.ts::saveCreds über einen
  // DIREKTEN storeSet-Aufruf (store.ts kennt keine Allowlist — die gilt nur für
  // die store:set-IPC-Kanäle). Würde der Key hier stehen, könnte der Renderer
  // die Creds über store:set überschreiben — unnötiges Schreib-Surface.
]);

/* Schlüssel, die der Renderer NIE lesen darf (③c-Sicherheitsinvariante):
 * `istRendererGesperrt` (storeSchluessel.ts) sperrt den ganzen Namensraum
 * `pulse.host.*` — Zugangsdaten (`client_secret`, `relay_tunnel_token`, auch je
 * Benutzer-Welt unter `pulse.host.creds.<userId>`) und der Cloud-Login leben
 * ausschließlich im Main-Prozess; der Renderer bekommt nur den bereinigten
 * Status über `host:getPairing`. Bis zum Scan vom 2026-10-08 stand hier eine
 * Liste zweier exakter Namen — der Welt-Schlüssel mit Suffix fiel durch und
 * war über `store:get` lesbar. */

/** Kopie ohne die renderer-gesperrten Schlüssel — für die store:getAll(Sync)-Kanäle.
 *
 * Security-Audit 2026-09-16: zusätzlich auf die Renderer-eigenen Schlüssel
 * (ALLOWED_STORE_KEYS, sonst nur die Schreibseite) begrenzt. Zuvor sah getAll
 * den GESAMTEN Tresor — ein kompromittierter Renderer-Origin erhielt damit
 * jede Main-Prozess-Einstellung gratis mit. get(key) bleibt bewusst
 * unverändert (expliziter Schlüssel = Absicht), der Bulk-Weg ist der
 * Angriffspfad, den dieser Deckel schließt. */
function stripBlockedKeys(all: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(all)) {
    if (istRendererGesperrt(k)) continue;
    if (!ALLOWED_STORE_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

function wireStore(): void {
  ipcMain.handle('store:get', (_e, key: string) => {
    if (typeof key !== 'string' || istRendererGesperrt(key)) {
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
      // Geheimnisse gar nicht erst entschlüsseln — die werden hier danach
      // gefiltert weggeworfen (zweiter Bughunt-Lauf 2026-09-23: libsecret ist
      // ein synchroner DBus-Aufruf; der Renderer soll einen hängenden Keyring
      // nicht blockieren können, und der Klartext braucht hier niemand).
      return stripBlockedKeys(storeGetAll(istRendererGesperrt));
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
      e.returnValue = stripBlockedKeys(storeGetAll(istRendererGesperrt));
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

// ── Permission-Gate (deny-by-default) ───────────────────────────────────────
// Ohne Handler genehmigt Electron JEDE Permission-Anfrage still (Bughunt
// 2026-09-23): Kamera/Mikro/Notifications/Fullscreen/PointerLock/Clipboard-
// Schreiben braucht die App-UI, alles andere (Geolocation, MIDI, …) wird
// verweigert — auch für den erlaubten Origin. Ein fremder Origin bekommt
// ohnehin nichts: er kann durch die Navigations-Guards gar nicht erst laden.
const _ALLOWED_PERMISSIONS = new Set([
  'media',
  'notifications',
  'fullscreen',
  'pointerLock',
  'clipboard-sanitized-write',
]);
function wirePermissionGate(): void {
  // Zweiter Bughunt-Lauf (2026-09-23): die Prüfung muss FRAME-EBENIG sein —
  // `webContents.getURL()` liefert die Top-Page, ein Cross-Origin-iframe
  // (Watch-Party-Embeds) hätte die App-Origin geerbt. Electron liefert dafür
  // `details.requestingUrl` (Request) bzw. `requestingOrigin` (Check); nur wo
  // beides fehlt, fällt der Gate auf die Top-URL zurück.
  const erlaubt = (permission: string, quelle: string | null | undefined): boolean => {
    // Fullscreen ist nutzerinitiiert und unkritisch — Watch-Party-Embeds
    // (YouTube/Twitch-iframe) brauchen ihn, deren Origin durchfällt sonst.
    // Bewusst VOR der Allowlist und OHNE Origin-Prüfung (beide Handler).
    if (permission === 'fullscreen') return true;
    if (!_ALLOWED_PERMISSIONS.has(permission)) return false;
    return quelle != null && _isAllowedOrigin(quelle);
  };
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      callback(erlaubt(permission, details?.requestingUrl ?? webContents?.getURL() ?? null));
    }
  );
  // Elektron verlangt BEIDE Handler für vollständige Permissions-Abdeckung
  // (electron.d.ts): `navigator.permissions.query` und die synchronen Checks
  // (pointerLock, clipboard-sanitized-write) laufen über DIESEN Handler — ohne
  // ihn galt dort weiterhin Electron-Default statt der Allowlist.
  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission, requestingOrigin) => erlaubt(permission, requestingOrigin),
  );
}

/** Berechtigungs-Gate der Server-App (Scan 2026-10-08). `bootServer` rief
 *  bisher gar keines auf — ohne Handler genehmigt Electron jede Anfrage
 *  still, die in der Login-Phase geladene Cloud-Seite hätte also etwa
 *  Kamera und Mikrofon ohne Rückfrage bekommen. Die Server-App braucht
 *  keine davon; einzig server.html (file:) kopiert die Serveradresse in die
 *  Zwischenablage. */
function wireServerPermissionGate(): void {
  const erlaubt = (permission: string, quelle: string | null | undefined): boolean =>
    permission === 'clipboard-sanitized-write' && (quelle?.startsWith('file:') ?? false);
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      callback(erlaubt(permission, details?.requestingUrl ?? webContents?.getURL() ?? null));
    }
  );
  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission, requestingOrigin) => erlaubt(permission, requestingOrigin),
  );
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
// the sidecar HQ-stream path covers richer capture.)
// Bughunt 2026-09-20: das stimmt nur für macOS 15+ (s. electron.d.ts —
// "currently available for MacOS 15+ only"). Auf Windows (und macOS < 15) läuft
// der Handler DOCH an und nahm blind sources[0] — egal ob Bildschirm oder
// Fenster, "was auch immer zuerst kommt", ohne jede Nutzerwahl. Der Fallback
// teilt deshalb bewusst den PRIMÄRBILDSCHIRM: vorhersagbar, nie ein Fenster.
// ponytail: eine echte Quellwahl gibt es auf Windows so nicht — Ausbaupfad ist
// ein In-App-Picker; bis dahin ist "Hauptmonitor" der ehrlichste Zustand.
function wireScreenShare(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      // Bughunt 2026-09-23: nur der erlaubte Origin (unsere App-UI) darf den
      // Bildschirm bekommen — ein kompromittierter Renderer-Inhalt bekäme
      // sonst auf Plattformen ohne System-Picker kommentarlos den
      // Primärbildschirm gestreamt, ohne jeden Dialog.
      if (!_isAllowedOrigin(_request.securityOrigin)) {
        callback({});
        return;
      }
      if (process.platform === 'linux') {
        // Synthetic "whole screen" stream id — Chromium maps this to its portal
        // ScreenCast flow on Wayland (the portal picker still lets the user
        // choose a specific monitor/window) and to the primary X screen on X11.
        callback({ video: { id: 'screen:0:0', name: 'Bildschirm' } });
        return;
      }
      // Non-Linux without a system picker: share the primary display.
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => {
          if (!sources.length) {
            callback({});
            return;
          }
          const primary = screen.getPrimaryDisplay();
          const chosen =
            sources.find(
              (s) => s.display_id && s.display_id === String(primary.id)
            ) ?? sources[0];
          callback({ video: chosen });
        })
        .catch(() => callback({}));
    },
    { useSystemPicker: true }
  );
}

// ── Single-instance lock ────────────────────────────────────────────────────
// Second launch hands focus to the running window instead of starting a 2nd one.
// Windows: the OS passes the pulse:// URL as an argv entry to the second instance;
// we forward it to the running window via handleDeepLink.
// **Ausnahme: die Dev-Zweitinstanz** (`PULSE_DEV_ZWEITINSTANZ=1`) will genau
// KEINE Fensterübergabe — sie ist der Steuernde im Selbsttest auf einer
// Maschine und hat ihr eigenes Profilverzeichnis (s. oben).
if (!DEV_ZWEITINSTANZ && !acquireSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

/** Single-Instance-Lock mit Retry: Bei Doppelstart im selben Augenblick
 *  (z.B. zwei Autostart-Wege treffen zusammen) kann der zweite Prozess den
 *  Lock des noch hochfahrenden ersten verfehlen — unter Flatpak blieb die
 *  Zweitinstanz sonst als Voll-Instanz neben der ersten stehen. Kurz warten
 *  und erneut versuchen, ehe wir zugunsten der laufenden Instanz aufhören. */
function acquireSingleInstanceLock(): boolean {
  const RETRY_DELAY_MS = 500;
  const RETRIES = 6;
  let locked = app.requestSingleInstanceLock();
  for (let i = 0; !locked && i < RETRIES; i++) {
    // Synchrones Warten (Boot läuft noch vor app.whenReady, kein Event-Loop):
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_DELAY_MS);
    locked = app.requestSingleInstanceLock();
  }
  return locked;
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

    // Renderer-Konsole ins Log spiegeln — NUR mit PULSE_RENDERER_LOG=1 und nur
    // in unverpackten Builds.
    //
    // WOZU: Bei einem Fehler in der Oberfläche steht die einzige Spur in der
    // Konsole des Renderers. Wer die App auf einem anderen Rechner betreut,
    // kommt da nicht heran — und ein Fehler, der nur „der Knopf tut nichts"
    // aussieht, ist ohne diese Zeile nicht zu finden. Genau so am 2026-08-12
    // beim Zwei-Geräte-Test aufgelaufen.
    //
    // WARUM STRENG ABGESCHALTET: In der Konsole landen Nutzdaten — Nachrichten,
    // Namen, im schlimmsten Fall Bruchstücke von Tokens aus einer
    // Fehlermeldung. `sidecar.log` kann per Diagnose-Upload den Rechner
    // verlassen. Deshalb Opt-in über eine Umgebungsvariable, nicht über eine
    // Einstellung, und in einem gepackten Build gar nicht.
    if (!app.isPackaged && process.env.PULSE_RENDERER_LOG === '1') {
      // ZWEI SIGNATUREN. Electron hat `console-message` umgestellt: früher
      // (event, level:number, message, line, sourceId), neuer ein einzelnes
      // Objekt {level:string, message, lineNumber, sourceId}. Beim ersten
      // Versuch am 2026-08-12 fing die alte Form unter Electron 43 nichts —
      // still, ohne Fehler. Deshalb beide, statt sich auf eine zu verlassen.
      contents.on('console-message', (...args: unknown[]) => {
        const erst = args[0] as Record<string, unknown> | undefined;
        let stufe: unknown;
        let text: unknown;
        let zeile: unknown;
        let quelle: unknown;
        if (erst && typeof erst === 'object' && 'message' in erst) {
          ({ level: stufe, message: text, lineNumber: zeile, sourceId: quelle } = erst as never);
        } else {
          [, stufe, text, zeile, quelle] = args;
          stufe = ['debug', 'info', 'warn', 'error'][Number(stufe)] ?? String(stufe);
        }
        const datei = String(quelle ?? '').split('/').pop()?.slice(0, 40) ?? '';
        console.log(`[renderer:${String(stufe)}] ${String(text)}  (${datei}:${String(zeile)})`);
      });
      console.log('[renderer-log] Spiegelung aktiv für', contents.getURL().slice(0, 60));
    }
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
  // Bestandsinstallationen einmalig auf den neuen Standard heben (Diagnose
  // standardmäßig an). Vor `wireSidecar`, damit schon der erste Stream
  // dieser Sitzung nach der neuen Vorgabe entscheidet.
  migriereAufStandardAn();
  wireSidecar();
  wirePlayer();
  wireNetdiag();
  wireScreenShare();
  wirePermissionGate();
  wireNotify(() => mainWindow);
  wireSicherungRuecklauf();
  wirePower();
  wireClipboard();
  wireGlobalShortcuts(() => mainWindow);

  createWindow();
  createTray(() => mainWindow, quitApp);

  // Auto-Update: registriert die Renderer-Events + IPC-Handler und startet den
  // Boot- + periodischen Hintergrund-Check in EINEM Aufruf. Inert (Cleanup =
  // no-op), wenn kein gepackter Windows-Build (siehe updater.ts::startUpdater).
  // Die Cleanup-Funktion auf Modul-Scope, damit `before-quit` sie immer findet.
  stopUpdater = startUpdater(() => mainWindow);

  wireTrayIpc();
}

/** Tray-IPC (Status + Live-Badge-Image) — nutzt sowohl das Client- als auch
 *  das Server-Fenster (dessen Login-Phase lädt die Web-SPA). MUSS in beiden
 *  Boot-Pfänden registriert sein; fehlte er im Server-Boot → „No handler
 *  registered" und das Server-Tray bekam niemals ein Badge.
 *
 *  Im SERVER_MODE werden die Pushes aber ignoriert: TraySync in der Web-SPA
 *  malt das Client-Mark (Kreise) und würde damit den Server-Heartbeat im Tray
 *  ersetzen — und das Bild bliebe stehen, selbst nachdem das Fenster auf
 *  server.html navigiert ist (dort zeichnet kein Renderer mehr dagegen). Das
 *  Server-Tray gehört dem Main-Prozess (tray.ts, variant 'server'). */
function wireTrayIpc(): void {
  ipcMain.on('tray:setStatus', (_e, payload: unknown) => {
    if (SERVER_MODE) return;
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

  ipcMain.handle('tray:setImage', (_e, dataUrl: unknown) => {
    if (SERVER_MODE) return false;
    if (typeof dataUrl !== 'string') return false;
    setTrayImageFromDataUrl(dataUrl);
    return true;
  });
}

// Server-App-Boot: Update-Splash (eigener /updates/win-server/-Feed, Server-
// Icon) + Host-IPC (Lochungs-Modus) + Fenster (server.html) + Tray + In-App-
// Updater — kein Client-ScreenShare/DeepLink. Sidecar/Shortcuts/Invites/Tray-
// IPC sind dennoch verdrahtet: die Login-Phase lädt die Web-SPA und die ruft
// dieselben Bridge-Kanäle wie im Client auf (fehlte die Verdrahtung → „No
// handler registered"-Spam und tote Bridges im Server-Fenster).
async function bootServer(): Promise<void> {
  // initStore() ZUERST: wireHost() liest beim Verdrahten die Pairing-Creds
  // (loadCreds); ohne initStore() ist jeder storeGet/storeSet ein No-Op → die
  // App vergisst ihr Pairing bei jedem Neustart und landet wieder im Login.
  initStore();
  wireStore();
  wireServerPermissionGate();

  // Auto-Update im Hintergrund wie der Client (Entscheid auf main seit dem
  // Splash-Rückbau): Fenster startet sofort, `startUpdater` lädt Updates still
  // über den Server-Feed (electron-builder-server.yml) und installiert beim
  // Neustart. Der allinone-Container läuft dank `--restart unless-stopped`
  // weiter und wird nach dem App-Neustart per Zustands-Abgleich
  // (syncLifecycleFromContainer) wieder aufgegriffen.
  wireHost(() => mainWindow);
  wireNotify(() => mainWindow);
  wirePower();
  wireClipboard();
  wireInvitePull();
  wireSidecar();
  wireGlobalShortcuts(() => mainWindow);
  createWindow();
  createTray(() => mainWindow, quitApp, { variant: 'server' });
  wireTrayIpc();
  stopUpdater = startUpdater(() => mainWindow);

  // Per Autostart gestartet? Dann einmalig sichtbar machen: Der Daemon startet
  // bewusst ohne Fenster — war der Tray-Host (Shell-Leiste) noch nicht hoch,
  // lief er komplett unsichtbar (Befund 2026-10-04, Michaels Meldung „ich
  // habe davon gar nichts mitbekommen").
  if (process.argv.includes('--autostarted')) {
    setTimeout(() => {
      try {
        if (!Notification.isSupported()) return;
        const n = new Notification({
          title: 'Pulse Server',
          body: 'Läuft im Hintergrund — Symbol in der Leiste zum Öffnen oder Beenden.',
          silent: true,
        });
        n.on('click', () => {
          const w = mainWindow;
          if (!w || w.isDestroyed()) return;
          if (w.isMinimized()) w.restore();
          w.show();
          w.focus();
        });
        n.show();
      } catch {
        // rein kosmetisch — nie wegen einer Notification booten scheitern.
      }
    }, 5_000);
  }

  // Tray-Host war evtl. noch nicht da, als das Symbol registriert wurde
  // (Autostart mitten im Session-Hochlauf): einmalig neu registrieren, damit
  // das Symbol nicht verloren bleibt. NUR dann: Chromium meldet ein
  // abgebautes Symbol nicht bei der Leiste ab — lief der Host schon, stand
  // danach ein zweites, totes Symbol daneben (Linux-Test 2026-10-08, niri:
  // StatusNotifierItem/1 und /2 aus demselben Prozess). Deshalb nur nach
  // Autostart und nur, wenn beim Start KEIN Tray-Host auf dem Bus war.
  if (process.platform === 'linux' && process.argv.includes('--autostarted')) {
    void trayHostDa().then((da) => {
      if (!da) setTimeout(() => recreateTray(), 20_000);
    });
  }
}

/** Läuft ein StatusNotifierWatcher (Tray-Host) auf dem Session-Bus? Electron
 *  hat dafür keine API; `gdbus` liegt in der Flatpak-Runtime wie auf jedem
 *  GLib-Desktop. Scheitert die Abfrage, gilt der Host als fehlend — dann
 *  greift der alte Weg (Neuregistrierung), lieber ein Geist als kein Symbol. */
function trayHostDa(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('gdbus', [
      'call', '--session', '--dest', 'org.freedesktop.DBus',
      '--object-path', '/org/freedesktop/DBus',
      '--method', 'org.freedesktop.DBus.NameHasOwner', 'org.kde.StatusNotifierWatcher',
    ], { timeout: 3_000 }, (err, stdout) => resolve(!err && /true/.test(String(stdout))));
  });
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
/** Vom Server-Modus gesetzt (wireHost): stoppt den lokalen Server-Stack. */
let hostBackendStoppen: (anlass: 'nutzer' | 'system') => Promise<void> = async () => undefined;
/** Backstop für den Server-Stopp. Großzügiger als der Sidecar-Backstop:
 *  Postgres fährt beim geordneten Stopp einen Checkpoint, und ein hart
 *  abgeschossenes Postgres braucht beim nächsten Start eine Recovery. */
const HOST_STOPP_BACKSTOP_MS = 20_000;
app.on('before-quit', (event) => {
  isQuitting = true;
  stopUpdater();
  if (didShutdownSidecar) return;
  event.preventDefault();
  didShutdownSidecar = true;
  const done = () => app.quit();
  void Promise.race([
    // playerManager (nativer HQ-Player) haengt hier mit dran statt an einem
    // eigenen before-quit-Listener — sonst koennte die Bound-Race oben schon
    // abgelaufen sein, bevor der Player-Prozess sein SIGTERM verarbeitet hat.
    Promise.all([
      ...allSidecars().map((s) => s.shutdown()),
      playerManager.shutdown(),
    ]),
    // Bughunt Runde 44: 3 s Backstop — kuerzer als die Shutdown-Leiter der
    // Kinder (Sidecar 4.5 s bis SIGKILL, Player aehnlich). Hielt ein Kind
    // SIGTERM nicht stand, gewann der Backstop, `app.quit()` lief fertig,
    // und das Kind ueberlebte als Waise (Windows: stirbt nicht mit dem
    // Elternteil). Jetzt: SIGKILL an alle lebenden Prozesse, BEVOR fertig
    // gemeldet wird.
    new Promise<void>((r) =>
      setTimeout(() => {
        for (const s of allSidecars()) s.killHard();
        playerManager.killHard();
        r();
      }, 3_000)
    ),
  ])
    .then(() =>
      Promise.race([
        hostBackendStoppen(nutzerBeendet ? 'nutzer' : 'system').catch((err) => {
          console.error('[host] Stopp beim Beenden fehlgeschlagen:', err);
        }),
        new Promise<void>((r) => setTimeout(r, HOST_STOPP_BACKSTOP_MS)),
      ])
    )
    .then(done, done);
});
