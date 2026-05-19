/**
 * Shape, defaults, and parser for the persisted `shortcuts` settings block.
 * Kept out of `lib/stores/settings.svelte.ts` (mirrors `lib/sounds/persistence.ts`).
 */

import { ACTION_BY_ID, isValidActionId, type ActionId } from './actions';
import { parseCombo } from './format';

export type ShortcutsSettings = {
  /** Per-action overrides:
   *   - `string`  = bound to this combo (replaces the default)
   *   - `null`    = explicitly unbound by the user
   *   - missing   = use the default from `ACTION_BY_ID[id].defaultBinding`
   */
  overrides: Record<string, string | null>;
};

export const DEFAULT_SHORTCUTS: ShortcutsSettings = { overrides: {} };

export function parseShortcuts(raw: unknown): ShortcutsSettings {
  if (raw === null || typeof raw !== 'object') return { overrides: {} };
  const o = (raw as { overrides?: unknown }).overrides;
  if (o === null || typeof o !== 'object') return { overrides: {} };
  const out: Record<string, string | null> = {};
  for (const [id, val] of Object.entries(o as Record<string, unknown>)) {
    if (!isValidActionId(id)) continue;
    if (val === null) {
      out[id] = null;
      continue;
    }
    if (typeof val !== 'string') continue;
    if (parseCombo(val) === null) continue;
    out[id] = val;
  }
  return { overrides: out };
}

/** Effective binding for an action: override (if present) > default > null. */
export function effectiveBinding(s: ShortcutsSettings, id: ActionId): string | null {
  if (id in s.overrides) return s.overrides[id];
  return ACTION_BY_ID[id].defaultBinding;
}
