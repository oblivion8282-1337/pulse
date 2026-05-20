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

import { contextBridge, ipcRenderer } from 'electron';

const gsrCall = (op: string, params: unknown = {}): Promise<unknown> =>
  ipcRenderer.invoke('gsr:call', op, params);

contextBridge.exposeInMainWorld('pulse', {
  platform: 'electron' as const,
  appVersion: process.env.PULSE_APP_VERSION ?? '0.0.0',

  // Settings persistence (E1c) — thin wrappers over the `store:*` IPC channels
  // (main-side store in `store.ts`). The renderer side lives in
  // `web/src/lib/stream/persistence.ts`.
  store: {
    get: (key: string): Promise<unknown> => ipcRenderer.invoke('store:get', key),
    getAll: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('store:getAll'),
    set: (key: string, value: unknown): Promise<void> => ipcRenderer.invoke('store:set', key, value),
  },

  gsr: {
    health: () => gsrCall('health'),
    gpuInfo: () => gsrCall('gpu_info'),
    listProfiles: () => gsrCall('list_profiles'),
    listMonitors: () => gsrCall('list_monitors'),
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
    }): Promise<string> => ipcRenderer.invoke('notify:show', payload),

    /** Fires when the user clicks a system notification. Main has already
     *  raised + focused the window by the time this arrives; the callback
     *  should route to the channel/message. Returns an unsubscribe fn. */
    onClick: (
      cb: (data: { channel_id: string; guild_id?: string | null; message_id: string }) => void
    ): (() => void) => {
      const handler = (_e: unknown, data: unknown): void => {
        // Defensive shape check — IPC payloads are untrusted by convention.
        if (!data || typeof data !== 'object') return;
        const d = data as Record<string, unknown>;
        if (typeof d.channel_id !== 'string' || typeof d.message_id !== 'string') return;
        const gid = d.guild_id;
        if (gid !== null && gid !== undefined && typeof gid !== 'string') return;
        cb({
          channel_id: d.channel_id,
          guild_id: (gid as string | null | undefined) ?? null,
          message_id: d.message_id,
        });
      };
      ipcRenderer.on('notify:click', handler);
      return () => ipcRenderer.removeListener('notify:click', handler);
    },
  },
});
