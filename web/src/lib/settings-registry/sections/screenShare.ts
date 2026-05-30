/**
 * `screenShare` section — codec/resolution/fps/bitrate for the LiveKit
 * browser-side screen-share path (NOT the GSR-HQ path; that lives in
 * `lib/stream/persistence.ts` and is Electron-only).
 *
 * Legacy migration: this used to live in the separate `dcc.screenShareSettings`
 * localStorage key; the registry's `bindLegacyScreenShare` consumes that and
 * passes it through `parse()` on first registration (see `stores/settings.svelte.ts`).
 */
import type { SectionConfig } from '../types';
import type { VideoCodec } from 'livekit-client';

// VP8/VP9 sind 2026-05-19 raus: H.264 hat überall HW-Encoder (NVENC/QSV/
// VideoToolbox), AV1 deckt das moderne High-Quality-Segment ab.
export type ScreenShareCodec = Extract<VideoCodec, 'h264' | 'av1'>;
export type ScreenShareResolution = 'native' | '1080p' | '720p' | '480p';

export type ScreenShareSettings = {
  codec: ScreenShareCodec;
  resolution: ScreenShareResolution;
  fps: number;
  bitrateMbps: number;
  contentHint: 'motion' | 'detail';
};

export const SCREEN_SHARE_BITRATE_MIN = 1;
export const SCREEN_SHARE_BITRATE_MAX = 10;
export const SCREEN_SHARE_FPS_MIN = 1;
export const SCREEN_SHARE_FPS_MAX = 240;
const SCREEN_SHARE_FPS_DEFAULT = 30;

const VALID_CODECS: ScreenShareCodec[] = ['h264', 'av1'];
const VALID_RESOLUTIONS: ScreenShareResolution[] = ['native', '1080p', '720p', '480p'];

export const DEFAULTS_SCREEN_SHARE: ScreenShareSettings = {
  codec: 'h264',
  resolution: '1080p',
  fps: SCREEN_SHARE_FPS_DEFAULT,
  bitrateMbps: 4,
  contentHint: 'motion'
};

export function clampScreenShareFps(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return SCREEN_SHARE_FPS_DEFAULT;
  return Math.min(SCREEN_SHARE_FPS_MAX, Math.max(SCREEN_SHARE_FPS_MIN, Math.round(v)));
}

// Resolution ordering for the admin ceiling (descending size, 'native' =
// uncapped). Backs both the settings UI (filter the option list) and the
// publish path (clamp a chosen value down to the admin-set ns_resolution_max).
export const NS_RESOLUTION_ORDER: ScreenShareResolution[] = ['native', '1080p', '720p', '480p'];

/** Resolutions allowed under a ceiling (max first → smallest). */
export function allowedNsResolutions(maxRes: string): ScreenShareResolution[] {
  const i = NS_RESOLUTION_ORDER.indexOf(maxRes as ScreenShareResolution);
  if (i < 0) return NS_RESOLUTION_ORDER.slice();
  return NS_RESOLUTION_ORDER.filter((_, idx) => idx >= i);
}

/** Clamp a chosen resolution down to the ceiling (bigger choices → the max). */
export function clampNsResolution(res: string, maxRes: string): ScreenShareResolution {
  const mi = NS_RESOLUTION_ORDER.indexOf(maxRes as ScreenShareResolution);
  const ri = NS_RESOLUTION_ORDER.indexOf(res as ScreenShareResolution);
  if (mi < 0 || ri < 0) return res as ScreenShareResolution;
  return ri >= mi ? (res as ScreenShareResolution) : (maxRes as ScreenShareResolution);
}

export function parseScreenShare(raw: unknown): ScreenShareSettings {
  const d = DEFAULTS_SCREEN_SHARE;
  const p = (raw && typeof raw === 'object' ? raw : {}) as Partial<ScreenShareSettings>;
  // Migration: gespeicherte 'vp8'/'vp9'-Codec-Settings (Pre-2026-05-19) auf
  // 'h264' falten — sanft mappen statt zu errorn.
  const rawCodec = p.codec as unknown as string | undefined;
  const codec: ScreenShareCodec = VALID_CODECS.includes(rawCodec as ScreenShareCodec)
    ? (rawCodec as ScreenShareCodec)
    : rawCodec === 'vp8' || rawCodec === 'vp9'
      ? 'h264'
      : d.codec;
  return {
    codec,
    resolution: VALID_RESOLUTIONS.includes(p.resolution as ScreenShareResolution)
      ? (p.resolution as ScreenShareResolution)
      : d.resolution,
    fps: clampScreenShareFps(p.fps),
    bitrateMbps:
      typeof p.bitrateMbps === 'number' &&
      p.bitrateMbps >= SCREEN_SHARE_BITRATE_MIN &&
      p.bitrateMbps <= SCREEN_SHARE_BITRATE_MAX
        ? p.bitrateMbps
        : d.bitrateMbps,
    contentHint:
      p.contentHint === 'detail' || p.contentHint === 'motion' ? p.contentHint : d.contentHint
  };
}

export const SCREEN_SHARE_SECTION: SectionConfig<ScreenShareSettings> = {
  defaults: DEFAULTS_SCREEN_SHARE,
  parse: parseScreenShare
};
