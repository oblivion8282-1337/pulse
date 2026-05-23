/**
 * `shortcuts` section — keyboard binding overrides.
 * Re-exports the existing parser from `lib/shortcuts/persistence.ts`.
 * Device-scoped.
 */
import type { SectionConfig } from '../types';
import {
  DEFAULT_SHORTCUTS,
  parseShortcuts,
  type ShortcutsSettings
} from '$lib/shortcuts/persistence';

export const SHORTCUTS_SECTION: SectionConfig<ShortcutsSettings> = {
  defaults: DEFAULT_SHORTCUTS,
  parse(raw) {
    return parseShortcuts(raw);
  }
};
