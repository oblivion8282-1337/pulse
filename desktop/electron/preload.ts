/**
 * Pulse desktop shell — Electron preload (E1a).
 *
 * Runs in an isolated context (contextIsolation: true, sandbox: true) and is the
 * ONLY bridge between the renderer (the SvelteKit app) and the main process.
 * Keep the exposed surface minimal but shaped so later stages can extend it
 * cleanly:
 *
 *   E1b: `pulse.gsr.*`        — sidecar bridge (health, gpuInfo, listMonitors,
 *                               listProfiles, listApplicationAudio, buildArgv,
 *                               start, stop, state, onEvent)
 *   E1c: `pulse.store.*`      — settings/token persistence (electron-store in main)
 *   later: `pulse.onPttDown` / `pulse.onPttUp` — once a native key-listener exists
 *
 * The renderer detects us via `window.pulse?.platform === 'electron'`
 * (see `web/src/lib/platform/runtime.ts` → `isElectron()`).
 */

import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('pulse', {
  platform: 'electron' as const,
  appVersion: process.env.PULSE_APP_VERSION ?? '0.0.0',
});
