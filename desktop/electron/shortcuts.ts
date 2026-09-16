/**
 * Pulse desktop shell — OS-global keyboard shortcuts.
 *
 * The in-window shortcut engine (`web/src/lib/shortcuts/engine.svelte.ts`) only
 * sees keydowns while the window is focused. To let the background-capable
 * toggles (mute / deafen / disconnect / stream) fire while Pulse is in the
 * background, the renderer hands us the current bindings — already converted to
 * Electron accelerators — and we register them globally.
 *
 * The renderer owns the policy (WHICH actions, see `lib/shortcuts/desktop.ts`)
 * and the combo→accelerator conversion; we just register and echo the fired
 * action id back over `shortcuts:trigger`, where the renderer dispatches it
 * through the same handler registry as a focused press.
 *
 * `globalShortcut` swallows a registered accelerator system-wide, so a focused
 * press goes through this path too (no double-fire with the window listener).
 * If an accelerator is already owned by another app, `register` throws — we
 * skip it, and the in-window listener still handles it while Pulse is focused.
 *
 * Note: `globalShortcut` only fires on press, not release — so this covers
 * edge-triggered toggles, NOT hold-to-talk PTT (that still needs a native
 * key-listener; see the TODO in `main.ts`).
 */

import { ipcMain, globalShortcut, BrowserWindow } from 'electron';

type Binding = { id: string; accelerator: string };

/** Security-Audit 2026-09-16: Accelerator-Form erzwingen, bevor irgendetwas
 *  registriert wird. Die Renderer-Seite wandelt Combos selbst um
 *  (`web/src/lib/shortcuts/format.ts::comboToAccelerator`), aber der Kanal
 *  nimmt beliebige Strings an. Diese Gestalt-Prüfung ist das exakte Abbild
 *  dessen, was der Renderer erzeugen kann — wer sie erweitert, erweitert
 *  BEIDE Seiten (dort ACCEL_KEY/punctuation, hier TASTE). */
const MODIFIERS = new Set([
  'CommandOrControl', 'CmdOrCtrl', 'Command', 'Cmd', 'Meta', 'Super',
  'Control', 'Ctrl', 'Alt', 'Option', 'Shift',
]);
const TASTE = /^(F(1[0-9]|2[0-4]|[1-9])|[A-Z0-9]|[,./;'`[\]\=+\-]|Space|Tab|CapsLock|NumLock|ScrollLock|Backspace|Delete|Insert|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Escape|Esc|Pause|PrintScreen|ContextMenu|Backquote|Numpad[0-9]|NumpadAdd|NumpadSubtract|NumpadMultiply|NumpadDivide|NumpadDecimal|NumpadEnter)$/;

function istGueltigerAccelerator(acc: string): boolean {
  const teile = acc.split('+').map((t) => t.trim()).filter(Boolean);
  if (teile.length === 0 || teile.length > 4) return false;
  const taste = teile[teile.length - 1];
  if (!TASTE.test(taste)) return false;
  return teile.slice(0, -1).every((m) => MODIFIERS.has(m));
}

function sanitise(list: unknown): Binding[] {
  if (!Array.isArray(list)) return [];
  const out: Binding[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const { id, accelerator } = item as Record<string, unknown>;
    if (
      typeof id === 'string' &&
      typeof accelerator === 'string' &&
      istGueltigerAccelerator(accelerator)
    ) {
      out.push({ id, accelerator });
    }
  }
  return out;
}

export function wireGlobalShortcuts(getWindow: () => BrowserWindow | null): void {
  // `register` returns `false` on a conflict (accelerator already owned by
  // another app) on Windows/Linux WITHOUT throwing, so we check the return value
  // — not just catch — and log what failed (visible when the app is launched
  // from a console / in the main-process log). The in-window listener still
  // handles those actions while Pulse is focused.
  ipcMain.handle('shortcuts:setGlobal', (_e, list: unknown) => {
    globalShortcut.unregisterAll();
    const failed: string[] = [];
    for (const b of sanitise(list)) {
      let ok = false;
      try {
        ok = globalShortcut.register(b.accelerator, () => {
          getWindow()?.webContents.send('shortcuts:trigger', b.id);
        });
      } catch {
        // register threw (rare; conflicts normally return false instead) — leave ok=false
      }
      if (!ok) failed.push(b.accelerator);
    }
    if (failed.length > 0) console.warn('[shortcuts] konnte nicht registrieren:', failed.join(', '));
  });
}
