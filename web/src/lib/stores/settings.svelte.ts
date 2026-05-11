import type { VideoCodec } from 'livekit-client';
import { setMode } from 'mode-watcher';

// --- screen-share types (kept identical to the previous screenShareSettings) ---

export type ScreenShareCodec = Extract<VideoCodec, 'vp8' | 'vp9' | 'h264' | 'av1'>;
export type ScreenShareResolution = 'native' | '1080p' | '720p' | '480p';
export type ScreenShareFps = 15 | 30 | 60;

export type NoiseSuppressionMode = 'off' | 'browser' | 'rnnoise' | 'deepfilternet';

export type ThemePreference = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'dcc.settings';
const LEGACY_SCREENSHARE_KEY = 'dcc.screenShareSettings';

const VOICE_BITRATE_MIN = 8;
const VOICE_BITRATE_MAX = 512;

const VALID_CODECS: ScreenShareCodec[] = ['vp8', 'vp9', 'h264', 'av1'];
const VALID_RESOLUTIONS: ScreenShareResolution[] = ['native', '1080p', '720p', '480p'];
const VALID_FPS: ScreenShareFps[] = [15, 30, 60];
const VALID_NS: NoiseSuppressionMode[] = ['off', 'browser', 'rnnoise', 'deepfilternet'];
const VALID_THEMES: ThemePreference[] = ['light', 'dark', 'system'];

type AudioSettings = {
  inputDeviceId: string;
  inputDeviceLabel: string;
  outputDeviceId: string;
  outputDeviceLabel: string;
  echoCancellation: boolean;
  autoGainControl: boolean;
  noiseSuppression: NoiseSuppressionMode;
  voiceBitrateKbps: number;
  stereo: boolean;
};

type VoiceSettings = {
  pttMode: boolean;
  pttKey: string;
};

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

type PersistedSettings = {
  audio: AudioSettings;
  voice: VoiceSettings;
  screenShare: ScreenShareSettings;
  appearance: AppearanceSettings;
};

const DEFAULTS: PersistedSettings = {
  audio: {
    inputDeviceId: '',
    inputDeviceLabel: '',
    outputDeviceId: '',
    outputDeviceLabel: '',
    echoCancellation: true,
    autoGainControl: true,
    noiseSuppression: 'deepfilternet',
    voiceBitrateKbps: 48,
    stereo: false
  },
  voice: {
    pttMode: false,
    pttKey: 'v'
  },
  screenShare: {
    codec: 'vp9',
    resolution: '1080p',
    fps: 30,
    bitrateMbps: 4,
    contentHint: 'motion'
  },
  appearance: {
    theme: 'system'
  }
};

function clampBitrate(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULTS.audio.voiceBitrateKbps;
  return Math.min(VOICE_BITRATE_MAX, Math.max(VOICE_BITRATE_MIN, Math.round(v)));
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
      typeof p.bitrateMbps === 'number' && p.bitrateMbps >= 1 && p.bitrateMbps <= 15 ? p.bitrateMbps : d.bitrateMbps,
    contentHint: p.contentHint === 'detail' || p.contentHint === 'motion' ? p.contentHint : d.contentHint
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
        appearance: { ...DEFAULTS.appearance }
      };
    }
    const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
    const a = (parsed.audio ?? {}) as Partial<AudioSettings>;
    const v = (parsed.voice ?? {}) as Partial<VoiceSettings>;
    const ap = (parsed.appearance ?? {}) as Partial<AppearanceSettings>;
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
        noiseSuppression: VALID_NS.includes(a.noiseSuppression as NoiseSuppressionMode)
          ? (a.noiseSuppression as NoiseSuppressionMode)
          : da.noiseSuppression,
        voiceBitrateKbps: clampBitrate(a.voiceBitrateKbps),
        stereo: bool(a.stereo, da.stereo)
      },
      voice: {
        pttMode: bool(v.pttMode, dv.pttMode),
        pttKey: typeof v.pttKey === 'string' && v.pttKey.length > 0 ? v.pttKey.toLowerCase() : dv.pttKey
      },
      screenShare: parseScreenShare(parsed.screenShare),
      appearance: { theme: parseTheme(ap.theme) }
    };
  } catch {
    return {
      audio: { ...DEFAULTS.audio },
      voice: { ...DEFAULTS.voice },
      screenShare: { ...DEFAULTS.screenShare },
      appearance: { ...DEFAULTS.appearance }
    };
  }
}

class SettingsStore {
  audio = $state<AudioSettings>({ ...DEFAULTS.audio });
  voice = $state<VoiceSettings>({ ...DEFAULTS.voice });
  screenShare = $state<ScreenShareSettings>({ ...DEFAULTS.screenShare });
  appearance = $state<AppearanceSettings>({ ...DEFAULTS.appearance });

  /** True if a legacy `dcc.screenShareSettings` key was migrated and can be cleared. */
  #legacyMigrated = false;

  constructor() {
    const s = load();
    this.audio = s.audio;
    this.voice = s.voice;
    this.screenShare = s.screenShare;
    this.appearance = s.appearance;
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
          appearance: this.appearance
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

  setVoiceBitrateKbps(v: number): void {
    this.audio.voiceBitrateKbps = clampBitrate(v);
    this.#persist();
  }

  setStereo(v: boolean): void {
    this.audio.stereo = v;
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
    this.screenShare.bitrateMbps = Math.min(15, Math.max(1, v));
    this.#persist();
  }

  setScreenShareContentHint(v: 'motion' | 'detail'): void {
    this.screenShare.contentHint = v;
    this.#persist();
  }
}

export const settings = new SettingsStore();
export { VOICE_BITRATE_MIN, VOICE_BITRATE_MAX };
