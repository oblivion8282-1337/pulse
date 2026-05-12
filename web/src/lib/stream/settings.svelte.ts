/**
 * User-side stream settings (T3b + T3c).
 *
 * In-memory `$state` object that holds the *user's* current picker selections
 * — distinct from `state.svelte.ts` which mirrors the live sidecar state
 * (running/fps/uptime/log) coming back over `gsr://event`.
 *
 * **T3c additions:**
 * - Persistence (via `persistence.ts`: `window.pulse.store.*` under Electron,
 *   `localStorage` fallback in a plain browser) for the user's picker
 *   selections and any custom server definitions. Persisted values *win over*
 *   the GPU-Detection-Defaults — see `loadCatalogs()`.
 * - GPU-detection: after the sidecar's `gpu_info` response is in, we pick a
 *   sensible default profile name (NVIDIA-AV1 → "AV1 Effizient", everything
 *   else → "H.264 Standard"), but only if nothing was persisted yet.
 * - Custom servers: user-defined `GsrServer`-shaped entries that get merged
 *   into `available_servers`. The full server-spec (host/ports/auth-user) +
 *   the *cleartext* stream key live in the persistence layer — see
 *   `persistence.ts` for the security note (store file is chmod 600 on Linux).
 *
 * Field shapes mirror what the sidecar's `gsr_start` body expects (see
 * `gsr.ts::GsrStartArgs` and `streaming/gsr-sidecar/control.py::op_start`).
 */

import { gsr, type GsrProfile, type GsrServer, type GsrMonitor, type GsrGpuInfo, type GsrStartArgs } from './gsr';
import { debounce, loadAll, saveAll } from './persistence';

// ── Types ───────────────────────────────────────────────────────────────────

export type AudioMode = 'Aus' | 'Desktop' | 'Mikrofon' | 'Desktop + Mikrofon';

export interface OverrideSet {
  codec?: string;
  bitrate_kbps?: number;
  fps?: number;
  resolution?: string;
}

/**
 * User-defined server. Mirrors the on-the-wire `GsrServer` from
 * `gsr_list_profiles`, plus an `is_custom` flag (always `true` here) and a
 * `stream_key` field. The key is *only* present on custom entries — built-in
 * server entries from the sidecar catalog never carry one (those keys are
 * supplied transiently at `start` time).
 */
export interface CustomServer extends GsrServer {
  is_custom: true;
  stream_key: string;
}

// Codec values the GSR `-k` flag accepts. The UI only offers H.264 (universal
// browser compat) and AV1 (~half the bitrate at the same quality); the sidecar
// still understands the HEVC / 10-bit / HDR variants, we just don't surface
// them (this also matches the Flatpak GSR build, which only ships h264 + av1).
export const CODEC_VALUES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'h264', label: 'H.264' },
  { value: 'av1', label: 'AV1' },
];

// Downscale targets only — GSR scales to exactly the chosen size, so offering
// something bigger than the monitor would just upscale (more bandwidth, no
// detail). 'Native' means "don't scale". The sidecar still understands a
// persisted '1440p' from before this change.
export const RESOLUTION_VALUES: ReadonlyArray<string> = ['Native', '1080p', '720p', '480p'];

export const AUDIO_MODES: ReadonlyArray<AudioMode> = [
  'Aus',
  'Desktop',
  'Mikrofon',
  'Desktop + Mikrofon',
];

/** Prefix the sidecar uses to recognise "capture this app's audio" — the
 *  on-the-wire `audio.mode` for app capture is `"App: <name>"`, which the
 *  sidecar maps to GSR's `-a "app:<name>"`. (Mirrors `APP_LABEL_PREFIX` in
 *  `streaming/gsr-sidecar/profiles.py`.) */
export const APP_AUDIO_PREFIX = 'App: ';

export function isAppAudioMode(mode: string): boolean {
  return mode.startsWith(APP_AUDIO_PREFIX);
}

export function appFromAudioMode(mode: string): string {
  return isAppAudioMode(mode) ? mode.slice(APP_AUDIO_PREFIX.length) : '';
}

export function isHdrCodec(codec: string | undefined): boolean {
  return !!codec && codec.endsWith('_hdr');
}

export function audioModeUsesDesktop(mode: string): boolean {
  return mode === 'Desktop' || mode === 'Desktop + Mikrofon';
}

// ── Reactive state ──────────────────────────────────────────────────────────

/** Where the HQ stream is pushed: into the current Pulse voice channel
 *  (the per-channel MediaMTX path `channel-<id>`, token from chat-gateway), or
 *  to a server profile picked from the catalog / a custom server (the T3c
 *  pathway). `'channel'` is only meaningful when the user is in a voice channel
 *  — the picker hides it otherwise. Not persisted: it depends on context. */
export type StreamTarget = 'channel' | 'server';

export const streamSettings = $state({
  // Selections (persisted)
  profile_name: '',
  server_name: '',
  capture_source: 'portal' as 'portal' | string,
  // One of AUDIO_MODES, or `"App: <name>"` (capture a specific running app).
  audio_mode: 'Desktop' as string,
  // Remembers the last app picked for the "App: …" mode, so toggling away and
  // back keeps the selection.
  audio_app: '' as string,
  excluded_apps: [] as string[],
  overrides: {} as OverrideSet,
  use_overrides: false,

  // Stream target (not persisted — context-dependent). Defaults to `'channel'`
  // when opened from a voice channel; the StreamPanel sets this on mount.
  target: 'channel' as StreamTarget,

  // Custom servers (persisted)
  custom_servers: [] as CustomServer[],

  // Catalogs from sidecar (filled by `loadCatalogs()`)
  available_profiles: [] as GsrProfile[],
  available_servers: [] as GsrServer[], // merged: built-ins + custom_servers
  available_monitors: [] as GsrMonitor[],
  available_audio_apps: [] as string[],

  // GPU info cache (filled by `loadCatalogs()` → consumed by AV1-warning etc.)
  gpu_info: null as GsrGpuInfo | null,

  // Diagnostics
  catalogs_loaded: false,
  catalog_error: null as string | null,
  persisted_loaded: false,
});

// ── Persistence ─────────────────────────────────────────────────────────────

// Which fields get persisted. Order doesn't matter; the keys are stable.
const PERSIST_KEYS = [
  'profile_name',
  'server_name',
  'capture_source',
  'audio_mode',
  'audio_app',
  'excluded_apps',
  'overrides',
  'use_overrides',
  'custom_servers',
] as const;

type PersistKey = (typeof PERSIST_KEYS)[number];

function snapshotPersisted(): Record<PersistKey, unknown> {
  return {
    profile_name: streamSettings.profile_name,
    server_name: streamSettings.server_name,
    capture_source: streamSettings.capture_source,
    audio_mode: streamSettings.audio_mode,
    audio_app: streamSettings.audio_app,
    excluded_apps: streamSettings.excluded_apps.slice(),
    overrides: { ...streamSettings.overrides },
    use_overrides: streamSettings.use_overrides,
    custom_servers: streamSettings.custom_servers.slice(),
  };
}

const persistDebounced = debounce(() => saveAll(snapshotPersisted()), 300);

/**
 * Persist current settings. Debounced ~300ms so frantic input (bitrate slider,
 * etc.) doesn't hammer disk. Safe to call from `$effect`.
 */
export function persistSettings(): void {
  persistDebounced();
}

/** One-shot: load persisted values into `streamSettings`. Idempotent. */
export async function loadPersisted(): Promise<void> {
  if (streamSettings.persisted_loaded) return;
  const data = await loadAll();
  applyPersisted(data);
  streamSettings.persisted_loaded = true;
}

function applyPersisted(data: Record<string, unknown>): void {
  if (typeof data.profile_name === 'string') streamSettings.profile_name = data.profile_name;
  if (typeof data.server_name === 'string') streamSettings.server_name = data.server_name;
  if (typeof data.capture_source === 'string') streamSettings.capture_source = data.capture_source;
  if (
    typeof data.audio_mode === 'string' &&
    ((AUDIO_MODES as ReadonlyArray<string>).includes(data.audio_mode) ||
      data.audio_mode.startsWith(APP_AUDIO_PREFIX))
  ) {
    streamSettings.audio_mode = data.audio_mode;
  }
  if (typeof data.audio_app === 'string') streamSettings.audio_app = data.audio_app;
  if (Array.isArray(data.excluded_apps)) {
    streamSettings.excluded_apps = data.excluded_apps.filter((x): x is string => typeof x === 'string');
  }
  if (data.overrides && typeof data.overrides === 'object') {
    streamSettings.overrides = { ...(data.overrides as OverrideSet) };
  }
  if (typeof data.use_overrides === 'boolean') {
    streamSettings.use_overrides = data.use_overrides;
  }
  if (Array.isArray(data.custom_servers)) {
    streamSettings.custom_servers = data.custom_servers
      .filter((s): s is CustomServer => !!s && typeof s === 'object' && (s as { name?: unknown }).name != null)
      .map((s) => ({ ...s, is_custom: true }));
  }
}

// ── Catalog loading + GPU defaults ──────────────────────────────────────────

let loading = false;

/**
 * Pick a default profile name from the GPU's reported `video_codecs`. Mirrors
 * the old Qt `_set_default_profile_for_gpu` logic from `ui/stream_window.py`:
 * AV1-encode → "AV1 Effizient", otherwise "H.264 Standard". Falls neither
 * matches the available-profiles catalog, we fall back to the first entry.
 */
export function defaultProfileForGpu(
  gpuInfo: GsrGpuInfo | null,
  profiles: ReadonlyArray<GsrProfile>,
): string {
  if (profiles.length === 0) return '';
  const names = new Set(profiles.map((p) => p.name));
  const codecs = (gpuInfo?.video_codecs ?? []).map((c) => c.toLowerCase());
  // Heuristic: any codec string that mentions "av1" implies AV1 encode support.
  const hasAv1 = codecs.some((c) => c.includes('av1'));
  if (hasAv1 && names.has('AV1 Effizient')) return 'AV1 Effizient';
  if (names.has('H.264 Standard')) return 'H.264 Standard';
  return profiles[0].name;
}

/** True iff the *currently selected* profile uses AV1 but the GPU doesn't list
 *  any AV1 encoder. Drives the AV1-incompatibility warning banner. */
export function av1Mismatch(): boolean {
  const current = currentProfile();
  if (!current) return false;
  const profUsesAv1 = current.codec.toLowerCase().includes('av1');
  if (!profUsesAv1) return false;
  // Also respect a manual codec override.
  if (streamSettings.use_overrides && streamSettings.overrides.codec) {
    if (!streamSettings.overrides.codec.toLowerCase().includes('av1')) return false;
  }
  const codecs = (streamSettings.gpu_info?.video_codecs ?? []).map((c) => c.toLowerCase());
  if (codecs.length === 0) return false; // no info → no warning, not a false alarm
  return !codecs.some((c) => c.includes('av1'));
}

/**
 * Idempotently fetch profiles/servers/monitors/audio-apps + GPU info from the
 * sidecar, then **load persisted settings** and finally **apply GPU-detection
 * defaults** to any field the user hadn't already chosen. Persistence wins.
 *
 * Failures are reported via `catalog_error` — they don't throw.
 */
export async function loadCatalogs(): Promise<void> {
  if (loading) return;
  loading = true;
  streamSettings.catalog_error = null;
  try {
    // Pull persisted first so the GPU-default branch below can check whether
    // the user already has a stored selection.
    await loadPersisted();

    const [profiles, monitors, audioApps, gpuInfo] = await Promise.all([
      gsr.listProfiles(),
      gsr.listMonitors(),
      gsr.listApplicationAudio(),
      gsr.gpuInfo(),
    ]);

    if (profiles?.ok) {
      streamSettings.available_profiles = profiles.profiles ?? [];
      // Merge: built-in servers from the sidecar catalog + custom servers from
      // persistence. Custom entries are marked so the picker UI can show a
      // delete button next to them only.
      const builtins = (profiles.servers ?? []) as GsrServer[];
      streamSettings.available_servers = mergeServers(builtins, streamSettings.custom_servers);
    }
    if (monitors?.ok) {
      streamSettings.available_monitors = monitors.monitors ?? [];
    }
    if (audioApps?.ok) {
      streamSettings.available_audio_apps = audioApps.applications ?? [];
    }
    if (gpuInfo?.ok) {
      streamSettings.gpu_info = gpuInfo;
    }

    // The HQ-stream panel is channel-mode only now (push into the current voice
    // channel via the portal, explicit codec/res/bitrate/fps). Force those —
    // overriding anything `loadPersisted()` restored from an older config.
    streamSettings.target = 'channel';
    streamSettings.capture_source = 'portal';
    streamSettings.profile_name = 'Custom';
    streamSettings.use_overrides = true;
    // Default the codec from the GPU (AV1 if it can encode it, else H.264) —
    // only if the user hasn't already picked one.
    if (!streamSettings.overrides.codec) {
      const hasAv1 = (streamSettings.gpu_info?.video_codecs ?? []).some((c) => /av1/i.test(c));
      streamSettings.overrides = { ...streamSettings.overrides, codec: hasAv1 ? 'av1' : 'h264' };
    }
    streamSettings.catalogs_loaded = true;
  } catch (e) {
    streamSettings.catalog_error = e instanceof Error ? e.message : String(e);
  } finally {
    loading = false;
  }
}

function mergeServers(builtins: GsrServer[], customs: CustomServer[]): GsrServer[] {
  // Builtins first, then customs. Names are unique across both lists; if a
  // custom entry collides with a builtin name we drop the builtin (rare; the
  // dialog blocks that on validation, but be safe on rehydrate).
  const customNames = new Set(customs.map((c) => c.name));
  return [...builtins.filter((b) => !customNames.has(b.name)), ...customs];
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

/** Look up the currently selected server in the merged catalog. */
export function currentServer(): GsrServer | CustomServer | undefined {
  return streamSettings.available_servers.find((s) => s.name === streamSettings.server_name);
}

/** True iff the currently selected server is a user-defined custom entry. */
export function isCurrentServerCustom(): boolean {
  const s = currentServer();
  return !!s && (s as Partial<CustomServer>).is_custom === true;
}

// ── Custom-Server mutations ─────────────────────────────────────────────────

/**
 * Add a user-defined server. Returns `null` on success, an error message
 * string on failure (validation issue / name conflict). Persists via the
 * persistence layer (`window.pulse.store.*` under Electron, `localStorage`
 * fallback). The `stream_key` is stored in cleartext — see persistence.ts for
 * the security note.
 */
export function addCustomServer(s: CustomServer): string | null {
  const name = s.name.trim();
  if (!name) return 'Name darf nicht leer sein';
  if (!s.push_host.trim()) return 'Host darf nicht leer sein';
  const conflict = streamSettings.available_servers.find((x) => x.name === name);
  if (conflict) return `Server-Name "${name}" existiert bereits`;
  const entry: CustomServer = { ...s, name, is_custom: true };
  streamSettings.custom_servers = [...streamSettings.custom_servers, entry];
  // Update the merged catalog so the picker picks it up immediately.
  streamSettings.available_servers = [...streamSettings.available_servers, entry];
  persistSettings();
  return null;
}

/** Remove a custom server by name. Built-in entries are silently ignored. */
export function removeCustomServer(name: string): void {
  const before = streamSettings.custom_servers.length;
  streamSettings.custom_servers = streamSettings.custom_servers.filter((s) => s.name !== name);
  if (streamSettings.custom_servers.length === before) return; // nothing to remove
  streamSettings.available_servers = streamSettings.available_servers.filter((s) => s.name !== name);
  // If the deleted server was selected, fall back to the first remaining.
  if (streamSettings.server_name === name) {
    streamSettings.server_name = streamSettings.available_servers[0]?.name ?? '';
  }
  persistSettings();
}

// ── Mapping helpers ─────────────────────────────────────────────────────────

/** Args for the per-channel pathway: the chat-gateway-minted publish token +
 *  the MediaMTX ingest host:port (derived from the `push_url`). */
export interface ChannelStreamArg {
  channelId: string;
  token: string;
  /** Host or `host:port` (no scheme) of the MediaMTX ingest endpoint. */
  mediamtxEndpoint?: string;
  pushProtocol?: string;
}

/**
 * Pull the `host[:port]` (no scheme) out of a `push_url` returned by
 * `chatApi.getStreamToken()` so it can be handed to the sidecar as
 * `channel.mediamtx_endpoint`. The sidecar rebuilds the full push URL itself
 * from `endpoint` + `token` (`ServerProfile.from_channel`); we just give it the
 * host (+ ingest port if the URL carried one). Returns `undefined` on a URL we
 * can't parse — the sidecar then falls back to its default endpoint.
 *
 * Examples:
 *   `rtmp://stream.example.com:1935/channel-7?user=pulse&pass=…` → `stream.example.com:1935`
 *   `srt://1.2.3.4:8890?streamid=publish:channel-7:pulse:…`      → `1.2.3.4:8890`
 */
export function mediamtxEndpointFromPushUrl(pushUrl: string): string | undefined {
  try {
    // The URL API doesn't know `rtmp:`/`srt:`; swap to `http:` just for parsing.
    const u = new URL(pushUrl.replace(/^[a-z]+:\/\//i, 'http://'));
    if (!u.hostname) return undefined;
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return undefined;
  }
}

/**
 * Translate the in-memory `streamSettings` into the body shape that
 * `gsr.start()` / `gsr.buildArgv()` expect. Overrides are only included when
 * `use_overrides` is set (or the user picked the synthetic "Custom" profile).
 *
 * **Channel pathway** (`streamSettings.target === 'channel'` and `channelArg`
 * given): emit `channel: {id, token, mediamtx_endpoint?, push_protocol?}` —
 * the sidecar builds a `ServerProfile.from_channel(...)` from it (MediaMTX path
 * `channel-<id>`, the token used like a stream key). No `server`/`custom_server`.
 *
 * **Custom-server pathway:** when the currently selected server is a user-
 * defined entry, we don't send `server: <name>` (the sidecar's catalog
 * doesn't know about it). Instead we send an inline `custom_server` spec
 * plus the persisted `stream_key`. The sidecar's `_resolve_server()` was
 * extended in T3c to accept that.
 */
export function buildStartArgs(
  streamKey: string = 'PLACEHOLDER',
  channelArg?: ChannelStreamArg,
): GsrStartArgs {
  const apply = streamSettings.use_overrides || isCustomProfile();
  const useChannel = streamSettings.target === 'channel' && channelArg != null;
  const custom =
    !useChannel && isCurrentServerCustom() ? (currentServer() as CustomServer | undefined) : undefined;

  const args: GsrStartArgs = {
    profile: streamSettings.profile_name,
    capture: streamSettings.capture_source,
    audio: {
      mode: streamSettings.audio_mode,
      excluded_apps: streamSettings.excluded_apps.slice(),
    },
  };

  if (useChannel && channelArg) {
    args.channel = {
      id: channelArg.channelId,
      token: channelArg.token,
      ...(channelArg.mediamtxEndpoint ? { mediamtx_endpoint: channelArg.mediamtxEndpoint } : {}),
      ...(channelArg.pushProtocol ? { push_protocol: channelArg.pushProtocol } : {}),
    };
  } else if (custom) {
    args.custom_server = {
      name: custom.name,
      push_protocol: custom.push_protocol,
      push_host: custom.push_host,
      push_port: custom.push_port,
      push_path: custom.push_path,
      needs_auth: custom.needs_auth,
      auth_user: custom.auth_user,
    };
    args.stream_key = custom.stream_key;
  } else {
    args.server = streamSettings.server_name;
    args.stream_key = streamKey;
  }

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
  persistSettings();
}

export function removeExcludedApp(name: string): void {
  streamSettings.excluded_apps = streamSettings.excluded_apps.filter((a) => a !== name);
  persistSettings();
}
