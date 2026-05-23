/**
 * Public barrel for the frontend plugin system (Schritt 4 Plugin-System).
 *
 * Plugin authors import from here:
 *
 *   import { registerWsHandler } from '$lib/ws/handler-registry';
 *   import { registerSettingsSection } from '$lib/plugins';
 *
 * The app's root layout calls `loadAll()` once on mount. Tests / dev
 * tools use `discoverPlugins` + `activatePlugin` / `deactivatePlugin`
 * directly.
 */
export { discoverPlugins, loadAll } from './loader';
export {
  activatePlugin,
  addPlugin,
  deactivatePlugin,
  getPlugin,
  listPlugins,
  registerSettingsSection
} from './registry';
export type {
  PluginDeactivateFn,
  PluginEntryModule,
  PluginManifest,
  PluginRegisterFn,
  PluginScope,
  PluginUses,
  ScopeType
} from './manifest-types';
