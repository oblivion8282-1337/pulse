/**
 * Shape of `window.pulse` — the API the Electron preload script
 * (`desktop/electron/preload.ts`) exposes via contextBridge (E1a + E1b).
 *
 * Keep this in sync with `desktop/electron/preload.ts`. The GSR method
 * signatures intentionally mirror `gsr.ts`'s `GsrStartArgs` / `Gsr*` response
 * types — but we keep the bridge surface loosely typed (responses as
 * `Promise<unknown>`, args as `unknown`) so the sidecar protocol can evolve
 * without touching the preload; `gsr.ts` does the precise casting on its side.
 *
 * `window.pulse` is `undefined` in a plain browser — always optional-chain it.
 */

/** Async sidecar event payload (`{ev:..,...}`). The narrow union lives in
 *  `$lib/stream/gsr.ts` (`GsrEvent`); here it's just "some object". */
export type PulseGsrEvent = Record<string, unknown>;

/** Persistent key-value store (E1c) — backed by `<userData>/pulse-stream.json`
 *  in the Electron main process (`desktop/electron/store.ts`). Used by
 *  `$lib/stream/persistence.ts`. Values are JSON-serialisable; reads return
 *  `unknown` and the caller casts. */
export interface PulseStoreApi {
  get(key: string): Promise<unknown>;
  getAll(): Promise<Record<string, unknown>>;
  /** Synchronous snapshot of the whole store (boot-time fast path for the
   *  multi-server list). Backed by `store:getAllSync` (sendSync IPC). */
  getAllSync(): Record<string, unknown>;
  set(key: string, value: unknown): Promise<void>;
  /** Atomically write multiple key-value pairs in one IPC round-trip
   *  (finding 158). Values must be JSON-serialisable. */
  setAll(values: Record<string, unknown>): Promise<void>;
}

export interface PulseGsrApi {
  health(): Promise<unknown>;
  gpuInfo(): Promise<unknown>;
  listProfiles(): Promise<unknown>;
  /** Enumerate display monitors (Windows + macOS — Linux uses the portal picker). */
  listMonitors(): Promise<unknown>;
  /** Enumerate capturable windows (macOS source picker). */
  listWindows(): Promise<unknown>;
  listApplicationAudio(): Promise<unknown>;
  buildArgv(args: unknown): Promise<unknown>;
  /** Start a stream in the given slot (0 = primary, 1 = a second concurrent
   *  stream e.g. a second monitor). Defaults to slot 0. */
  start(args: unknown, slot?: number): Promise<unknown>;
  /** Stop the stream in the given slot (default 0). */
  stop(slot?: number): Promise<unknown>;
  /** Subscribe to sidecar events. Each event carries a `slot` field tagged by
   *  the main process so the renderer can route it to the right stream. Returns
   *  an unsubscribe function. */
  onEvent(cb: (ev: PulseGsrEvent) => void): () => void;
}

/** Payload for `pulse.notify.show()` — mention/DM toast. The renderer is
 *  responsible for gating these on `document.hidden || !document.hasFocus()`;
 *  main shows unconditionally when called.
 *
 *  Linux quirk: `icon` MUST be a local file path (or omitted). HTTP(s) URLs
 *  are silently dropped by main — Electron/libnotify can't async-fetch them. */
export interface PulseNotifyShowPayload {
  title: string;
  body: string;
  icon?: string;
  channel_id: string;
  guild_id?: string | null;
  message_id: string;
  /** Explicit click destination (SPA path). When set, overrides the
   *  channel-derived URL — friend-event notifications open /app/friends. */
  target_url?: string;
}

/** Payload delivered to `pulse.notify.onClick()` listeners. Main has already
 *  raised + focused the window by the time this fires; the renderer just
 *  needs to navigate to the channel/message. */
export interface PulseNotifyClickPayload {
  channel_id: string;
  guild_id?: string | null;
  message_id: string;
  /** Set when the notification carried an explicit target (friend events). */
  target_url?: string | null;
}

export interface PulseNotifyApi {
  /** Show a system notification. Returns an internal id (mostly for pattern
   *  consistency with the GSR bridge — the renderer doesn't need it today). */
  show(payload: PulseNotifyShowPayload): Promise<string>;
  /** Subscribe to notification clicks. Returns an unsubscribe function. */
  onClick(cb: (data: PulseNotifyClickPayload) => void): () => void;
}

/** Invite deep-link payload — delivered by main after strict URL validation.
 *  `hostname` is a bare FQDN (e.g. "howispulse.com"), NOT a full URL.
 *  `code` is the invite code (alphanumeric, 6-64 chars). The frontend shows a
 *  disclaimer before touching the server. */
export interface PulseInvitePayload {
  hostname: string;
  code: string;
}

/** Invite deep-link bridge (Phase 5.3). Exposed via preload on pulse://invite URLs. */
export interface PulseInviteApi {
  /** Subscribe to incoming invite deep-links. Returns an unsubscribe function. */
  onLink(cb: (data: PulseInvitePayload) => void): () => void;
  /** Pull any deep-link that arrived before onMount / the onLink listener was
   *  registered (finding 156). Returns the buffered payload or null. */
  getPending(): Promise<PulseInvitePayload | null>;
}

/** Auto-Update bridge (Windows packaged builds). Main (`updater.ts`) runs
 *  electron-updater and downloads updates itself; the renderer only shows the
 *  „Update bereit" banner and triggers the immediate restart. `onReady` never
 *  fires in dev / browser / on Linux (main gates the updater on app.isPackaged
 *  && win32). Optional on `PulseApi` — only present under Electron. */
export interface PulseUpdatesApi {
  /** An update was found on the server (download in progress). Returns an unsubscribe function. */
  onAvailable(cb: (data: { version: string }) => void): () => void;
  /** Download progress of the current update (0–100). Returns an unsubscribe function. */
  onProgress(cb: (data: { percent: number }) => void): () => void;
  /** Update downloaded and ready to install. `autoRestart=true` ⇒ main installs +
   *  restarts automatically (only within the start-up window). Returns an unsubscribe function. */
  onReady(cb: (data: { version: string; autoRestart: boolean }) => void): () => void;
  /** Install the downloaded update and restart now (banner button). */
  restartNow(): Promise<void>;
  /** Manually re-trigger an update check (the start-up check runs automatically). */
  check(): Promise<void>;
}

/** Display-sleep inhibitor bridge. The renderer (`$lib/platform/wakeLock`)
 *  refcounts leases and toggles this on the 0↔1 boundary while a watch-party /
 *  HQ stream is actively playing; main holds one `powerSaveBlocker`. Returns
 *  whether the blocker is currently active. */
export interface PulsePowerApi {
  keepAwake(on: boolean): Promise<boolean>;
}

/** Native clipboard image access (paste). The sandboxed remote renderer can't
 *  read a pasted image's bytes itself (size 0), so this returns the current
 *  clipboard image as PNG bytes via the main process. Null when the clipboard
 *  holds no image. Optional — only present under a current Electron shell. */
export interface PulseClipboardApi {
  readImage(): Promise<Uint8Array | null>;
}

/** Native dropped-file byte access (drag & drop). Resolves a genuinely dropped
 *  `File` to its OS path (via webUtils, in the preload) and reads the bytes in
 *  main — recovering the content the sandboxed renderer sees as 0 bytes.
 *  Returns null for non-file Files (JS-constructed, no OS path) or on error. */
export interface PulseFilesApi {
  readDropped(file: File): Promise<Uint8Array | null>;
}

/** OS-global keyboard shortcuts (background toggles). The renderer hands main
 *  the background-capable bindings (voice/stream toggles), already converted to
 *  Electron accelerators, and dispatches `onTrigger` ids through its own handler
 *  registry — so they fire while Pulse is unfocused. Main-side in `shortcuts.ts`.
 *  Optional — only present under a current Electron shell. */
export interface PulseShortcutsApi {
  /** Replace the registered global accelerators. Push on boot + on every rebind. */
  setGlobal(list: Array<{ id: string; accelerator: string }>): Promise<void>;
  /** Fires with the action id when a registered global shortcut is pressed.
   *  Returns an unsubscribe function. */
  onTrigger(cb: (id: string) => void): () => void;
}

// ── Host-Lifecycle types (③a) ────────────────────────────────────────────────

/** Zustand des lokalen Self-Host-Stacks (Phasen-Modell). */
export type HostPhase =
  | 'idle'
  | 'checking-network'
  | 'opening-door'
  | 'preparing'
  | 'going-live'
  | 'live'
  | 'needs-your-help'
  | 'not-possible-here'
  | 'something-paused'
  | 'needs-windows-setup'
  // Ablöse-Erkennung: periodischer Creds-Check fand ein eindeutiges 401 —
  // ein Re-Bootstrap auf einem ANDEREN Gerät hat clientSecret rotiert.
  // Terminal, bis der User "Gerät zurücksetzen" klickt (host:unpair).
  | 'superseded';

/** Phasen-Ereignis, das HostLifecycle via host:phase an den Renderer pusht. */
export interface HostPhaseEvent {
  phase: HostPhase;
  /** step: Fortschritts-Schritt innerhalb von 'preparing' (login/pull/run/health). */
  detail?: { relayUrl?: string; ports?: number[]; step?: string };
}

/** Optionen für window.pulse.host.start(). */
export interface HostStartOpts {
  /** Electron userData-Pfad (app.getPath('userData')). Wird intern an LocalBackendManager gereicht. */
  userData?: string;
  [key: string]: unknown;
}

/** Sanitisierter Pairing-Status (keine Secrets). */
export interface PairingStatus {
  paired: boolean;
  hostname?: string;
  instanceId?: string;
  relaySubdomain?: string | null;
}

/** Ergebnis von host.pair(). */
export interface PairResult {
  paired: boolean;
  error?: string;
  status?: PairingStatus;
}

/** Ergebnis von host.provision(). needsTakeoverConfirm: Bootstrap wurde schon
 *  einmal eingelöst — es läuft vermutlich ein eingerichteter Server auf einem
 *  anderen Gerät; Übernahme erst nach explizitem zweiten Aufruf mit
 *  `{ confirmTakeover: true }`. */
export interface ProvisionResult {
  ok: boolean;
  error?: string;
  needsTakeoverConfirm?: boolean;
}

/** Ergebnis des Erreichbarkeits-Selbsttests (Diagnose-only, blockiert nichts).
 *  'unavailable' = Prüfung nicht möglich (Netz/Dienst) — neutral, kein Alarm. */
export interface SelfTestResult {
  status: 'ok' | 'blocked' | 'unavailable';
  failedPorts: number[];
  /** Klartext-Gruppen der betroffenen Ports (Voice/Streaming/Verbindungsaufbau). */
  groups: string[];
}

/** Host-Lifecycle-Bridge (③a/③c). Steuert den lokalen Self-Host-Stack vom Renderer aus. */
export interface PulseHostApi {
  /** Stack starten — triggert die Phasen-Sequenz (checking-network → … → live / Fehler-Phase). */
  start(opts?: HostStartOpts): Promise<void>;
  /** Stack sauber stoppen → Phase 'idle'. */
  stop(): Promise<void>;
  /** Letztes Phasen-Ereignis abrufen (Snapshot, kein Subscribe). */
  getStatus(): Promise<HostPhaseEvent>;
  /** Zustands-Abgleich mit dem echten Container (überlebt App-Neustarts
   *  dank `--restart unless-stopped`) — hebt die Phase bei Bedarf auf 'live'. */
  refresh(): Promise<HostPhaseEvent>;
  /** Phasen-Events abonnieren. Gibt eine Unsubscribe-Funktion zurück. */
  onPhase(cb: (e: HostPhaseEvent) => void): () => void;
  /** Cloud-Bootstrap-Token einlösen und Pairing-Credentials speichern. */
  pair(bootstrapToken: string): Promise<PairResult>;
  /** Gespeicherten Pairing-Status abrufen (keine Secrets). */
  getPairing(): Promise<PairingStatus>;
  /** Login-basierte Auto-Provision (Server-App). Ohne `confirmTakeover` pausiert
   *  sie mit `needsTakeoverConfirm`, wenn schon ein Server eingerichtet ist. */
  provision(opts?: { confirmTakeover?: boolean }): Promise<ProvisionResult>;
  /** Erreichbarkeits-Selbsttest nach dem Start (Diagnose-only). */
  selfTest(): Promise<SelfTestResult>;
  /** Pairing-Credentials löschen. */
  unpair(): Promise<void>;
  /** Gibt es eine Container-Runtime (Host-Podman/Docker)? Ohne die zeigt die
   *  App-Hosting-Karte den Setup-Hinweis statt des Start-Knopfs. */
  runtimeAvailable(): Promise<boolean>;
  /** Windows-Erststart-Assistent: WSL2 mit Admin-Abfrage installieren
   *  (Phase 'needs-windows-setup'). Nach ok ist meist ein Neustart nötig. */
  setupWindows(): Promise<{ ok: boolean }>;
}

/** OS-global keyboard shortcuts (background toggles). The renderer hands main
 *  the background-capable bindings (voice/stream toggles), already converted to
 *  Electron accelerators, and dispatches `onTrigger` ids through its own handler
 *  registry — so they fire while Pulse is unfocused. Main-side in `shortcuts.ts`.
 *  Optional — only present under a current Electron shell. */
export interface PulseShortcutsApi {
  /** Replace the registered global accelerators. Push on boot + on every rebind. */
  setGlobal(list: Array<{ id: string; accelerator: string }>): Promise<void>;
  /** Fires with the action id when a registered global shortcut is pressed.
   *  Returns an unsubscribe function. */
  onTrigger(cb: (id: string) => void): () => void;
}

export interface PulseApi {
  platform: 'electron';
  /** 'server' = Pulse Server-App (deren Login-Phase lädt die Web-App remote —
   *  darüber brandet sich die Login-Seite anders). Optional: ältere Shells
   *  liefern das Feld nicht → Client-Verhalten. */
  appMode?: 'client' | 'server';
  appVersion: string;
  /** Host OS as Node's `process.platform` (`win32` | `darwin` | `linux` | …).
   *  Authoritative platform signal for the native-update check
   *  (`$lib/platform/nativeUpdate`), which maps it to the `native.json` keys.
   *  Optional: shells built before this field fall back to UA detection. */
  os?: string;
  /** Echter Rechnername (Hostname) fürs Geräte-Label, z.B. "michaels-thinkpad".
   *  Nur die Desktop-App kann ihn lesen (im Browser gibt es keine API dafür).
   *  Optional: ältere Shells liefern ihn nicht → Fallback aufs OS. */
  deviceName?: string;
  store: PulseStoreApi;
  gsr: PulseGsrApi;
  notify: PulseNotifyApi;
  invite?: PulseInviteApi;
  updates?: PulseUpdatesApi;
  power?: PulsePowerApi;
  shortcuts?: PulseShortcutsApi;
  clipboard?: PulseClipboardApi;
  files?: PulseFilesApi;
  /** Host-Lifecycle-Bridge (③a). Nur unter Electron vorhanden. */
  host?: PulseHostApi;
  /** Tray-Status overlay: Renderer pusht Status + gerendertes Badge-Image;
   *  Main setzt Tooltip-Text + OS-Badge-Counter (macOS/Windows; Linux
   *  ignoriert den Counter, der Tooltip zeigt die Zahl trotzdem). */
  tray?: PulseTrayApi;
}

/** Payload für `pulse.tray.setStatus()`. Alle Felder optional — main filtert
 *  ungültige Typen und wendet den letzten gültigen Zustand an. */
export interface PulseTrayStatus {
  /** Mic ist aus (kein Audio-Send). PTT-off zählt NICHT — PTT ist semantisch
   *  keine Stummschaltung, sondern Hold-to-Talk. */
  muted?: boolean;
  /** Deaf (alle Remote-Audio gemutet). Impliziert visuell „mute" — gewinnt
   *  bei aktiver Auswahl gegen `muted`. */
  deafened?: boolean;
  /** Anzahl ungelesener Nachrichten. Treibt den OS-Badge-Counter (falls > 0)
   *  und den Tooltip-Text. */
  unread?: number;
  /** Anzahl @-Erwähnungen. Hat Vorrang vor `unread` für den Badge (Erwähnungen
   *  sind dringender); beide sind tooltipsichtbar. */
  mentions?: number;
}

export interface PulseTrayApi {
  setStatus(s: PulseTrayStatus): void;
  /** Ersetzt das Tray-Icon durch ein im Renderer gerendertes PNG (Canvas →
   *  data: URL). Trägt den dynamischen Badge (Counter / @). Main validiert
   *  das `data:image/`-Präfix. Liefert false bei ungültigem Input, sonst true. */
  setImage(dataUrl: string): Promise<boolean>;
}

declare global {
  interface Window {
    pulse?: PulseApi;
  }
}
