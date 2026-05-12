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
  set(key: string, value: unknown): Promise<void>;
}

export interface PulseGsrApi {
  health(): Promise<unknown>;
  gpuInfo(): Promise<unknown>;
  listMonitors(): Promise<unknown>;
  listProfiles(): Promise<unknown>;
  listApplicationAudio(): Promise<unknown>;
  buildArgv(args: unknown): Promise<unknown>;
  start(args: unknown): Promise<unknown>;
  stop(): Promise<unknown>;
  state(): Promise<unknown>;
  /** Subscribe to sidecar events. Returns an unsubscribe function. */
  onEvent(cb: (ev: PulseGsrEvent) => void): () => void;
}

export interface PulseApi {
  platform: 'electron';
  appVersion: string;
  store: PulseStoreApi;
  gsr: PulseGsrApi;
}

declare global {
  interface Window {
    pulse?: PulseApi;
  }
}
