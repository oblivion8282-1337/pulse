/**
 * `layout` section — persönliche Reihenfolge der Navigations-Bereiche.
 * Gerätbezogen (die Leiste ist reine Anzeige) → `onSignOut: 'keep'`.
 */
import type { SectionConfig } from '../types';
import type { TabId } from '$lib/navigation/tabs';

export type LayoutSettings = {
  /** Persönliche Reihenfolge der Bereiche — immer eine vollständige
   *  Permutation aller vier; fehlt sie, gilt die Standard-Reihenfolge. */
  navOrder?: TabId[];
};

export const DEFAULTS_LAYOUT: LayoutSettings = {};

const ALLE_TABS: TabId[] = ['chats', 'rooms', 'friends', 'me'];

/** Nur eine vollständige Permutation ohne Dubletten ist eine gültige
 *  Reihenfolge — alles andere fällt auf `undefined` (Standard) zurück. */
function parseNavOrder(v: unknown): TabId[] | undefined {
  if (!Array.isArray(v) || v.length !== ALLE_TABS.length) return undefined;
  const gesehen = new Set<string>();
  for (const id of v) {
    if (typeof id !== 'string' || !ALLE_TABS.includes(id as TabId) || gesehen.has(id)) {
      return undefined;
    }
    gesehen.add(id);
  }
  return v as TabId[];
}

export const LAYOUT_SECTION: SectionConfig<LayoutSettings> = {
  defaults: DEFAULTS_LAYOUT,
  parse(raw) {
    const p = (raw && typeof raw === 'object' ? raw : {}) as Partial<LayoutSettings>;
    return { navOrder: parseNavOrder(p.navOrder) };
  }
};
