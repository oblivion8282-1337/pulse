/**
 * Public barrel for the frontend plugin system.
 *
 * Plugin authors import from here:
 *
 *   import { registerWsHandler } from '$lib/ws/handler-registry';
 *   import { registerSettingsSection } from '$lib/plugins';
 *
 * The app's root layout calls `loadAll()` once on mount. Pro-Guild-
 * Sichtbarkeit der UI-Slots wird über `guild-activation.svelte.ts`
 * entschieden (Server-State, MANAGE_GUILD-Admin-gepflegt). Es gibt
 * **keinen per-User-Activation-State mehr** — siehe
 * `docs/PLUGIN_ROADMAP.md` "Plugin-Admin-Aktivierungs-PR".
 */
export { discoverPlugins, loadAll } from './loader';
export {
  activatePlugin,
  addPlugin,
  deactivatePlugin,
  getPlugin,
  listPlugins,
  PluginPermissionError,
  registerSettingsSection,
  resolvePluginPermissionMode
} from './registry';
export type { PluginPermissionMode, PluginRecord } from './registry';
export type {
  PluginDeactivateFn,
  PluginEntryModule,
  PluginManifest,
  PluginRegisterFn,
  PluginScope,
  PluginUses,
  ScopeType
} from './manifest-types';
export {
  conflictsByPlugin,
  conflictKindLabel,
  detectConflicts
} from './conflict-detector';
export type { Conflict, ConflictResourceKind } from './conflict-detector';
export {
  ensureGuildPluginsLoaded,
  guildPluginActivation,
  isPluginEnabledForGuild,
  refreshGuildPlugins,
  resetGuildPluginsCache,
  setGuildPluginEnabled
} from './guild-activation.svelte';
