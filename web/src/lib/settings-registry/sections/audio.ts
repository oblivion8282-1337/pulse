/**
 * `audio` section — input/output devices + bitrate + noise-suppression mode.
 * Device-scoped → keep across sign-out.
 */
import type { SectionConfig } from '../types';

export type NoiseSuppressionMode = 'off' | 'rnnoise_gated';

/**
 * Spatial (3D) audio for voice playback. `off` = today's flat mix; `standard`
 * = low-CPU binaural (good for laptops); `high` = full binaural + room
 * reverb; `auto` = pick `high`/`standard` from device class at runtime.
 * Desktop-only — the mobile playback path has no Web Audio graph to hook into.
 */
export type SpatialMode = 'off' | 'standard' | 'high' | 'auto';

export const SPATIAL_MODES: readonly SpatialMode[] = ['off', 'standard', 'high', 'auto'];

export type AudioSettings = {
  inputDeviceId: string;
  inputDeviceLabel: string;
  outputDeviceId: string;
  outputDeviceLabel: string;
  echoCancellation: boolean;
  noiseSuppression: NoiseSuppressionMode;
  noiseGateThresholdDb: number;
  stereo: boolean;
  inputMakeupGain: number;
  limiterEnabled: boolean;
  spatialMode: SpatialMode;
};

export const NOISE_GATE_DB_MIN = -60;
export const NOISE_GATE_DB_MAX = -20;
export const NOISE_GATE_DB_DEFAULT = -45;

export const INPUT_MAKEUP_MIN = 0.1;
// Up to 8× (+18 dB): the send chain's RNNoise stage attenuates noticeably, so
// the makeup mostly just recovers that loss — a higher ceiling gives real net
// gain on top. Clipping past that is on the user (the send-clip lamp warns).
export const INPUT_MAKEUP_MAX = 8;
export const INPUT_MAKEUP_DEFAULT = 1;

export const DEFAULTS_AUDIO: AudioSettings = {
  inputDeviceId: '',
  inputDeviceLabel: '',
  outputDeviceId: '',
  outputDeviceLabel: '',
  echoCancellation: true,
  noiseSuppression: 'rnnoise_gated',
  noiseGateThresholdDb: NOISE_GATE_DB_DEFAULT,
  stereo: false,
  inputMakeupGain: INPUT_MAKEUP_DEFAULT,
  limiterEnabled: true,
  spatialMode: 'off'
};

export function parseSpatialMode(v: unknown): SpatialMode {
  return SPATIAL_MODES.includes(v as SpatialMode) ? (v as SpatialMode) : DEFAULTS_AUDIO.spatialMode;
}

export function clampGateDb(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return NOISE_GATE_DB_DEFAULT;
  return Math.min(NOISE_GATE_DB_MAX, Math.max(NOISE_GATE_DB_MIN, Math.round(v)));
}

export function clampInputMakeup(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return INPUT_MAKEUP_DEFAULT;
  return Math.min(INPUT_MAKEUP_MAX, Math.max(INPUT_MAKEUP_MIN, v as number));
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

export const AUDIO_SECTION: SectionConfig<AudioSettings> = {
  defaults: DEFAULTS_AUDIO,
  parse(raw) {
    const a = (raw && typeof raw === 'object' ? raw : {}) as Partial<AudioSettings>;
    const d = DEFAULTS_AUDIO;
    return {
      inputDeviceId: str(a.inputDeviceId, d.inputDeviceId),
      inputDeviceLabel: str(a.inputDeviceLabel, d.inputDeviceLabel),
      outputDeviceId: str(a.outputDeviceId, d.outputDeviceId),
      outputDeviceLabel: str(a.outputDeviceLabel, d.outputDeviceLabel),
      echoCancellation: bool(a.echoCancellation, d.echoCancellation),
      // Migration: pre-binary configs may carry 'browser'/'rnnoise'/'deepfilternet'
      // (DFN3 was removed 2026-05-16). Any non-'off' legacy value indicates the
      // user wanted *some* filter on — map to the unified gated mode.
      noiseSuppression:
        a.noiseSuppression === 'off'
          ? 'off'
          : typeof a.noiseSuppression === 'string'
            ? 'rnnoise_gated'
            : d.noiseSuppression,
      noiseGateThresholdDb: clampGateDb(a.noiseGateThresholdDb),
      stereo: bool(a.stereo, d.stereo),
      inputMakeupGain: clampInputMakeup(a.inputMakeupGain),
      limiterEnabled: bool(a.limiterEnabled, d.limiterEnabled),
      spatialMode: parseSpatialMode(a.spatialMode)
    };
  }
};
