/**
 * Resolvers: combo → ActionId, and conflict detection used by the UI.
 *
 * Conflict scope = same `context` only. A composer binding (Ctrl+B) does
 * not collide with a global binding using the same combo — they fire in
 * different surfaces.
 */

import { ACTIONS, ACTION_BY_ID, type ActionContext, type ActionId } from './actions';
import { effectiveBinding, type ShortcutsSettings } from './persistence';

export function resolveAction(
  s: ShortcutsSettings,
  combo: string,
  context: ActionContext
): ActionId | null {
  for (const a of ACTIONS) {
    if (a.context !== context) continue;
    if (effectiveBinding(s, a.id) === combo) return a.id;
  }
  return null;
}

/** Returns the OTHER action already bound to `combo` in `id`'s context, or null. */
export function conflictWith(
  s: ShortcutsSettings,
  combo: string,
  id: ActionId
): ActionId | null {
  const ctx = ACTION_BY_ID[id].context;
  for (const a of ACTIONS) {
    if (a.id === id) continue;
    if (a.context !== ctx) continue;
    if (effectiveBinding(s, a.id) === combo) return a.id;
  }
  return null;
}
