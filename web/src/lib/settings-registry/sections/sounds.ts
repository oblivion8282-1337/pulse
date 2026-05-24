/**
 * `sounds` section — master + per-category enable/volume.
 * Re-exports the existing parser from `lib/sounds/persistence.ts` so the
 * sound-engine and the registry stay in sync without a circular import.
 * Device-scoped.
 */
import type { SectionConfig } from '../types';
import {
  DEFAULT_SOUNDS,
  parseSounds,
  type SoundsSettings
} from '$lib/sounds/persistence';

export const SOUNDS_SECTION: SectionConfig<SoundsSettings> = {
  defaults: DEFAULT_SOUNDS,
  parse(raw) {
    return parseSounds(raw as Partial<SoundsSettings> | null | undefined);
  }
};
