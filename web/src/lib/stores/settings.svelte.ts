import type { VideoCodec } from 'livekit-client';
import { setMode } from 'mode-watcher';
import {
  DEFAULT_SOUNDS,
  clampSoundVolume,
  parseSounds,
  type SoundCategoryKey,
  type SoundsSettings
} from '$lib/sounds/persistence';

// --- screen-share types (kept identical to the previous screenShareSettings) ---

export type ScreenShareCodec = Extract<VideoCodec, 'vp8' | 'vp9' | 'h264' | 'av1'>;
export type ScreenShareResolution = 'native' | '1080p' | '720p' | '480p';
export type ScreenShareFps = 15 | 30 | 60;

export type NoiseSuppressionMode = 'off' | 'rnnoise_gated';

export type ThemePreference = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'dcc.settings';
const LEGACY_SCREENSHARE_KEY = 'dcc.screenShareSettings';

const VOICE_BITRATE_MIN = 16;
const VOICE_BITRATE_MAX = 256;
const VOICE_BITRATE_STEREO_MIN = 32;

// Hard noise-gate (open-threshold in dB) used by the 'rnnoise_gated' mode.
// -60 = very sensitive (lets near-whispered speech through, gates almost nothing),
// -20 = only loud speech opens the gate. -45 is a reasonable default for a quiet
// home office; users in noisy rooms will want it closer to -30.
const NOISE_GATE_DB_MIN = -60;
const NOISE_GATE_DB_MAX = -20;
const NOISE_GATE_DB_DEFAULT = -45;

// Cap for the LiveKit screen-share bitrate. Fan-out via SFU means the server
// pays N×bitrate egress per channel — keep this low even when raising the HQ
// cap, since voice channels regularly have multiple listeners.
const SCREEN_SHARE_BITRATE_MIN = 1;
const SCREEN_SHARE_BITRATE_MAX = 10;

const VALID_CODECS: ScreenShareCodec[] = ['vp8', 'vp9', 'h264', 'av1'];
const VALID_RESOLUTIONS: ScreenShareResolution[] = ['native', '1080p', '720p', '480p'];
const VALID_FPS: ScreenShareFps[] = [15, 30, 60];
const VALID_NS: NoiseSuppressionMode[] = ['off', 'rnnoise_gated'];
const VALID_THEMES: ThemePreference[] = ['light', 'dark', 'system'];

type AudioSettings = {
  inputDeviceId: string;
  inputDeviceLabel: string;
  outputDeviceId: string;
  outputDeviceLabel: string;
  echoCancellation: boolean;
  autoGainControl: boolean;
  noiseSuppression: NoiseSuppressionMode;
  /** Open-threshold (dB) for the 'rnnoise_gated' mode. Below this the post-
   *  RNNoise audio is muted entirely. Ignored when noise-suppression is 'off'. */
  noiseGateThresholdDb: number;
  voiceBitrateKbps: number;
  stereo: boolean;
  /** Linear gain applied to your own mic after the noise filter, before the
   *  Opus encoder. 1.0 = pass-through. Other listeners hear this. */
  inputMakeupGain: number;
};

type VoiceSettings = {
  pttMode: boolean;
  pttKey: string;
  /** Per-remote-user output gain. Key = Snowflake user ID (string). Value =
   *  linear gain factor 0..4 (0 = mute, 1.0 = unchanged, 4.0 = +12 dB before
   *  the compressor catches it). Default (1.0) entries are not persisted. */
  userVolumes: Record<string, number>;
};

const USER_VOLUME_MIN = 0;
const USER_VOLUME_MAX = 4;

// Sender-side linear gain on the local mic AFTER the noise filter, BEFORE the
// encoder. 0.5 = -6 dB (hot mic → quieter), 1.0 = pass-through, 4.0 = +12 dB.
const INPUT_MAKEUP_MIN = 0.5;
const INPUT_MAKEUP_MAX = 4;
const INPUT_MAKEUP_DEFAULT = 1;
/** Hard cap to keep the persisted record bounded — entries beyond this are
 *  FIFO-dropped at write time. Tuned for "you'll never adjust this many
 *  unique users on purpose" rather than a precise LRU. */
const MAX_USER_VOLUMES = 256;

type AppearanceSettings = {
  theme: ThemePreference;
};

type ScreenShareSettings = {
  codec: ScreenShareCodec;
  resolution: ScreenShareResolution;
  fps: ScreenShareFps;
  bitrateMbps: number;
  contentHint: 'motion' | 'detail';
};

type StreamChatSettings = {
  /** Seitliches Stream-Chat-Panel offen (User-Toggle, default desktop).
   *  Fullscreen-Overlay über dem Video ist nicht persistiert — pro Player
   *  per Toggle-Button, defaultet immer auf aus. */
  panelOpen: boolean;
};

/** User-facing notification preferences. `browserPushEnabled` is a *user
 *  intent* flag — the actual subscription state lives in the PushManager.
 *  Toggling it kicks off `requestPushPermission()` / `unsubscribeUser()`;
 *  on permission-denied the flag flips back to false so the UI stays honest.
 *  Sub-toggles gate the local in-page fallback path (Service-Worker pushes
 *  are server-driven and not filtered client-side — the server respects
 *  per-user prefs sent via the subscribe call once that endpoint exists).
 *  Sound playback used to live here as `soundEnabled`; that flag was split
 *  into the dedicated `sounds` block — migration in `parseSounds()`. */
type NotificationSettings = {
  browserPushEnabled: boolean;
  onMention: boolean;
  onDM: boolean;
};

type PersistedSettings = {
  audio: AudioSettings;
  voice: VoiceSettings;
  screenShare: ScreenShareSettings;
  streamChat: StreamChatSettings;
  appearance: AppearanceSettings;
  notifications: NotificationSettings;
  sounds: SoundsSettings;
};

const DEFAULTS: PersistedSettings = {
  audio: {
    inputDeviceId: '',
    inputDeviceLabel: '',
    outputDeviceId: '',
    outputDeviceLabel: '',
    echoCancellation: true,
    autoGainControl: false,
    noiseSuppression: 'rnnoise_gated',
    noiseGateThresholdDb: NOISE_GATE_DB_DEFAULT,
    voiceBitrateKbps: 128,
    stereo: false,
    inputMakeupGain: INPUT_MAKEUP_DEFAULT
  },
  voice: {
    pttMode: false,
    pttKey: 'v',
    userVolumes: {}
  },
  screenShare: {
    codec: 'vp9',
    resolution: '1080p',
    fps: 30,
    bitrateMbps: 4,
    contentHint: 'motion'
  },
  streamChat: {
    panelOpen: true
  },
  appearance: {
    theme: 'system'
  },
  notifications: {
    // Explicit opt-in: requesting permission requires a user gesture and we
    // don't want to fire it ambiently. The other sub-toggles default ON so
    // once the user opts in, mentions + DMs both alert by default.
    browserPushEnabled: false,
    onMention: true,
    onDM: true
  },
  sounds: { ...DEFAULT_SOUNDS }
};

function clampBitrate(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULTS.audio.voiceBitrateKbps;
  return Math.min(VOICE_BITRATE_MAX, Math.max(VOICE_BITRATE_MIN, Math.round(v)));
}

function clampGateDb(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return NOISE_GATE_DB_DEFAULT;
  return Math.min(NOISE_GATE_DB_MAX, Math.max(NOISE_GATE_DB_MIN, Math.round(v)));
}

function clampInputMakeup(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return INPUT_MAKEUP_DEFAULT;
  return Math.min(INPUT_MAKEUP_MAX, Math.max(INPUT_MAKEUP_MIN, v));
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function parseTheme(v: unknown): ThemePreference {
  return VALID_THEMES.includes(v as ThemePreference) ? (v as ThemePreference) : DEFAULTS.appearance.theme;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function clampUserVolume(v: number): number {
  return Math.min(USER_VOLUME_MAX, Math.max(USER_VOLUME_MIN, v));
}

function parseUserVolumes(raw: unknown): Record<string, number> {
  if (raw === null || typeof raw !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k !== 'string' || k.length === 0) continue;
    if (typeof val !== 'number' || !Number.isFinite(val)) continue;
    const clamped = clampUserVolume(val);
    if (clamped !== 1) out[k] = clamped;
  }
  return capUserVolumes(out);
}

function capUserVolumes(map: Record<string, number>): Record<string, number> {
  const keys = Object.keys(map);
  if (keys.length <= MAX_USER_VOLUMES) return map;
  const drop = keys.length - MAX_USER_VOLUMES;
  for (let i = 0; i < drop; i++) delete map[keys[i]];
  return map;
}

function readLegacyScreenShare(): Partial<ScreenShareSettings> | null {
  try {
    const raw = localStorage.getItem(LEGACY_SCREENSHARE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Partial<ScreenShareSettings>;
  } catch {
    return null;
  }
}

function parseScreenShare(raw: Partial<ScreenShareSettings> | undefined | null): ScreenShareSettings {
  const d = DEFAULTS.screenShare;
  const p = raw ?? {};
  return {
    codec: VALID_CODECS.includes(p.codec as ScreenShareCodec) ? (p.codec as ScreenShareCodec) : d.codec,
    resolution: VALID_RESOLUTIONS.includes(p.resolution as ScreenShareResolution)
      ? (p.resolution as ScreenShareResolution)
      : d.resolution,
    fps: VALID_FPS.includes(p.fps as ScreenShareFps) ? (p.fps as ScreenShareFps) : d.fps,
    bitrateMbps:
      typeof p.bitrateMbps === 'number' &&
      p.bitrateMbps >= SCREEN_SHARE_BITRATE_MIN &&
      p.bitrateMbps <= SCREEN_SHARE_BITRATE_MAX
        ? p.bitrateMbps
        : d.bitrateMbps,
    contentHint: p.contentHint === 'detail' || p.contentHint === 'motion' ? p.contentHint : d.contentHint
  };
}

function parseStreamChat(raw: Partial<StreamChatSettings> | undefined | null): StreamChatSettings {
  const d = DEFAULTS.streamChat;
  const p = raw ?? {};
  return { panelOpen: bool(p.panelOpen, d.panelOpen) };
}

function parseNotifications(
  raw: Partial<NotificationSettings> | undefined | null
): NotificationSettings {
  const d = DEFAULTS.notifications;
  const p = raw ?? {};
  return {
    browserPushEnabled: bool(p.browserPushEnabled, d.browserPushEnabled),
    onMention: bool(p.onMention, d.onMention),
    onDM: bool(p.onDM, d.onDM)
  };
}

function load(): PersistedSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      // Migration: pull the screen-share block out of the legacy key if present.
      const legacy = readLegacyScreenShare();
      return {
        audio: { ...DEFAULTS.audio },
        voice: { ...DEFAULTS.voice },
        screenShare: parseScreenShare(legacy),
        streamChat: { ...DEFAULTS.streamChat },
        appearance: { ...DEFAULTS.appearance },
        notifications: { ...DEFAULTS.notifications },
        sounds: parseSounds(null, undefined)
      };
    }
    const parsed = JSON.parse(raw) as Partial<PersistedSettings> & {
      notifications?: { soundEnabled?: boolean };
    };
    const a = (parsed.audio ?? {}) as Partial<AudioSettings>;
    const v = (parsed.voice ?? {}) as Partial<VoiceSettings>;
    const ap = (parsed.appearance ?? {}) as Partial<AppearanceSettings>;
    const legacySoundEnabled = parsed.notifications?.soundEnabled;
    const da = DEFAULTS.audio;
    const dv = DEFAULTS.voice;
    return {
      audio: {
        inputDeviceId: str(a.inputDeviceId, da.inputDeviceId),
        inputDeviceLabel: str(a.inputDeviceLabel, da.inputDeviceLabel),
        outputDeviceId: str(a.outputDeviceId, da.outputDeviceId),
        outputDeviceLabel: str(a.outputDeviceLabel, da.outputDeviceLabel),
        echoCancellation: bool(a.echoCancellation, da.echoCancellation),
        autoGainControl: bool(a.autoGainControl, da.autoGainControl),
        // Migration: pre-binary configs may carry 'browser'/'rnnoise'/'deepfilternet'
        // (DFN3 was removed 2026-05-16). Any non-'off' legacy value indicates the
        // user wanted *some* filter on — map to the unified gated mode. Unknown
        // strings fall back to default.
        noiseSuppression:
          a.noiseSuppression === 'off'
            ? 'off'
            : typeof a.noiseSuppression === 'string'
              ? 'rnnoise_gated'
              : da.noiseSuppression,
        noiseGateThresholdDb: clampGateDb(a.noiseGateThresholdDb),
        voiceBitrateKbps: clampBitrate(a.voiceBitrateKbps),
        stereo: bool(a.stereo, da.stereo),
        inputMakeupGain: clampInputMakeup(a.inputMakeupGain)
      },
      voice: {
        pttMode: bool(v.pttMode, dv.pttMode),
        pttKey: typeof v.pttKey === 'string' && v.pttKey.length > 0 ? v.pttKey.toLowerCase() : dv.pttKey,
        userVolumes: parseUserVolumes(v.userVolumes)
      },
      screenShare: parseScreenShare(parsed.screenShare),
      streamChat: parseStreamChat(parsed.streamChat),
      appearance: { theme: parseTheme(ap.theme) },
      notifications: parseNotifications(parsed.notifications),
      sounds: parseSounds(parsed.sounds, legacySoundEnabled)
    };
  } catch {
    return {
      audio: { ...DEFAULTS.audio },
      voice: { ...DEFAULTS.voice },
      screenShare: { ...DEFAULTS.screenShare },
      streamChat: { ...DEFAULTS.streamChat },
      appearance: { ...DEFAULTS.appearance },
      notifications: { ...DEFAULTS.notifications },
      sounds: parseSounds(null, undefined)
    };
  }
}

class SettingsStore {
  audio = $state<AudioSettings>({ ...DEFAULTS.audio });
  voice = $state<VoiceSettings>({ ...DEFAULTS.voice });
  screenShare = $state<ScreenShareSettings>({ ...DEFAULTS.screenShare });
  streamChat = $state<StreamChatSettings>({ ...DEFAULTS.streamChat });
  appearance = $state<AppearanceSettings>({ ...DEFAULTS.appearance });
  notifications = $state<NotificationSettings>({ ...DEFAULTS.notifications });
  sounds = $state<SoundsSettings>({ ...DEFAULT_SOUNDS });

  /** True if a legacy `dcc.screenShareSettings` key was migrated and can be cleared. */
  #legacyMigrated = false;

  constructor() {
    const s = load();
    this.audio = s.audio;
    this.voice = s.voice;
    this.screenShare = s.screenShare;
    this.streamChat = s.streamChat;
    this.appearance = s.appearance;
    this.notifications = s.notifications;
    this.sounds = s.sounds;
    if (typeof localStorage !== 'undefined') {
      this.#legacyMigrated =
        localStorage.getItem(STORAGE_KEY) === null && localStorage.getItem(LEGACY_SCREENSHARE_KEY) !== null;
    }
  }

  /** Pushes the persisted theme preference into mode-watcher (sets the `.dark`
      class on <html>; `system` follows + tracks `prefers-color-scheme`). Call
      once early on app start. */
  applyTheme(): void {
    setMode(this.appearance.theme);
  }

  #persist(): void {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          audio: this.audio,
          voice: this.voice,
          screenShare: this.screenShare,
          streamChat: this.streamChat,
          appearance: this.appearance,
          notifications: this.notifications,
          sounds: this.sounds
        })
      );
      if (this.#legacyMigrated) {
        localStorage.removeItem(LEGACY_SCREENSHARE_KEY);
        this.#legacyMigrated = false;
      }
    } catch {
      /* ignore quota errors */
    }
  }

  // --- appearance setters ---

  setTheme(v: ThemePreference): void {
    this.appearance.theme = v;
    setMode(v);
    this.#persist();
  }

  // --- audio setters ---

  setInputDevice(id: string, label: string): void {
    this.audio.inputDeviceId = id;
    this.audio.inputDeviceLabel = label;
    this.#persist();
  }

  setOutputDevice(id: string, label: string): void {
    this.audio.outputDeviceId = id;
    this.audio.outputDeviceLabel = label;
    this.#persist();
  }

  setEchoCancellation(v: boolean): void {
    this.audio.echoCancellation = v;
    this.#persist();
  }

  setAutoGainControl(v: boolean): void {
    this.audio.autoGainControl = v;
    this.#persist();
  }

  setNoiseSuppression(v: NoiseSuppressionMode): void {
    this.audio.noiseSuppression = v;
    this.#persist();
  }

  setNoiseGateThresholdDb(v: number): void {
    this.audio.noiseGateThresholdDb = clampGateDb(v);
    this.#persist();
  }

  setVoiceBitrateKbps(v: number): void {
    this.audio.voiceBitrateKbps = clampBitrate(v);
    this.#persist();
  }

  setStereo(v: boolean): void {
    this.audio.stereo = v;
    this.#persist();
  }

  setInputMakeupGain(v: number): void {
    this.audio.inputMakeupGain = clampInputMakeup(v);
    this.#persist();
  }

  // --- voice / PTT setters ---

  setPttMode(v: boolean): void {
    this.voice.pttMode = v;
    this.#persist();
  }

  setPttKey(v: string): void {
    const key = v.trim().toLowerCase();
    if (key.length === 0) return;
    this.voice.pttKey = key;
    this.#persist();
  }

  /** Set per-user output gain (0..4). 1.0 is removed from storage (default). */
  setUserVolume(userId: string, v: number): void {
    if (typeof userId !== 'string' || userId.length === 0) return;
    const clamped = clampUserVolume(v);
    // Reassign the whole object so Svelte runes pick up the change. Without
    // this, mutations on a $state-tracked Record aren't reactive.
    const next = { ...this.voice.userVolumes };
    if (clamped === 1) delete next[userId];
    else {
      // Re-insert so the most-recently-touched key is at the end — gives FIFO
      // eviction a rough recency bias.
      delete next[userId];
      next[userId] = clamped;
    }
    this.voice.userVolumes = capUserVolumes(next);
    this.#persist();
  }

  getUserVolume(userId: string): number {
    return this.voice.userVolumes[userId] ?? 1;
  }

  // --- screen-share setters ---

  setScreenShareCodec(v: ScreenShareCodec): void {
    this.screenShare.codec = v;
    this.#persist();
  }

  setScreenShareResolution(v: ScreenShareResolution): void {
    this.screenShare.resolution = v;
    this.#persist();
  }

  setScreenShareFps(v: ScreenShareFps): void {
    this.screenShare.fps = v;
    this.#persist();
  }

  setScreenShareBitrateMbps(v: number): void {
    this.screenShare.bitrateMbps = Math.min(
      SCREEN_SHARE_BITRATE_MAX,
      Math.max(SCREEN_SHARE_BITRATE_MIN, v),
    );
    this.#persist();
  }

  setScreenShareContentHint(v: 'motion' | 'detail'): void {
    this.screenShare.contentHint = v;
    this.#persist();
  }

  // --- stream-chat setters ---

  setStreamChatPanelOpen(v: boolean): void {
    this.streamChat.panelOpen = v;
    this.#persist();
  }

  // --- notification setters ---

  /** Reflect the result of the permission round-trip. UI calls this *after*
   *  `requestPushPermission()` resolves (or on a denied/dismissed answer)
   *  so the toggle ends up matching reality. */
  setBrowserPushEnabled(v: boolean): void {
    this.notifications.browserPushEnabled = v;
    this.#persist();
  }

  setNotifyOnMention(v: boolean): void {
    this.notifications.onMention = v;
    this.#persist();
  }

  setNotifyOnDM(v: boolean): void {
    this.notifications.onDM = v;
    this.#persist();
  }

  // --- sounds setters ---

  setSoundsMasterEnabled(v: boolean): void {
    this.sounds.masterEnabled = v;
    this.#persist();
  }

  setSoundsMasterVolume(v: number): void {
    this.sounds.masterVolume = clampSoundVolume(v);
    this.#persist();
  }

  setSoundCategoryEnabled(cat: SoundCategoryKey, v: boolean): void {
    this.sounds[cat].enabled = v;
    this.#persist();
  }

  setSoundCategoryVolume(cat: SoundCategoryKey, v: number): void {
    this.sounds[cat].volume = clampSoundVolume(v);
    this.#persist();
  }

  /** Reset state that's user-scoped despite living in device-level localStorage.
   *  Currently: `notifications.browserPushEnabled` — the toggle reflects a
   *  Push-Manager subscription bound to a specific user_id, so on sign-out the
   *  next user shouldn't see "on" inherited from the previous account. Other
   *  settings (audio, video, theme) stay because they describe the device. */
  resetUserScoped(): void {
    this.notifications.browserPushEnabled = false;
    this.#persist();
  }
}

export const settings = new SettingsStore();
export {
  VOICE_BITRATE_MIN,
  VOICE_BITRATE_MAX,
  VOICE_BITRATE_STEREO_MIN,
  NOISE_GATE_DB_MIN,
  NOISE_GATE_DB_MAX,
  NOISE_GATE_DB_DEFAULT,
  SCREEN_SHARE_BITRATE_MIN,
  SCREEN_SHARE_BITRATE_MAX,
  USER_VOLUME_MIN,
  USER_VOLUME_MAX,
  INPUT_MAKEUP_MIN,
  INPUT_MAKEUP_MAX,
  INPUT_MAKEUP_DEFAULT,
};
