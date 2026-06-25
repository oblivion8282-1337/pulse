/**
 * Desktop policy: which actions get mirrored to OS-global shortcuts so they
 * fire while Pulse is unfocused, and their Electron accelerators.
 *
 * Only the voice + stream toggles qualify — they do something useful with the
 * window in the background (mute while gaming, stop a stream). Nav / composer /
 * overlay actions are excluded on purpose: they need the window focused to be
 * visible, and grabbing e.g. Ctrl+K system-wide would steal it from every other
 * app. PTT (hold-to-talk) is excluded too — `globalShortcut` is press-only.
 *
 * Wiring lives in `ShortcutHost.svelte` (pushes this list to main via
 * `window.pulse.shortcuts.setGlobal` on boot + on every rebind).
 */

import { ACTIONS, type ActionId } from './actions';
import { comboToAccelerator } from './format';
import { effectiveBinding, type ShortcutsSettings } from './persistence';

export function globalAccelerators(
  s: ShortcutsSettings
): Array<{ id: ActionId; accelerator: string }> {
  const out: Array<{ id: ActionId; accelerator: string }> = [];
  for (const a of ACTIONS) {
    if (a.hidden || a.context !== 'global') continue;
    if (a.category !== 'voice' && a.category !== 'stream') continue;
    const combo = effectiveBinding(s, a.id);
    if (!combo) continue;
    const accelerator = comboToAccelerator(combo);
    if (accelerator) out.push({ id: a.id, accelerator });
  }
  return out;
}
