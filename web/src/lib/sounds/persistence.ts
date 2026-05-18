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
 * Parse the persisted `sounds` block. If absent, falls back to
 * `legacySoundEnabled` (the pre-split `notifications.soundEnabled` boolean)
 * for the `masterEnabled` field so users who toggled the old placeholder
 * keep their choice.
 */
export function parseSounds(
  raw: Partial<SoundsSettings> | undefined | null,
  legacySoundEnabled: boolean | undefined
): SoundsSettings {
  const d = DEFAULT_SOUNDS;
  const p = raw ?? {};
  const explicitMaster = typeof p.masterEnabled === 'boolean';
  return {
    masterEnabled: explicitMaster
      ? (p.masterEnabled as boolean)
      : typeof legacySoundEnabled === 'boolean'
        ? legacySoundEnabled
        : d.masterEnabled,
    masterVolume: clampVolume(p.masterVolume, d.masterVolume),
    notification: parseCategory(p.notification, d.notification),
    voice: parseCategory(p.voice, d.voice),
    ui: parseCategory(p.ui, d.ui)
  };
}

export function clampSoundVolume(v: number): number {
  return clampVolume(v, 0);
}
