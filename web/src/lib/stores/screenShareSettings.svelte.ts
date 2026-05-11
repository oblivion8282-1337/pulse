import type { VideoCodec } from 'livekit-client';

export type ScreenShareCodec = Extract<VideoCodec, 'vp8' | 'vp9' | 'h264' | 'av1'>;
export type ScreenShareResolution = 'native' | '1080p' | '720p' | '480p';
export type ScreenShareFps = 15 | 30 | 60;

export type ScreenShareSettings = {
  codec: ScreenShareCodec;
  resolution: ScreenShareResolution;
  fps: ScreenShareFps;
  bitrateMbps: number;
  contentHint: 'motion' | 'detail';
};

const STORAGE_KEY = 'dcc.screenShareSettings';

const DEFAULTS: ScreenShareSettings = {
  codec: 'vp9',
  resolution: '1080p',
  fps: 30,
  bitrateMbps: 4,
  contentHint: 'motion'
};

const VALID_CODECS: ScreenShareCodec[] = ['vp8', 'vp9', 'h264', 'av1'];
const VALID_RESOLUTIONS: ScreenShareResolution[] = ['native', '1080p', '720p', '480p'];
const VALID_FPS: ScreenShareFps[] = [15, 30, 60];

function load(): ScreenShareSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<ScreenShareSettings>;
    return {
      codec: VALID_CODECS.includes(parsed.codec as ScreenShareCodec)
        ? (parsed.codec as ScreenShareCodec)
        : DEFAULTS.codec,
      resolution: VALID_RESOLUTIONS.includes(parsed.resolution as ScreenShareResolution)
        ? (parsed.resolution as ScreenShareResolution)
        : DEFAULTS.resolution,
      fps: VALID_FPS.includes(parsed.fps as ScreenShareFps)
        ? (parsed.fps as ScreenShareFps)
        : DEFAULTS.fps,
      bitrateMbps:
        typeof parsed.bitrateMbps === 'number' &&
        parsed.bitrateMbps >= 1 &&
        parsed.bitrateMbps <= 15
          ? parsed.bitrateMbps
          : DEFAULTS.bitrateMbps,
      contentHint:
        parsed.contentHint === 'detail' || parsed.contentHint === 'motion'
          ? parsed.contentHint
          : DEFAULTS.contentHint
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(s: ScreenShareSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* ignore quota errors */
  }
}

class ScreenShareSettingsStore {
  codec = $state<ScreenShareCodec>(DEFAULTS.codec);
  resolution = $state<ScreenShareResolution>(DEFAULTS.resolution);
  fps = $state<ScreenShareFps>(DEFAULTS.fps);
  bitrateMbps = $state<number>(DEFAULTS.bitrateMbps);
  contentHint = $state<'motion' | 'detail'>(DEFAULTS.contentHint);

  constructor() {
    const s = load();
    this.codec = s.codec;
    this.resolution = s.resolution;
    this.fps = s.fps;
    this.bitrateMbps = s.bitrateMbps;
    this.contentHint = s.contentHint;
  }

  #persist(): void {
    save({
      codec: this.codec,
      resolution: this.resolution,
      fps: this.fps,
      bitrateMbps: this.bitrateMbps,
      contentHint: this.contentHint
    });
  }

  setCodec(v: ScreenShareCodec): void {
    this.codec = v;
    this.#persist();
  }

  setResolution(v: ScreenShareResolution): void {
    this.resolution = v;
    this.#persist();
  }

  setFps(v: ScreenShareFps): void {
    this.fps = v;
    this.#persist();
  }

  setBitrateMbps(v: number): void {
    this.bitrateMbps = Math.min(15, Math.max(1, v));
    this.#persist();
  }

  setContentHint(v: 'motion' | 'detail'): void {
    this.contentHint = v;
    this.#persist();
  }
}

export const screenShareSettings = new ScreenShareSettingsStore();
