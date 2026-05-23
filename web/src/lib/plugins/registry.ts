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
 * Plugins are not isolated — they run in the host bundle with full DOM +
 * `$lib` access. Schritt 5 will introduce a permission gate.
 */
import { listSections, registerSettingsSection } from '$lib/settings-registry';
import { listWsHandlers, unregisterWsHandler } from '$lib/ws/handler-registry';

import type {
  PluginDeactivateFn,
  PluginEntryModule,
  PluginManifest,
  PluginRegisterFn
} from './manifest-types';

export interface PluginRecord {
  manifest: PluginManifest;
  /** Lazy entry module loader — resolves to the plugin's `register.ts`
   *  default export. The registry awaits this on `activate()`. */
  entry: () => Promise<PluginEntryModule>;
  activated: boolean;
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
 *  the registries to track what it registered. Idempotent. */
export async function activatePlugin(name: string): Promise<PluginRecord> {
  const rec = records.get(name);
  if (!rec) throw new Error(`unknown plugin: ${name}`);
  if (rec.activated) return rec;

  const beforeOps = new Set(listWsHandlers());
  const beforeSections = new Set(listSections());

  const mod = await rec.entry();
  const register = mod.default as PluginRegisterFn | undefined;
  if (typeof register !== 'function') {
    throw new TypeError(
      `plugin ${name}: frontend entry did not default-export a register() function`
    );
  }
  await register();

  const afterOps = listWsHandlers();
  const afterSections = listSections();
  rec.registeredOps = new Set(afterOps.filter((op) => !beforeOps.has(op)));
  rec.registeredSections = new Set(
    afterSections.filter((s) => !beforeSections.has(s))
  );
  rec.deactivateHook = mod.deactivate;
  rec.activated = true;
  return rec;
}

/** Deactivate a plugin: unregister the WS handlers + settings sections it
 *  added, then call its optional `deactivate()` hook. Idempotent. */
export async function deactivatePlugin(name: string): Promise<PluginRecord> {
  const rec = records.get(name);
  if (!rec) throw new Error(`unknown plugin: ${name}`);
  if (!rec.activated) return rec;
  for (const op of rec.registeredOps) unregisterWsHandler(op);
  // The settings-registry has no `unregister` API (sections own persistent
  // user data — we deliberately do NOT drop their values from the
  // localStorage blob on deactivate). The op tracking is enough for
  // Schritt 4; settings-section reactivation will reuse the existing slot.
  rec.registeredOps.clear();
  rec.registeredSections.clear();
  if (rec.deactivateHook) await rec.deactivateHook();
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
