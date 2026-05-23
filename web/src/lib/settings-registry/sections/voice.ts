/**
 * `voice` section — push-to-talk + per-remote-user output volumes.
 * Per-user-volumes are arguably user-scoped, but the same device is usually
 * tied to the same human and the keys are server-side IDs that can't leak
 * across accounts in a meaningful way → keep across sign-out for parity
 * with audio/screenShare. Plugins overriding this can pass `'reset'`.
 */
import type { SectionConfig } from '../types';

export type VoiceSettings = {
  pttMode: boolean;
  pttKey: string;
  userVolumes: Record<string, number>;
};

export const USER_VOLUME_MIN = 0;
export const USER_VOLUME_MAX = 4;
/** Hard cap to keep the persisted record bounded — entries beyond this are
 *  FIFO-dropped at write time. */
const MAX_USER_VOLUMES = 256;

export const DEFAULTS_VOICE: VoiceSettings = {
  pttMode: false,
  pttKey: 'v',
  userVolumes: {}
};

export function clampUserVolume(v: number): number {
  return Math.min(USER_VOLUME_MAX, Math.max(USER_VOLUME_MIN, v));
}

export function capUserVolumes(map: Record<string, number>): Record<string, number> {
  const keys = Object.keys(map);
  if (keys.length <= MAX_USER_VOLUMES) return map;
  const drop = keys.length - MAX_USER_VOLUMES;
  for (let i = 0; i < drop; i++) delete map[keys[i]];
  return map;
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

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

export const VOICE_SECTION: SectionConfig<VoiceSettings> = {
  defaults: DEFAULTS_VOICE,
  parse(raw) {
    const v = (raw && typeof raw === 'object' ? raw : {}) as Partial<VoiceSettings>;
    const d = DEFAULTS_VOICE;
    return {
      pttMode: bool(v.pttMode, d.pttMode),
      pttKey:
        typeof v.pttKey === 'string' && v.pttKey.length > 0 ? v.pttKey.toLowerCase() : d.pttKey,
      userVolumes: parseUserVolumes(v.userVolumes)
    };
  }
};
