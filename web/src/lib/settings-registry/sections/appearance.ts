/**
 * `appearance` section — theme preference.
 * Device-scoped → `onSignOut: 'keep'` (default).
 */
import type { SectionConfig } from '../types';

export type ThemePreference = 'light' | 'dark' | 'system';

export type AppearanceSettings = {
  theme: ThemePreference;
};

const VALID_THEMES: ThemePreference[] = ['light', 'dark', 'system'];

export const DEFAULTS_APPEARANCE: AppearanceSettings = {
  theme: 'system'
};

function parseTheme(v: unknown): ThemePreference {
  return VALID_THEMES.includes(v as ThemePreference)
    ? (v as ThemePreference)
    : DEFAULTS_APPEARANCE.theme;
}

export const APPEARANCE_SECTION: SectionConfig<AppearanceSettings> = {
  defaults: DEFAULTS_APPEARANCE,
  parse(raw) {
    const p = (raw && typeof raw === 'object' ? raw : {}) as Partial<AppearanceSettings>;
    return { theme: parseTheme(p.theme) };
  }
};
