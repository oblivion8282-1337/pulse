/**
 * Pulse desktop shell — Electron preload (E1a + E1b).
 *
 * Runs in an isolated context (contextIsolation: true, sandbox: true) and is the
 * ONLY bridge between the renderer (the SvelteKit app) and the main process.
 * Keep the exposed surface minimal but shaped so later stages can extend it
 * cleanly:
 *
 *   E1b: `pulse.gsr.*`        — sidecar bridge (health, gpuInfo,
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

// esbuild-define (esbuild.mjs): 'client' | 'server' — dieselbe Weiche wie in
// main.ts. Über die Bridge exponiert, damit die REMOTE geladene Web-App
// (Login-Seite) weiß, dass sie in der Server-App steckt und sich anders
// brandet (sonst sind Client- und Server-App-Login ununterscheidbar).
declare const __APP_MODE__: 'client' | 'server';

const gsrCall = (op: string, params: unknown = {}, slot = 0): Promise<unknown> =>
  ipcRenderer.invoke('gsr:call', op, params, slot);

const playerCall = (op: string, params?: unknown): Promise<unknown> =>
  ipcRenderer.invoke('player:call', op, params);

contextBridge.exposeInMainWorld('pulse', {
  platform: 'electron' as const,
  appMode: __APP_MODE__,
  appVersion: process.env.PULSE_APP_VERSION ?? '0.0.0',
  // Echtes Betriebssystem (`win32`/`darwin`/`linux`) statt UA-Raterei — die
  // Renderer-Plattform-Gates (runtime.ts) bleiben UA-basiert, aber der
  // Native-Update-Check (nativeUpdate.svelte.ts) matcht damit exakt die
  // native.json-Keys. Fällt im Renderer auf UA-Detection zurück, falls eine
  // ältere Shell dieses Feld noch nicht liefert.
  os: process.platform,

  // Echter Rechnername (Hostname) fürs Geräte-Label. Sync beim Start geholt
  // (sandbox: true → kein direktes `os`-Modul im Preload, daher über main).
  // Leerer String / undefined → der Renderer fällt aufs OS zurück.
  deviceName: (() => {
    try {
      return (ipcRenderer.sendSync('app:deviceNameSync') as string) || undefined;
    } catch {
      return undefined;
    }
  })(),

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
    listMonitors: () => gsrCall('list_monitors'),
    listWindows: () => gsrCall('list_windows'),
    listApplicationAudio: () => gsrCall('list_application_audio'),
    buildArgv: (args: unknown) => gsrCall('build_argv', args),
    // start/stop are per-slot — slot 0 is the primary stream, slot 1 a second
    // concurrent one (e.g. a second monitor). The read-only catalog ops above
    // stay on slot 0; they don't depend on which stream is running.
    start: (args: unknown, slot = 0) => gsrCall('start', args, slot),
    stop: (slot = 0) => gsrCall('stop', {}, slot),

    /** Welcher Linux-Sidecar läuft (rust/gsr) und warum — für die Anzeige im
     *  Kompatibilitäts-Tab. Eigener Kanal, kein `gsr:call`: das ist eine
     *  Main-Prozess-Auskunft über die Pfadauflösung, keine Sidecar-Op. */
    backend: () => ipcRenderer.invoke('gsr:backend'),

    /**
     * Fernsteuerung, HOST-Seite: Eingabe-Frames in den Sidecar des gemeinten
     * Stream-Platzes einspielen. Der Renderer bekommt sie auf seiner
     * App-WebSocket (`remote_input`) und reicht sie hier unveraendert weiter —
     * der Hauptprozess hat keine Verbindung zum Gateway.
     *
     * Eigene Kanaele statt `gsr:call`: der Hauptprozess fuehrt Buch darueber,
     * welche Plaetze eine Eingabe-Sitzung haben (s. `remoteInputHost.ts`).
     */
    remoteInput: (slot: number, sessionId: string, frames: string[]): Promise<unknown> =>
      ipcRenderer.invoke('gsr:remoteInput', slot, sessionId, frames),
    /** Sitzungsende — der Sidecar gibt alles Gedrueckte frei (sonst klemmt eine
     *  Taste). Idempotent, und ohne Frames zuvor folgenlos. */
    remoteInputEnd: (): Promise<unknown> => ipcRenderer.invoke('gsr:remoteInputEnd'),

    /** Subscribe to sidecar events (`{ev:..,...}`). Returns an unsubscribe fn.
     *  The renderer-supplied `cb` is invoked from inside this bridge function —
     *  contextBridge allows calling a function the renderer passed in. */
    onEvent: (cb: (ev: unknown) => void): (() => void) => {
      const handler = (_e: unknown, ev: unknown): void => cb(ev);
      ipcRenderer.on('gsr:event', handler);
      return () => ipcRenderer.removeListener('gsr:event', handler);
    },
  },

  /**
   * Nativer HQ-Player (`streaming/pulse-player/`). Optionaler Ersatz fuer das
   * `<video>`-Element: stellt den Stream in einem eigenen Fenster dar, mit
   * mehr als 8 bit Ausgabe und explizit gewaehltem Decoder.
   *
   * Rein additiv — `available()` meldet `false`, wenn das Binary fehlt; der
   * Renderer bleibt dann auf dem bestehenden WHEP-Weg.
   */
  player: {
    available: (): Promise<boolean> => ipcRenderer.invoke('player:available'),
    health: () => playerCall('health'),
    open: (params: unknown) => playerCall('open', params),
    close: (session: number) => playerCall('close', { session }),
    setOption: (session: number, key: string, value: unknown) =>
      playerCall('set_option', { session, key, value }),
    setOptions: (session: number, options: unknown) =>
      playerCall('set_option', { session, options }),
    stats: (session: number) => playerCall('stats', { session }),
    /** Fenster nach vorne holen (das Fenster selbst wertet keine Eingaben aus,
     *  die Bedienung sitzt in der App). Unter Wayland eine Bitte an den
     *  Compositor, keine Garantie. */
    focus: (session: number) => playerCall('focus', { session }),
    /** Fernsteuerung: Anzeigetext des Eingabewegs fuers Statistik-Feld
     *  („Direktverbindung" / „Serverweg — …"). Der Player deutet ihn nicht —
     *  die Zustandsmaschine lebt im Renderer (`$lib/remote/p2p.ts`). */
    transportStatus: (session: number, transport: string) =>
      playerCall('remote_transport', { session, transport }),

    /** Mitschnitt starten. Der Zielpfad wird im Hauptprozess bestimmt und
     *  kommt als `path` in der Antwort zurueck. */
    record: (session: number): Promise<unknown> => ipcRenderer.invoke('player:record', session),
    stopRecord: (session: number): Promise<unknown> =>
      ipcRenderer.invoke('player:stopRecord', session),
    /** Die letzten `seconds` Sekunden aus dem Ringpuffer sichern (1-60). */
    clip: (session: number, seconds = 30): Promise<unknown> =>
      ipcRenderer.invoke('player:clip', session, seconds),

    /** Zustandsereignisse (`player:state`). Liefert eine Abmelde-Funktion. */
    onEvent: (cb: (ev: unknown) => void): (() => void) => {
      const handler = (_e: unknown, ev: unknown): void => cb(ev);
      ipcRenderer.on('player:event', handler);
      return () => ipcRenderer.removeListener('player:event', handler);
    },

    /**
     * Fernsteuerung — Eingabe-Erfassung im Player-Fenster.
     *
     * **Gesendet wird hier, nicht im Hauptprozess.** Der hat keine WebSocket
     * zum Gateway; die App-Verbindung samt Token und Reconnect lebt im
     * Renderer. Er buendelt nur (hoechstens 32 Frames je Nachricht, s.
     * `remoteInput.ts`) und schiebt fertige `remote_input`-Nachrichten ueber
     * `onFrames` herueber — der Renderer setzt sie unveraendert ab.
     */
    input: {
      /** Erfassung einschalten. `sessionId` ist die per Consent bestaetigte
       *  Fernsteuerungs-Sitzung, `slot` der gemeinte Stream des Hosts.
       *
       *  **`pointerLock` erreicht heute keinen Aufrufer** (die steuernde Seite
       *  ruft mit drei Argumenten). Der Zeigerfang samt relativer Bewegungen
       *  ist im Player gebaut und geprueft, aber in der Auslieferung nicht
       *  angeschaltet — hier steht der Draht, der dafuer zu legen waere. */
      start: (
        session: number,
        sessionId: string,
        slot = 0,
        pointerLock = false,
      ): Promise<unknown> =>
        ipcRenderer.invoke('player:inputCapture', {
          session,
          enabled: true,
          sessionId,
          slot,
          pointerLock,
        }),
      /** Erfassung ausschalten. Der Player reicht danach fuer alles Gedrueckte
       *  das Hoch-Ereignis nach — die kommen noch ueber `onFrames`.
       *
       *  **Ohne `slot`, und das ist Absicht.** Die nachgereichten
       *  Hoch-Ereignisse gehoeren dem Stream, der gerade gesteuert wurde; hier
       *  weiss den niemand. Bis zum 2026-08-12 machte der Hauptprozess aus dem
       *  fehlenden Feld eine 0 und der Player uebernahm sie — die Freigaben
       *  einer Steuerung von Platz 2 gingen dann an Platz 0 und legten dort
       *  einen fremden, laufenden Stream fail-closed still. Der Platz liegt
       *  jetzt dort, wo er entsteht: beim Einschalten, und der Player behaelt
       *  ihn (s. `Erfassung::ausschalten`). */
      stop: (session: number): Promise<unknown> =>
        ipcRenderer.invoke('player:inputCapture', { session, enabled: false }),
      /** Fertige `remote_input`-Nachrichten. Liefert eine Abmelde-Funktion. */
      onFrames: (cb: (nachricht: unknown) => void): (() => void) => {
        const handler = (_e: unknown, nachricht: unknown): void => cb(nachricht);
        ipcRenderer.on('player:remoteInput', handler);
        return () => ipcRenderer.removeListener('player:remoteInput', handler);
      },
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
    /** Update auf dem Server gefunden (lädt noch). Returns unsubscribe-fn. */
    onAvailable(cb: (data: { version: string }) => void): () => void {
      const handler = (_e: unknown, data: unknown): void => {
        if (!data || typeof data !== 'object') return;
        const d = data as Record<string, unknown>;
        if (typeof d.version !== 'string') return;
        cb({ version: d.version });
      };
      ipcRenderer.on('updates:available', handler);
      return () => ipcRenderer.removeListener('updates:available', handler);
    },
    /** Download-Fortschritt des aktuellen Updates (0–100 %). Returns unsubscribe-fn. */
    onProgress(cb: (data: { percent: number }) => void): () => void {
      const handler = (_e: unknown, data: unknown): void => {
        if (!data || typeof data !== 'object') return;
        const d = data as Record<string, unknown>;
        if (typeof d.percent !== 'number') return;
        cb({ percent: d.percent });
      };
      ipcRenderer.on('updates:progress', handler);
      return () => ipcRenderer.removeListener('updates:progress', handler);
    },
    /** Update fertig geladen + installierbereit. `autoRestart=true` ⇒ main
     *  installiert + startet automatisch neu (nur im Start-Fenster). */
    onReady(cb: (data: { version: string; autoRestart: boolean }) => void): () => void {
      const handler = (_e: unknown, data: unknown): void => {
        if (!data || typeof data !== 'object') return;
        const d = data as Record<string, unknown>;
        if (typeof d.version !== 'string') return;
        cb({ version: d.version, autoRestart: d.autoRestart === true });
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
    // Zustands-Abgleich: fragt den echten Containerstatus ab (überlebt App-
    // Neustarts dank `--restart unless-stopped`) und hebt die Phase bei
    // Bedarf auf 'live' — server.html ruft das bei jedem UI-Refresh.
    refresh: (): Promise<unknown> => ipcRenderer.invoke('host:refresh'),
    onPhase: (cb: (e: unknown) => void): (() => void) => {
      const handler = (_e: unknown, ev: unknown): void => cb(ev);
      ipcRenderer.on('host:phase', handler);
      return () => ipcRenderer.removeListener('host:phase', handler);
    },
    pair: (bootstrapToken: string): Promise<unknown> =>
      ipcRenderer.invoke('host:pair', bootstrapToken),
    getPairing: (): Promise<unknown> => ipcRenderer.invoke('host:getPairing'),
    provision: (
      opts?: { confirmTakeover?: boolean },
    ): Promise<{ ok: boolean; error?: string; needsTakeoverConfirm?: boolean }> =>
      ipcRenderer.invoke('host:provision', opts),
    // "In der Cloud registriert & auffindbar" — Directory-Heartbeat-Abfrage.
    // { registered: true|false|null }. server.html fragt bei Phase 'live' ab
    // und lauscht zusätzlich auf onCloudStatus (60s-Poll aus dem Main-Prozess).
    cloudStatus: (): Promise<unknown> => ipcRenderer.invoke('host:cloudStatus'),
    onCloudStatus: (cb: (r: unknown) => void): (() => void) => {
      const handler = (_e: unknown, r: unknown): void => cb(r);
      ipcRenderer.on('host:cloudStatus', handler);
      return () => ipcRenderer.removeListener('host:cloudStatus', handler);
    },
    // Autostart beim Anmelden (Schalter in server.html; Default AN beim Pairing).
    getAutostart: (): Promise<{ enabled: boolean }> => ipcRenderer.invoke('host:getAutostart'),
    setAutostart: (enabled: boolean): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('host:setAutostart', enabled),
    // "Deine Daten": Volume-Größe + letztes Backup; Export mit Schritt-Events.
    dataInfo: (): Promise<unknown> => ipcRenderer.invoke('host:dataInfo'),
    exportData: (): Promise<unknown> => ipcRenderer.invoke('host:exportData'),
    onExportStep: (cb: (step: string) => void): (() => void) => {
      const handler = (_e: unknown, step: string): void => cb(step);
      ipcRenderer.on('host:exportStep', handler);
      return () => ipcRenderer.removeListener('host:exportStep', handler);
    },
    // "Server aufgeben": Container+Cloud-Registrierung+Pairing entfernen,
    // optional inkl. lokaler Daten (server.html-Bestätigungs-Overlay).
    giveUp: (opts?: { deleteData?: boolean }): Promise<unknown> =>
      ipcRenderer.invoke('host:giveUp', opts),
    unpair: (): Promise<void> => ipcRenderer.invoke('host:unpair'),
    runtimeAvailable: (): Promise<boolean> => ipcRenderer.invoke('host:runtime'),
    setupWindows: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('host:setupWindows'),
  },

  // Tray-Status overlay (Mute/Deaf → Icon, Unread/Mentions → Tooltip + OS-Badge +
  // dynamisch vom Renderer gerendertes Badge-Image via data: URL).
  tray: {
    setStatus: (s: {
      muted?: boolean;
      deafened?: boolean;
      unread?: number;
      mentions?: number;
    }): void =>
      ipcRenderer.send('tray:setStatus', s),
    /** Tray-Icon aus vom Renderer gerendertem PNG (Canvas → data: URL) mit
     *  dynamischem Badge. Main validiert das `data:image/`-Präfix. */
    setImage: (dataUrl: string): Promise<boolean> =>
      ipcRenderer.invoke('tray:setImage', dataUrl),
  },
});
