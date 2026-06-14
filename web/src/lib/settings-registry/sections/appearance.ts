/**
 * `appearance` section — theme preference + name-colour options.
 * Device-scoped → `onSignOut: 'keep'` (default).
 */
import type { SectionConfig } from '../types';

export type ThemePreference = 'light' | 'dark' | 'system';

export type AppearanceSettings = {
  theme: ThemePreference;
  /** Sprech-Ring (der pulsierende Ring beim Reden) in der Namensfarbe statt
   *  der Standard-Akzentfarbe. Default false (= Standard-Lila). */
  speakingRingNameColor: boolean;
};

const VALID_THEMES: ThemePreference[] = ['light', 'dark', 'system'];

export const DEFAULTS_APPEARANCE: AppearanceSettings = {
  theme: 'system',
  speakingRingNameColor: false
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
    return {
      theme: parseTheme(p.theme),
      speakingRingNameColor: p.speakingRingNameColor === true
    };
  }
};
