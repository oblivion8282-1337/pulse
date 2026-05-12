/**
 * Pulse desktop shell — Electron preload (E1a + E1b).
 *
 * Runs in an isolated context (contextIsolation: true, sandbox: true) and is the
 * ONLY bridge between the renderer (the SvelteKit app) and the main process.
 * Keep the exposed surface minimal but shaped so later stages can extend it
 * cleanly:
 *
 *   E1b: `pulse.gsr.*`        — sidecar bridge (health, gpuInfo, listMonitors,
 *                               listProfiles, listApplicationAudio, buildArgv,
 *                               start, stop, state, onEvent) — implemented below
 *   E1c: `pulse.store.*`      — settings/token persistence (electron-store in main)
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

  gsr: {
    health: () => gsrCall('health'),
    gpuInfo: () => gsrCall('gpu_info'),
    listMonitors: () => gsrCall('list_monitors'),
    listProfiles: () => gsrCall('list_profiles'),
    listApplicationAudio: () => gsrCall('list_application_audio'),
    buildArgv: (args: unknown) => gsrCall('build_argv', args),
    start: (args: unknown) => gsrCall('start', args),
    stop: () => gsrCall('stop'),
    state: () => gsrCall('state'),

    /** Subscribe to sidecar events (`{ev:..,...}`). Returns an unsubscribe fn.
     *  The renderer-supplied `cb` is invoked from inside this bridge function —
     *  contextBridge allows calling a function the renderer passed in. */
    onEvent: (cb: (ev: unknown) => void): (() => void) => {
      const handler = (_e: unknown, ev: unknown): void => cb(ev);
      ipcRenderer.on('gsr:event', handler);
      return () => ipcRenderer.removeListener('gsr:event', handler);
    },
  },
});
