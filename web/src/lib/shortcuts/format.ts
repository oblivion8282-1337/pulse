/**
 * Canonical combo format: lower-case, modifier order `ctrl+alt+shift+KEY`.
 * Key is `event.key.toLowerCase()` (matches the existing `pttKey` convention).
 *
 * Mac note: Cmd is treated as Ctrl on storage (combo "ctrl+k" matches both
 * Ctrl+K and ⌘+K). UI display flips back to ⌘ via `displayCombo()`.
 */

const PURE_MOD_KEYS: ReadonlySet<string> = new Set([
  'control',
  'shift',
  'alt',
  'meta',
  'altgraph'
]);

export function isPureModifier(key: string): boolean {
  return PURE_MOD_KEYS.has(key.toLowerCase());
}

/** Build the canonical combo from a KeyboardEvent, or `null` if the press
 *  is just a bare modifier (no usable key). */
export function eventToCombo(e: KeyboardEvent): string | null {
  const k = (e.key || '').toLowerCase();
  if (!k || isPureModifier(k)) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  parts.push(k);
  return parts.join('+');
}

export type ComboParts = {
  mods: { ctrl: boolean; alt: boolean; shift: boolean };
  key: string;
};

export function parseCombo(s: unknown): ComboParts | null {
  if (typeof s !== 'string' || s.length === 0) return null;
  const parts = s.toLowerCase().split('+').map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  const key = parts[parts.length - 1];
  if (!key || isPureModifier(key)) return null;
  const mods = { ctrl: false, alt: false, shift: false };
  for (let i = 0; i < parts.length - 1; i++) {
    const m = parts[i];
    if (m === 'ctrl' || m === 'cmd' || m === 'meta') mods.ctrl = true;
    else if (m === 'alt' || m === 'option') mods.alt = true;
    else if (m === 'shift') mods.shift = true;
    else return null;
  }
  return { mods, key };
}

export function hasModifier(combo: string): boolean {
  const p = parseCombo(combo);
  return p ? p.mods.ctrl || p.mods.alt || p.mods.shift : false;
}

const KEY_LABELS: Record<string, string> = {
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  ' ': 'Space',
  escape: 'Esc',
  enter: 'Enter',
  tab: 'Tab',
  backspace: '⌫',
  delete: 'Del'
};

const ACCEL_KEY: Record<string, string> = {
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  ' ': 'Space',
  escape: 'Esc',
  enter: 'Enter',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete'
};

/** Convert a canonical combo to an Electron `globalShortcut` accelerator, or
 *  `null` if the key can't be represented (caller skips registering it). Used
 *  by the desktop bridge to mirror background-capable toggles to OS-global
 *  shortcuts (`lib/shortcuts/desktop.ts`). */
export function comboToAccelerator(combo: string): string | null {
  const p = parseCombo(combo);
  if (!p) return null;
  const parts: string[] = [];
  if (p.mods.ctrl) parts.push('CommandOrControl');
  if (p.mods.alt) parts.push('Alt');
  if (p.mods.shift) parts.push('Shift');
  const k = p.key;
  let key: string | null = ACCEL_KEY[k] ?? null;
  if (!key) {
    if (/^f([1-9]|1[0-9]|2[0-4])$/.test(k) || /^[a-z0-9]$/.test(k)) {
      key = k.toUpperCase(); // F1–F24, letters / digits
    } else if (/^[,./;'`[\]\\=+\-]$/.test(k)) {
      key = k; // safe punctuation
    }
  }
  if (!key) return null;
  parts.push(key);
  return parts.join('+');
}

function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad/.test(navigator.platform);
}

/** Human-readable label for a combo. Returns "—" for unbound (null). */
export function displayCombo(combo: string | null): string {
  if (combo === null) return '—';
  const p = parseCombo(combo);
  if (!p) return combo;
  const mac = isMacPlatform();
  const out: string[] = [];
  if (p.mods.ctrl) out.push(mac ? '⌘' : 'Ctrl');
  if (p.mods.alt) out.push(mac ? '⌥' : 'Alt');
  if (p.mods.shift) out.push(mac ? '⇧' : 'Shift');
  const k = p.key;
  const label =
    KEY_LABELS[k] ??
    (k.length === 1 ? k.toUpperCase() : k.charAt(0).toUpperCase() + k.slice(1));
  out.push(label);
  return out.join(mac ? '' : ' + ');
}
