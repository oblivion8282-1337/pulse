/**
 * `audio` section — input/output devices + bitrate + noise-suppression mode.
 * Device-scoped → keep across sign-out.
 */
import type { SectionConfig } from '../types';

export type NoiseSuppressionMode = 'off' | 'rnnoise_gated';

export type AudioSettings = {
  inputDeviceId: string;
  inputDeviceLabel: string;
  outputDeviceId: string;
  outputDeviceLabel: string;
  echoCancellation: boolean;
  autoGainControl: boolean;
  noiseSuppression: NoiseSuppressionMode;
  noiseGateThresholdDb: number;
  voiceBitrateKbps: number;
  stereo: boolean;
  inputMakeupGain: number;
  limiterEnabled: boolean;
};

export const VOICE_BITRATE_MIN = 16;
export const VOICE_BITRATE_MAX = 256;
export const VOICE_BITRATE_STEREO_MIN = 32;

export const NOISE_GATE_DB_MIN = -60;
export const NOISE_GATE_DB_MAX = -20;
export const NOISE_GATE_DB_DEFAULT = -45;

export const INPUT_MAKEUP_MIN = 0.5;
export const INPUT_MAKEUP_MAX = 4;
export const INPUT_MAKEUP_DEFAULT = 1;

export const DEFAULTS_AUDIO: AudioSettings = {
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
  inputMakeupGain: INPUT_MAKEUP_DEFAULT,
  limiterEnabled: false
};

export function clampBitrate(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULTS_AUDIO.voiceBitrateKbps;
  return Math.min(VOICE_BITRATE_MAX, Math.max(VOICE_BITRATE_MIN, Math.round(v)));
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
      autoGainControl: bool(a.autoGainControl, d.autoGainControl),
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
      voiceBitrateKbps: clampBitrate(a.voiceBitrateKbps),
      stereo: bool(a.stereo, d.stereo),
      inputMakeupGain: clampInputMakeup(a.inputMakeupGain),
      limiterEnabled: bool(a.limiterEnabled, d.limiterEnabled)
    };
  }
};
