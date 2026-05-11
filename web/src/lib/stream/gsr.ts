/**
 * Typed bridge to the Rust-side GSR sidecar (T3a).
 *
 * The Tauri layer exposes nine `gsr_*` commands and a single event channel
 * `gsr://event`. This module wraps both in a small typed API so the rest of
 * the web app doesn't deal with raw `invoke()` calls.
 *
 * In a plain browser (`!isTauri()`) every method returns `null`/`false` and
 * never throws — the streaming UI is hidden in that case anyway, but it's
 * useful that the module is import-safe everywhere.
 *
 * Wire protocol: see `streaming/README.md`. We surface the raw JSON the
 * sidecar returns; the only typing we do here is on the *shape* of the
 * response, not on every nested field — that lets the sidecar evolve without
 * forcing a frontend update for every new health field.
 */

import { isTauri } from '$lib/platform/runtime';

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

export interface GsrMonitor {
  name: string;
  resolution: string;
}
export interface GsrListMonitors {
  ok: boolean;
  monitors?: GsrMonitor[];
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
export interface GsrServer {
  name: string;
  push_protocol: string;
  push_host: string;
  push_port: number;
  push_path: string;
  needs_auth: boolean;
  auth_user: string;
}
export interface GsrListProfiles {
  ok: boolean;
  profiles: GsrProfile[];
  servers: GsrServer[];
  audio_modes: string[];
  app_label_prefix: string;
}

export interface GsrListApplicationAudio {
  ok: boolean;
  applications?: string[];
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
  server?: string;
  channel?: { id: string; token: string; mediamtx_endpoint?: string; push_protocol?: string };
  capture: string;
  audio: { mode: string; excluded_apps?: string[] };
  overrides?: { codec?: string; bitrate_kbps?: number; fps?: number; resolution?: string };
  stream_key?: string;
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
export interface GsrState {
  ok: boolean;
  running: boolean;
  state: string;
  fps: number | null;
  uptime_s: number;
  argv: string[] | null;
}

// ── Event types (forwarded from the sidecar) ────────────────────────────────

export type GsrEvent =
  | { ev: 'state'; state: 'idle' | 'starting' | 'live' | 'error' | 'stopped'; running: boolean; uptime_s: number }
  | { ev: 'fps'; fps: number; uptime_s: number }
  | { ev: 'log'; line: string }
  | { ev: 'error'; message: string }
  | { ev: 'stopped'; code?: number };

// ── Invoke helpers ──────────────────────────────────────────────────────────

type Unlisten = () => void;

async function invokeOrNull<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isTauri()) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  return (await invoke(cmd, args)) as T;
}

export const gsr = {
  /** True iff we're inside Tauri and the bridge can be reached. (Cheap — does
   *  not actually call the sidecar; use `health()` for that.) */
  available(): boolean {
    return isTauri();
  },

  async health(): Promise<GsrHealth | null> {
    return invokeOrNull<GsrHealth>('gsr_health');
  },
  async gpuInfo(): Promise<GsrGpuInfo | null> {
    return invokeOrNull<GsrGpuInfo>('gsr_gpu_info');
  },
  async listMonitors(): Promise<GsrListMonitors | null> {
    return invokeOrNull<GsrListMonitors>('gsr_list_monitors');
  },
  async listProfiles(): Promise<GsrListProfiles | null> {
    return invokeOrNull<GsrListProfiles>('gsr_list_profiles');
  },
  async listApplicationAudio(): Promise<GsrListApplicationAudio | null> {
    return invokeOrNull<GsrListApplicationAudio>('gsr_list_application_audio');
  },
  async buildArgv(args: GsrStartArgs): Promise<GsrBuildArgv | null> {
    return invokeOrNull<GsrBuildArgv>('gsr_build_argv', { args });
  },
  async start(args: GsrStartArgs): Promise<GsrStartResult | null> {
    return invokeOrNull<GsrStartResult>('gsr_start', { args });
  },
  async stop(): Promise<GsrStopResult | null> {
    return invokeOrNull<GsrStopResult>('gsr_stop');
  },
  async state(): Promise<GsrState | null> {
    return invokeOrNull<GsrState>('gsr_state');
  },

  /**
   * Subscribe to `gsr://event` events from the sidecar. Returns a disposer.
   * No-op in a plain browser.
   */
  async onEvent(cb: (ev: GsrEvent) => void): Promise<Unlisten> {
    if (!isTauri()) return () => {};
    const { listen } = await import('@tauri-apps/api/event');
    const unlisten = await listen<GsrEvent>('gsr://event', (e) => cb(e.payload));
    return unlisten;
  },
};
