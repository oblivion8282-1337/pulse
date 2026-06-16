/**
 * Typed bridge to the GSR sidecar.
 *
 * Since E1b the sidecar is a Python child process owned by the Electron main
 * process (`desktop/electron/sidecar.ts`); the renderer talks to it through the
 * `window.pulse.gsr.*` API the preload exposes (each method is an
 * `ipcRenderer.invoke('gsr:call', op, params)` under the hood, events arrive on
 * `gsr:event`). Before E1b this wrapped the Tauri `gsr_*` commands +
 * `gsr://event` — the exported API here is unchanged; only the transport moved.
 *
 * In a plain browser (`!gsr.available()`) every method returns `null`/`false`
 * and never throws — the streaming UI is hidden in that case anyway, but it's
 * useful that the module is import-safe everywhere.
 *
 * Wire protocol: see `streaming/README.md`. We surface the raw JSON the
 * sidecar returns; the only typing we do here is on the *shape* of the
 * response, not on every nested field — that lets the sidecar evolve without
 * forcing a frontend update for every new health field.
 */

import { isElectron } from '$lib/platform/runtime';

// ── Response types ──────────────────────────────────────────────────────────

/** `{"ok":true, gsr: {...}}` from `gsr_health`. */
export interface GsrHealth {
  ok: boolean;
  gsr: {
    available: boolean;
    source: string;
    is_flatpak: boolean;
    path?: string;
    version?: string;
    vendor?: string;
    display_server?: string;
    video_codecs?: string[];
    capture_options?: string[];
    has_flv_patch?: boolean;
  };
}

export interface GsrGpuInfo {
  ok: boolean;
  vendor?: string;
  card_path?: string;
  display_server?: string;
  video_codecs?: string[];
  error?: string;
}

export interface GsrProfile {
  name: string;
  codec: string;
  audio_codec: string;
  container: string;
  bitrate_kbps: number;
  fps: number;
  needs_custom_build: boolean;
  notes: string;
}
export interface GsrListProfiles {
  ok: boolean;
  profiles: GsrProfile[];
  /** Always `[]` — Pulse streams into a voice channel, there's no server
   *  catalog. Kept for shape-compat with the sidecar response. */
  servers: unknown[];
  audio_modes: string[];
  app_label_prefix: string;
}

export interface GsrListApplicationAudio {
  ok: boolean;
  applications?: string[];
  error?: string;
}

/** One display monitor, as reported by the Windows sidecar's `list_monitors`.
 *  `index` is 1-based and round-trips as the `"Monitor: <index>"` capture
 *  source the sidecar resolves via `Monitor::from_index`. */
export interface GsrMonitor {
  index: number;
  name: string;
  primary: boolean;
  width: number;
  height: number;
  refresh_hz: number;
}
export interface GsrListMonitors {
  ok: boolean;
  monitors?: GsrMonitor[];
  error?: string;
}

export interface GsrWindow {
  /** CoreGraphics window id — round-trips as the `capture: "window:<id>"` token. */
  id: number;
  title: string;
  app: string;
  width: number;
  height: number;
}
export interface GsrListWindows {
  ok: boolean;
  windows?: GsrWindow[];
  error?: string;
}

export interface GsrBuildArgv {
  ok: boolean;
  binary?: string;
  argv?: string[];
  error?: string;
}

export interface GsrStartArgs {
  profile: string;
  /** Pulse-channel pathway: server profile built via `ServerProfile.from_channel`.
   *  This is the only pathway — Pulse always streams into a voice channel. */
  channel: {
    id: string;
    token: string;
    /** Full push URL from media-svc — handed to GSR's `-o` verbatim. */
    push_url?: string;
  };
  capture: string;
  audio: { mode: string; excluded_apps?: string[] };
  overrides?: { codec?: string; bitrate_kbps?: number; fps?: number; resolution?: string };
  /** Show the mouse cursor in the captured stream. Default true (GSR's
   *  built-in default); set to false to pass `-cursor no`. */
  show_cursor?: boolean;
  /** Windows-only constant A/V trim in ms (>0 = audio later). Tunes the
   *  residual lip-sync offset the QPC anchor can't catch. Ignored by the Linux
   *  sidecar (gpu-screen-recorder syncs internally). Omit/0 = neutral. */
  av_offset_ms?: number;
}

export interface GsrStartResult {
  ok: boolean;
  argv?: string[];
  error?: string;
}
export interface GsrStopResult {
  ok: boolean;
  running?: boolean;
  note?: string;
  error?: string;
}

// ── Event types (forwarded from the sidecar) ────────────────────────────────

export type GsrEvent =
  | { ev: 'state'; state: 'idle' | 'starting' | 'live' | 'error' | 'stopped'; running: boolean; uptime_s: number }
  | { ev: 'fps'; fps: number; uptime_s: number }
  | { ev: 'log'; line: string }
  | { ev: 'error'; message: string }
  | { ev: 'stopped'; code?: number };

// ── Bridge helpers ──────────────────────────────────────────────────────────

type Unlisten = () => void;

/** The `window.pulse.gsr` bridge, or `null` when not running inside Electron. */
function bridge(): NonNullable<Window['pulse']>['gsr'] | null {
  if (typeof window === 'undefined') return null;
  return window.pulse?.gsr ?? null;
}

export const gsr = {
  /** True iff we're inside the Electron shell and the sidecar bridge is present.
   *  (Cheap — does not actually call the sidecar; use `health()` for that.) */
  available(): boolean {
    return isElectron() && bridge() !== null;
  },

  async health(): Promise<GsrHealth | null> {
    const b = bridge();
    return b ? ((await b.health()) as GsrHealth) : null;
  },
  async gpuInfo(): Promise<GsrGpuInfo | null> {
    const b = bridge();
    return b ? ((await b.gpuInfo()) as GsrGpuInfo) : null;
  },
  async listProfiles(): Promise<GsrListProfiles | null> {
    const b = bridge();
    return b ? ((await b.listProfiles()) as GsrListProfiles) : null;
  },
  /** Enumerate display monitors. Windows-only in practice — on Linux the
   *  portal dialog handles source selection, so callers gate on `isWindows()`. */
  async listMonitors(): Promise<GsrListMonitors | null> {
    const b = bridge();
    return b ? ((await b.listMonitors()) as GsrListMonitors) : null;
  },
  /** Enumerate capturable windows (macOS source picker). */
  async listWindows(): Promise<GsrListWindows | null> {
    const b = bridge();
    return b ? ((await b.listWindows()) as GsrListWindows) : null;
  },
  async listApplicationAudio(): Promise<GsrListApplicationAudio | null> {
    const b = bridge();
    return b ? ((await b.listApplicationAudio()) as GsrListApplicationAudio) : null;
  },
  async buildArgv(args: GsrStartArgs): Promise<GsrBuildArgv | null> {
    const b = bridge();
    return b ? ((await b.buildArgv(args)) as GsrBuildArgv) : null;
  },
  async start(args: GsrStartArgs): Promise<GsrStartResult | null> {
    const b = bridge();
    return b ? ((await b.start(args)) as GsrStartResult) : null;
  },
  async stop(): Promise<GsrStopResult | null> {
    const b = bridge();
    return b ? ((await b.stop()) as GsrStopResult) : null;
  },

  /**
   * Subscribe to sidecar events (the `gsr:event` IPC channel). Returns a
   * disposer. No-op (returns immediately) in a plain browser.
   *
   * Stays `async` for signature compatibility with the previous Tauri-based
   * implementation (callers `await` it) — the underlying preload `onEvent` is
   * synchronous and returns the unsubscribe function directly.
   */
  async onEvent(cb: (ev: GsrEvent) => void): Promise<Unlisten> {
    const b = bridge();
    if (!b) return () => {};
    return b.onEvent((ev) => cb(ev as GsrEvent));
  },
};
