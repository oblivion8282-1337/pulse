/**
 * Pulse desktop shell — Electron preload (E1a + E1b).
 *
 * Runs in an isolated context (contextIsolation: true, sandbox: true) and is the
 * ONLY bridge between the renderer (the SvelteKit app) and the main process.
 * Keep the exposed surface minimal but shaped so later stages can extend it
 * cleanly:
 *
 *   E1b: `pulse.gsr.*`        — sidecar bridge (health, gpuInfo, listProfiles,
 *                               listApplicationAudio, buildArgv, start, stop,
 *                               onEvent) — implemented below
 *   E1c: `pulse.store.*`      — settings/token persistence (`get`/`getAll`/`set`),
 *                               backed by the hand-rolled store in `store.ts`
 *   E2:  `pulse.notify.*`     — system notifications for mentions/DMs
 *                               (renderer decides when, main shows + forwards clicks)
 *   later: `pulse.onPttDown` / `pulse.onPttUp` — once a native key-listener exists
 *
 * The renderer detects us via `window.pulse?.platform === 'electron'`
 * (see `web/src/lib/platform/runtime.ts` → `isElectron()`). The shape of the
 * `pulse` object is declared in `web/src/lib/platform/pulse.d.ts` — keep the
 * two in sync.
 *
 * GSR bridge wiring: every `gsr.*` method is a thin `ipcRenderer.invoke('gsr:call', op, params)`
 * (main-side handler in `main.ts`, sidecar logic in `sidecar.ts`). Async events
 * from the sidecar arrive on the `gsr:event` channel — but callbacks can't be
 * passed through contextBridge, so `onEvent(cb)` registers an `ipcRenderer.on`
 * wrapper and returns an unsubscribe function.
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';

const gsrCall = (op: string, params: unknown = {}): Promise<unknown> =>
  ipcRenderer.invoke('gsr:call', op, params);

contextBridge.exposeInMainWorld('pulse', {
  platform: 'electron' as const,
  appVersion: process.env.PULSE_APP_VERSION ?? '0.0.0',
  // Echtes Betriebssystem (`win32`/`darwin`/`linux`) statt UA-Raterei — die
  // Renderer-Plattform-Gates (runtime.ts) bleiben UA-basiert, aber der
  // Native-Update-Check (nativeUpdate.svelte.ts) matcht damit exakt die
  // native.json-Keys. Fällt im Renderer auf UA-Detection zurück, falls eine
  // ältere Shell dieses Feld noch nicht liefert.
  os: process.platform,

  // Settings persistence (E1c) — thin wrappers over the `store:*` IPC channels
  // (main-side store in `store.ts`). The renderer side lives in
  // `web/src/lib/stream/persistence.ts`.
  store: {
    get: (key: string): Promise<unknown> => ipcRenderer.invoke('store:get', key),
    getAll: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('store:getAll'),
    /** Synchronous snapshot of the whole store. Used once at boot by the
     *  multi-server store, which must read synchronously before first paint. */
    getAllSync: (): Record<string, unknown> => ipcRenderer.sendSync('store:getAllSync'),
    set: (key: string, value: unknown): Promise<void> => ipcRenderer.invoke('store:set', key, value),
    /** Atomically write multiple key-value pairs in one IPC round-trip
     *  (finding 158 — enables batch persistence in persistence.ts). */
    setAll: (values: Record<string, unknown>): Promise<void> => ipcRenderer.invoke('store:setAll', values),
  },

  gsr: {
    health: () => gsrCall('health'),
    gpuInfo: () => gsrCall('gpu_info'),
    listProfiles: () => gsrCall('list_profiles'),
    listMonitors: () => gsrCall('list_monitors'),
    listWindows: () => gsrCall('list_windows'),
    listApplicationAudio: () => gsrCall('list_application_audio'),
    buildArgv: (args: unknown) => gsrCall('build_argv', args),
    start: (args: unknown) => gsrCall('start', args),
    stop: () => gsrCall('stop'),

    /** Subscribe to sidecar events (`{ev:..,...}`). Returns an unsubscribe fn.
     *  The renderer-supplied `cb` is invoked from inside this bridge function —
     *  contextBridge allows calling a function the renderer passed in. */
    onEvent: (cb: (ev: unknown) => void): (() => void) => {
      const handler = (_e: unknown, ev: unknown): void => cb(ev);
      ipcRenderer.on('gsr:event', handler);
      return () => ipcRenderer.removeListener('gsr:event', handler);
    },
  },

  // Invite deep-link bridge (Phase 5.3). Main parses + validates pulse://invite
  // URLs and sends the sanitised {hostname, code} pair over this channel.
  // The renderer (root +layout.svelte) subscribes once on mount and navigates
  // to /invite/[code]?host=… where the user sees a confirmation dialog before
  // anything happens.
  invite: {
    /** Subscribe to incoming invite deep-links. Returns an unsubscribe fn. */
    onLink(cb: (data: { hostname: string; code: string }) => void): () => void {
      const handler = (_e: unknown, data: unknown): void => {
        if (!data || typeof data !== 'object') return;
        const d = data as Record<string, unknown>;
        if (typeof d.hostname !== 'string' || typeof d.code !== 'string') return;
        cb({ hostname: d.hostname, code: d.code });
      };
      ipcRenderer.on('pulse:invite', handler);
      return () => ipcRenderer.removeListener('pulse:invite', handler);
    },
    /** Pull any deep-link that arrived before the renderer's onLink listener
     *  was ready (finding 156 — completes the pull-based delivery model).
     *  Returns the buffered payload or null if there is none. */
    getPending: (): Promise<{ hostname: string; code: string } | null> =>
      ipcRenderer.invoke('invite:getPending'),
  },

  // System notifications (mention/DM toasts). The renderer gates these on
  // `document.hidden || !document.hasFocus()` — main shows unconditionally so
  // there's only one source of truth for "should we toast right now".
  notify: {
    show: (payload: {
      title: string;
      body: string;
      icon?: string;
      channel_id: string;
      guild_id?: string | null;
      message_id: string;
      target_url?: string;
    }): Promise<string> => ipcRenderer.invoke('notify:show', payload),

    /** Fires when the user clicks a system notification. Main has already
     *  raised + focused the window by the time this arrives; the callback
     *  should route to the channel/message. Returns an unsubscribe fn. */
    onClick: (
      cb: (data: {
        channel_id: string;
        guild_id?: string | null;
        message_id: string;
        target_url?: string | null;
      }) => void
    ): (() => void) => {
      const handler = (_e: unknown, data: unknown): void => {
        // Defensive shape check — IPC payloads are untrusted by convention.
        if (!data || typeof data !== 'object') return;
        const d = data as Record<string, unknown>;
        if (typeof d.channel_id !== 'string' || typeof d.message_id !== 'string') return;
        const gid = d.guild_id;
        if (gid !== null && gid !== undefined && typeof gid !== 'string') return;
        const turl = d.target_url;
        if (turl !== null && turl !== undefined && typeof turl !== 'string') return;
        cb({
          channel_id: d.channel_id,
          guild_id: (gid as string | null | undefined) ?? null,
          message_id: d.message_id,
          target_url: (turl as string | null | undefined) ?? null,
        });
      };
      ipcRenderer.on('notify:click', handler);
      return () => ipcRenderer.removeListener('notify:click', handler);
    },
  },

  // Auto-Update (Windows, gepackt). Main (`updater.ts`) lädt Updates selbst über
  // electron-updater; der Renderer zeigt nur das „Update bereit"-Banner und
  // triggert den Sofort-Neustart. In dev / im Browser / auf Linux feuert
  // `onReady` nie (main gated den Updater auf app.isPackaged && win32).
  updates: {
    /** Update wurde heruntergeladen + ist installierbereit. Returns unsubscribe-fn. */
    onReady(cb: (data: { version: string }) => void): () => void {
      const handler = (_e: unknown, data: unknown): void => {
        if (!data || typeof data !== 'object') return;
        const d = data as Record<string, unknown>;
        if (typeof d.version !== 'string') return;
        cb({ version: d.version });
      };
      ipcRenderer.on('updates:ready', handler);
      return () => ipcRenderer.removeListener('updates:ready', handler);
    },
    /** Heruntergeladenes Update installieren + sofort neu starten (Banner-Button). */
    restartNow: (): Promise<void> => ipcRenderer.invoke('updates:restart'),
    /** Manueller Re-Check (optional — der Start-Check läuft automatisch in main). */
    check: (): Promise<void> => ipcRenderer.invoke('updates:check'),
  },

  // OS-global keyboard shortcuts (background toggles). The renderer pushes the
  // current bindings (already converted to Electron accelerators) and dispatches
  // `onTrigger` ids through its own handler registry. Main-side in `shortcuts.ts`.
  shortcuts: {
    setGlobal: (list: Array<{ id: string; accelerator: string }>): Promise<void> =>
      ipcRenderer.invoke('shortcuts:setGlobal', list),
    onTrigger: (cb: (id: string) => void): (() => void) => {
      const handler = (_e: unknown, id: unknown): void => {
        if (typeof id === 'string') cb(id);
      };
      ipcRenderer.on('shortcuts:trigger', handler);
      return () => ipcRenderer.removeListener('shortcuts:trigger', handler);
    },
  },

  // Display-sleep inhibitor. The renderer refcounts leases (see
  // `$lib/platform/wakeLock`) and flips this on the 0↔1 boundary; main holds a
  // single `powerSaveBlocker('prevent-display-sleep')`.
  power: {
    keepAwake: (on: boolean): Promise<boolean> => ipcRenderer.invoke('power:keepAwake', on),
  },

  // Clipboard + dropped-file byte access. The sandboxed remote renderer can't
  // read the bytes of a pasted/dropped OS file (size 0 → upload 422); these
  // route through native main-process reads (`clipboard.ts`).
  clipboard: {
    /** Current clipboard image as PNG bytes, or null if the clipboard holds
     *  no image (so the caller can fall through to a normal text paste). */
    readImage: (): Promise<Uint8Array | null> => ipcRenderer.invoke('clipboard:readImage'),
  },
  files: {
    /** Read the bytes of a genuinely dropped File. The OS path is resolved here
     *  from the File via webUtils (a JS-constructed File yields '' → null), then
     *  read in main — so the page can only ever read files the user actually
     *  dragged in, never an arbitrary path. */
    readDropped: (file: File): Promise<Uint8Array | null> => {
      const path = webUtils.getPathForFile(file);
      if (!path) return Promise.resolve(null);
      return ipcRenderer.invoke('file:readPath', path);
    },
  },

  // Host-Lifecycle bridge (③a/③c) — steuert den lokalen Self-Host-Stack.
  // window.pulse.host.* ist der IPC-Kanal zwischen Renderer und HostLifecycle (main.ts).
  host: {
    start: (opts: unknown): Promise<void> => ipcRenderer.invoke('host:start', opts),
    stop: (): Promise<void> => ipcRenderer.invoke('host:stop'),
    getStatus: (): Promise<unknown> => ipcRenderer.invoke('host:status'),
    onPhase: (cb: (e: unknown) => void): (() => void) => {
      const handler = (_e: unknown, ev: unknown): void => cb(ev);
      ipcRenderer.on('host:phase', handler);
      return () => ipcRenderer.removeListener('host:phase', handler);
    },
    pair: (bootstrapToken: string): Promise<unknown> =>
      ipcRenderer.invoke('host:pair', bootstrapToken),
    getPairing: (): Promise<unknown> => ipcRenderer.invoke('host:getPairing'),
    unpair: (): Promise<void> => ipcRenderer.invoke('host:unpair'),
  },
});
