/**
 * Runtime engine: per-action handler registry + window-level keydown listener.
 *
 * Feature components call `register(id, handler)` from `onMount` and dispose
 * via the returned function. The window listener (mounted once at app boot
 * via `mountWindowListener()`) reads `settings.shortcuts` reactively, looks
 * up the binding for each keydown, and dispatches to the registered handler.
 *
 * Last-write-wins per ActionId: only one handler is active at a time. This
 * matches the SPA topology (one VoiceChannelView, one composer, etc.).
 */

import { settings } from '$lib/stores/settings.svelte';
import { type ActionId } from './actions';
import { eventToCombo, hasModifier } from './format';
import { resolveAction } from './registry';

const handlers = new Map<ActionId, () => void>();

export function register(id: ActionId, handler: () => void): () => void {
  handlers.set(id, handler);
  return () => {
    if (handlers.get(id) === handler) handlers.delete(id);
  };
}

/** Run the registered handler for an action, if any. Used by the window
 *  listener below and by the desktop global-shortcut bridge (ShortcutHost). */
export function dispatch(id: ActionId): void {
  handlers.get(id)?.();
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  if (target.isContentEditable) return true;
  return false;
}

/** Look up the composer action for an event. Called from MessageInput.onKeydown. */
export function lookupComposer(e: KeyboardEvent): ActionId | null {
  const combo = eventToCombo(e);
  if (!combo) return null;
  return resolveAction(settings.shortcuts, combo, 'composer');
}

/** Mount the global keydown listener. Returns a disposer. Idempotent at the
 *  caller's discretion — caller must not double-mount (one listener per app). */
export function mountWindowListener(): () => void {
  const onKey = (e: KeyboardEvent) => {
    const combo = eventToCombo(e);
    if (!combo) return;
    const id = resolveAction(settings.shortcuts, combo, 'global');
    if (!id) return;
    // Single-key bindings (e.g. F8) must not steal keys from inputs/textareas.
    // Modifier-combos (Ctrl+K, Alt+Up) are safe and fire regardless.
    if (!hasModifier(combo) && isTypingTarget(e.target)) return;
    if (!handlers.has(id)) return;
    e.preventDefault();
    e.stopPropagation();
    dispatch(id);
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
