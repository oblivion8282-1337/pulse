/**
 * User-side stream settings (T3b).
 *
 * In-memory `$state` object that holds the *user's* current picker selections
 * — distinct from `state.svelte.ts` which mirrors the live sidecar state
 * (running/fps/uptime/log) coming back over `gsr://event`.
 *
 * No persistence here. T3c will wire `loadCatalogs()` and the picker fields
 * into the Tauri `@tauri-apps/plugin-store` so the user's last selections
 * survive an app restart.
 *
 * Field shapes mirror what the sidecar's `gsr_start` body expects (see
 * `gsr.ts::GsrStartArgs` and `streaming/gsr-sidecar/control.py::op_start`):
 * `profile` + `server` by name, `capture` is `"portal"` or a monitor name,
 * `audio.mode` is one of the four GSR audio labels.
 */

import { gsr, type GsrProfile, type GsrServer, type GsrMonitor, type GsrStartArgs } from './gsr';

// ── Types ───────────────────────────────────────────────────────────────────

export type AudioMode = 'Aus' | 'Desktop' | 'Mikrofon' | 'Desktop + Mikrofon';

export interface OverrideSet {
  codec?: string;
  bitrate_kbps?: number;
  fps?: number;
  resolution?: string;
}

// The seven codec values the GSR `-k` flag accepts (mirrors
// `streaming/gsr-sidecar/profiles.py::VIDEO_CODECS_ALL`).
export const CODEC_VALUES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'h264', label: 'H.264' },
  { value: 'hevc', label: 'HEVC' },
  { value: 'hevc_10bit', label: 'HEVC 10-bit' },
  { value: 'hevc_hdr', label: 'HEVC HDR' },
  { value: 'av1', label: 'AV1' },
  { value: 'av1_10bit', label: 'AV1 10-bit' },
  { value: 'av1_hdr', label: 'AV1 HDR' },
];

export const RESOLUTION_VALUES: ReadonlyArray<string> = ['Native', '1440p', '1080p', '720p'];

export const AUDIO_MODES: ReadonlyArray<AudioMode> = [
  'Aus',
  'Desktop',
  'Mikrofon',
  'Desktop + Mikrofon',
];

export function isHdrCodec(codec: string | undefined): boolean {
  return !!codec && codec.endsWith('_hdr');
}

export function audioModeUsesDesktop(mode: AudioMode): boolean {
  return mode === 'Desktop' || mode === 'Desktop + Mikrofon';
}

// ── Reactive state ──────────────────────────────────────────────────────────

export const streamSettings = $state({
  // Selections
  profile_name: '',
  server_name: '',
  capture_source: 'portal' as 'portal' | string,
  audio_mode: 'Desktop' as AudioMode,
  excluded_apps: [] as string[],
  overrides: {} as OverrideSet,
  use_overrides: false,

  // Catalogs (filled by `loadCatalogs()`)
  available_profiles: [] as GsrProfile[],
  available_servers: [] as GsrServer[],
  available_monitors: [] as GsrMonitor[],
  available_audio_apps: [] as string[],

  // Diagnostics
  catalogs_loaded: false,
  catalog_error: null as string | null,
});

let loading = false;

/**
 * Idempotently fetch profiles/servers/monitors/audio-apps from the sidecar
 * and populate the catalogs above. Failures are reported via
 * `catalog_error` — they don't throw. Re-callable (e.g. after mounting the
 * stream panel, or via a refresh button).
 */
export async function loadCatalogs(): Promise<void> {
  if (loading) return;
  loading = true;
  streamSettings.catalog_error = null;
  try {
    const [profiles, monitors, audioApps] = await Promise.all([
      gsr.listProfiles(),
      gsr.listMonitors(),
      gsr.listApplicationAudio(),
    ]);

    if (profiles?.ok) {
      streamSettings.available_profiles = profiles.profiles ?? [];
      streamSettings.available_servers = profiles.servers ?? [];
      if (!streamSettings.profile_name && streamSettings.available_profiles.length > 0) {
        streamSettings.profile_name = streamSettings.available_profiles[0].name;
      }
      if (!streamSettings.server_name && streamSettings.available_servers.length > 0) {
        streamSettings.server_name = streamSettings.available_servers[0].name;
      }
    }
    if (monitors?.ok) {
      streamSettings.available_monitors = monitors.monitors ?? [];
    }
    if (audioApps?.ok) {
      streamSettings.available_audio_apps = audioApps.applications ?? [];
    }
    streamSettings.catalogs_loaded = true;
  } catch (e) {
    streamSettings.catalog_error = e instanceof Error ? e.message : String(e);
  } finally {
    loading = false;
  }
}

/** Refresh just the audio-app list (cheap, called from the audio picker). */
export async function refreshAudioApps(): Promise<void> {
  try {
    const r = await gsr.listApplicationAudio();
    if (r?.ok) streamSettings.available_audio_apps = r.applications ?? [];
  } catch {
    // tolerate — keep the previous list
  }
}

/** True iff the current selection is the synthetic "Custom" profile. */
export function isCustomProfile(): boolean {
  return streamSettings.profile_name === 'Custom';
}

/** Look up the currently selected profile in the catalog (or `undefined`). */
export function currentProfile(): GsrProfile | undefined {
  return streamSettings.available_profiles.find((p) => p.name === streamSettings.profile_name);
}

// ── Mapping helpers ─────────────────────────────────────────────────────────

/**
 * Translate the in-memory `streamSettings` into the body shape that
 * `gsr.start()` / `gsr.buildArgv()` expect. Overrides are only included when
 * `use_overrides` is set (or the user picked the synthetic "Custom" profile).
 */
export function buildStartArgs(streamKey: string = 'PLACEHOLDER'): GsrStartArgs {
  const apply = streamSettings.use_overrides || isCustomProfile();
  const args: GsrStartArgs = {
    profile: streamSettings.profile_name,
    server: streamSettings.server_name,
    capture: streamSettings.capture_source,
    audio: {
      mode: streamSettings.audio_mode,
      excluded_apps: streamSettings.excluded_apps.slice(),
    },
    stream_key: streamKey,
  };
  if (apply) {
    const o = streamSettings.overrides;
    const cleaned: OverrideSet = {};
    if (o.codec) cleaned.codec = o.codec;
    if (typeof o.bitrate_kbps === 'number' && o.bitrate_kbps > 0)
      cleaned.bitrate_kbps = o.bitrate_kbps;
    if (typeof o.fps === 'number' && o.fps > 0) cleaned.fps = o.fps;
    if (o.resolution) cleaned.resolution = o.resolution;
    if (Object.keys(cleaned).length > 0) args.overrides = cleaned;
  }
  return args;
}

// ── App-Exclude-Liste Mutationen ────────────────────────────────────────────

export function addExcludedApp(name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  if (streamSettings.excluded_apps.includes(trimmed)) return;
  streamSettings.excluded_apps = [...streamSettings.excluded_apps, trimmed];
}

export function removeExcludedApp(name: string): void {
  streamSettings.excluded_apps = streamSettings.excluded_apps.filter((a) => a !== name);
}
