/**
 * Shape, defaults, and parser for the persisted `sounds` settings block.
 * Kept out of `lib/stores/settings.svelte.ts` to keep that file under the
 * project's 500-line hard cap.
 */

export type SoundCategoryKey = 'notification' | 'voice' | 'ui';

export type SoundCategorySettings = {
  enabled: boolean;
  volume: number; // 0..1
};

export type SoundsSettings = {
  /** Master switch — kills all sounds when off, regardless of category state. */
  masterEnabled: boolean;
  /** Master volume, multiplied with the per-category volume. 0.7 = sensible default. */
  masterVolume: number;
  notification: SoundCategorySettings;
  voice: SoundCategorySettings;
  ui: SoundCategorySettings;
};

export const DEFAULT_SOUNDS: SoundsSettings = {
  masterEnabled: true,
  masterVolume: 0.7,
  notification: { enabled: true, volume: 1 },
  voice: { enabled: true, volume: 1 },
  // UI feedback (send-click, dialog-pop) is the noisiest category; default off
  // so we don't auto-annoy power users. Notifications + voice match Discord.
  ui: { enabled: false, volume: 1 }
};

function clampVolume(v: unknown, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(1, Math.max(0, v));
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function parseCategory(
  raw: Partial<SoundCategorySettings> | undefined | null,
  d: SoundCategorySettings
): SoundCategorySettings {
  const p = raw ?? {};
  return {
    enabled: bool(p.enabled, d.enabled),
    volume: clampVolume(p.volume, d.volume)
  };
}

/**
 * Parse the persisted `sounds` block. Falls back to ``DEFAULT_SOUNDS`` for
 * any missing field — users who never touched the new Sounds-Tab get the
 * real defaults (master on, volume 0.7).
 *
 * We do NOT migrate the pre-split ``notifications.soundEnabled`` boolean.
 * That flag was a placeholder with default ``false`` that never actually
 * gated any playback; treating it as a real user preference muted every
 * upgrader who had never seen the new tab.
 */
export function parseSounds(
  raw: Partial<SoundsSettings> | undefined | null
): SoundsSettings {
  const d = DEFAULT_SOUNDS;
  const p = raw ?? {};
  return {
    masterEnabled: bool(p.masterEnabled, d.masterEnabled),
    masterVolume: clampVolume(p.masterVolume, d.masterVolume),
    notification: parseCategory(p.notification, d.notification),
    voice: parseCategory(p.voice, d.voice),
    ui: parseCategory(p.ui, d.ui)
  };
}

export function clampSoundVolume(v: number): number {
  return clampVolume(v, 0);
}
