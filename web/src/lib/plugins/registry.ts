/**
 * Frontend plugin lifecycle registry — symmetric to the backend's
 * `PluginManager` (`services/chat-gateway/.../plugins/registry.py`).
 *
 * For each plugin we track:
 * - the manifest (typed mirror of `plugin.toml`)
 * - the entry module (lazy-imported on `activate`)
 * - the set of WS-handler op-codes + settings-section names registered
 *   during `register()`, so a later `deactivate()` can roll the side
 *   effects back via the Schritt-2c/3 `unregister*` APIs.
 *
 * Registration tracking works the same way as the backend: we snapshot
 * `listWsHandlers()` and `listSections()` before/after the plugin's
 * `register()` runs and store the diff.
 *
 * Schritt 5 — permission gate
 * ---------------------------
 * After `register()` we diff what the plugin actually registered against
 * its manifest's `[plugin.uses]` whitelist. In `strict` mode (default), an
 * undeclared op or section rolls the plugin's registrations back and we
 * mark the record as `failedActivate`. In `warn` mode, we log + accept; in
 * `off` mode, no check at all. Mode is picked via
 * `import.meta.env.PULSE_PLUGIN_PERMISSIONS` (Vite-style) with a default
 * of `'strict'`. Mirror the backend's contract — see
 * `services/chat-gateway/src/dcc_chat_gateway/plugins/permissions.py`.
 *
 * Plugins are not isolated — they run in the host bundle with full DOM +
 * `$lib` access. The soft-sandbox is a defence against *accidental*
 * capability inflation, not malicious plugins (see
 * `memory/plugin-sandbox-future.md` for the long-term path).
 */
import { listSections, registerSettingsSection } from '$lib/settings-registry';
import {
  listWsHandlers,
  unregisterWsHandler
} from '$lib/ws/handler-registry';

import type {
  PluginDeactivateFn,
  PluginEntryModule,
  PluginManifest,
  PluginRegisterFn
} from './manifest-types';

export type PluginPermissionMode = 'strict' | 'warn' | 'off';

/** Resolve the active permission mode. Browser-side we look at Vite's
 *  `import.meta.env.PULSE_PLUGIN_PERMISSIONS` first, then fall back to
 *  globalThis (`window`) so tests + SSR can inject a value. Unknown values
 *  fall back to `'strict'` — never silently relax the gate. */
export function resolvePluginPermissionMode(): PluginPermissionMode {
  let raw: unknown;
  try {
    raw = (import.meta as { env?: Record<string, unknown> }).env?.PULSE_PLUGIN_PERMISSIONS;
  } catch {
    raw = undefined;
  }
  if (raw === undefined && typeof globalThis !== 'undefined') {
    raw = (globalThis as { PULSE_PLUGIN_PERMISSIONS?: unknown }).PULSE_PLUGIN_PERMISSIONS;
  }
  if (raw === 'strict' || raw === 'warn' || raw === 'off') return raw;
  return 'strict';
}

/** Thrown by `activatePlugin` in `strict` mode when the plugin registered
 *  something it didn't declare in `[plugin.uses]`. The loader catches +
 *  logs this so a single bad plugin can't gate the others. */
export class PluginPermissionError extends Error {
  readonly undeclaredOps: string[];
  readonly undeclaredSections: string[];
  constructor(name: string, undeclaredOps: string[], undeclaredSections: string[]) {
    const parts: string[] = [];
    if (undeclaredOps.length > 0) parts.push(`ws_ops=${JSON.stringify(undeclaredOps)}`);
    if (undeclaredSections.length > 0)
      parts.push(`settings_sections=${JSON.stringify(undeclaredSections)}`);
    super(
      `plugin ${JSON.stringify(name)}: registered undeclared ${parts.join(', ') || '<empty>'}` +
        ` — add them to [plugin.uses] in plugin.toml`
    );
    this.name = 'PluginPermissionError';
    this.undeclaredOps = [...undeclaredOps];
    this.undeclaredSections = [...undeclaredSections];
  }
}

export interface PluginRecord {
  manifest: PluginManifest;
  /** Lazy entry module loader — resolves to the plugin's `register.ts`
   *  default export. The registry awaits this on `activate()`. */
  entry: () => Promise<PluginEntryModule>;
  activated: boolean;
  /** Set to `true` if a previous `activate()` failed (incl. permission
   *  rejection). The record is kept so a UI can surface the failure +
   *  the plugin's manifest. Re-activation re-runs the load. */
  failedActivate?: boolean;
  /** Diff captured around `register()`. */
  registeredOps: Set<string>;
  registeredSections: Set<string>;
  /** Optional plugin-supplied cleanup (e.g. event listeners the registry
   *  can't see). */
  deactivateHook?: PluginDeactivateFn;
}

const records = new Map<string, PluginRecord>();

export interface PluginEntry {
  manifest: PluginManifest;
  entry: () => Promise<PluginEntryModule>;
}

/** Add a discovered plugin to the registry without activating it. The
 *  loader calls this for every entry it found; activation is a separate
 *  step so a UI can flip the toggle later. */
export function addPlugin(entry: PluginEntry): PluginRecord {
  const name = entry.manifest.name;
  if (records.has(name)) {
    throw new Error(`plugin ${JSON.stringify(name)} already added`);
  }
  const rec: PluginRecord = {
    manifest: entry.manifest,
    entry: entry.entry,
    activated: false,
    registeredOps: new Set(),
    registeredSections: new Set()
  };
  records.set(name, rec);
  return rec;
}

export function getPlugin(name: string): PluginRecord | undefined {
  return records.get(name);
}

export function listPlugins(): PluginRecord[] {
  return Array.from(records.values());
}

/** Activate a plugin: import its entry module, call `register()`, diff
 *  the registries to track what it registered. Schritt 5 — in `strict`
 *  mode (default) we additionally diff the registrations against the
 *  manifest's `[plugin.uses]` whitelist and roll back on a violation.
 *  Idempotent for activated plugins; a previous failed activate is
 *  retried from scratch. */
export async function activatePlugin(name: string): Promise<PluginRecord> {
  const rec = records.get(name);
  if (!rec) throw new Error(`unknown plugin: ${name}`);
  if (rec.activated) return rec;

  const beforeOps = new Set(listWsHandlers());
  const beforeSections = new Set(listSections());

  const mod = await rec.entry();
  const register = mod.default as PluginRegisterFn | undefined;
  if (typeof register !== 'function') {
    rec.failedActivate = true;
    throw new TypeError(
      `plugin ${name}: frontend entry did not default-export a register() function`
    );
  }
  await register();

  const afterOps = listWsHandlers();
  const afterSections = listSections();
  const newOps = new Set(afterOps.filter((op) => !beforeOps.has(op)));
  const newSections = new Set(afterSections.filter((s) => !beforeSections.has(s)));

  // ---- Schritt-5 permission gate ---------------------------------------
  const mode = resolvePluginPermissionMode();
  if (mode !== 'off') {
    const declaredOps = new Set(rec.manifest.uses.ws_ops);
    const declaredSections = new Set(rec.manifest.uses.settings_sections);
    const undeclaredOps = [...newOps].filter((op) => !declaredOps.has(op));
    const undeclaredSections = [...newSections].filter((s) => !declaredSections.has(s));
    if (undeclaredOps.length > 0 || undeclaredSections.length > 0) {
      if (mode === 'strict') {
        // Roll back the WS handlers before raising. The settings-registry
        // has no `unregister` API (sections own persistent user data —
        // see the rationale on `deactivatePlugin`), so newly-registered
        // sections stay; we only tag the failure on the record so a
        // future re-activation can pick up where we left off.
        for (const op of newOps) unregisterWsHandler(op);
        rec.registeredOps.clear();
        rec.registeredSections.clear();
        rec.failedActivate = true;
        rec.activated = false;
        const err = new PluginPermissionError(name, undeclaredOps, undeclaredSections);
        console.error(`[plugins] ${name}: permission gate rejected activation`, err);
        throw err;
      }
      console.warn(
        `[plugins] ${name}: undeclared registrations (mode=warn) ` +
          `ops=${JSON.stringify(undeclaredOps)} ` +
          `sections=${JSON.stringify(undeclaredSections)}`
      );
    }
  }

  rec.registeredOps = newOps;
  rec.registeredSections = newSections;
  rec.deactivateHook = mod.deactivate;
  rec.activated = true;
  rec.failedActivate = false;
  return rec;
}

/** Deactivate a plugin: run its optional `deactivate()` hook first (so the
 *  plugin sees its own handlers still live during cleanup), then
 *  unregister the WS handlers + settings sections it added. Idempotent.
 *
 *  Hook order matches the backend's `PluginManager.deactivate`. A hook
 *  exception is logged + swallowed — rollback must always complete. */
export async function deactivatePlugin(name: string): Promise<PluginRecord> {
  const rec = records.get(name);
  if (!rec) throw new Error(`unknown plugin: ${name}`);
  if (!rec.activated) return rec;
  if (rec.deactivateHook) {
    try {
      await rec.deactivateHook();
    } catch (err) {
      console.error(`[plugins] ${name}: deactivate hook raised`, err);
    }
  }
  for (const op of rec.registeredOps) unregisterWsHandler(op);
  // The settings-registry has no `unregister` API (sections own persistent
  // user data — we deliberately do NOT drop their values from the
  // localStorage blob on deactivate). The op tracking is enough for
  // Schritt 4; settings-section reactivation will reuse the existing slot.
  rec.registeredOps.clear();
  rec.registeredSections.clear();
  rec.deactivateHook = undefined;
  rec.activated = false;
  return rec;
}

/** Test/dev helper. The registry exports the same shape the backend uses;
 *  no production path resets at runtime. */
export function _resetPluginRegistry(): void {
  records.clear();
}

// Re-export so plugin modules can `import { registerSettingsSection } from
// '$lib/plugins'` without reaching into the settings-registry barrel
// directly — keeps the plugin author's import surface small.
export { registerSettingsSection };
