/**
 * Public barrel for the settings-section registry.
 *
 * Phase 3 of the Plugin-System-Plan — symmetric to
 * `lib/ws/handler-registry.ts` (Phase 2c) and the backend's
 * `@register_ws_op` decorator (Phase 2).
 *
 * Plugin usage:
 *
 *   import { registerSettingsSection } from '$lib/settings-registry';
 *
 *   const tama = registerSettingsSection('tamagotchi', {
 *     defaults: { petName: 'Pipsi', hunger: 0, lastFedAt: 0 },
 *     onSignOut: 'reset'
 *   });
 *
 *   // Reactive read — `tama.value.petName` re-runs the $effect on change.
 *   $effect(() => console.log(tama.value.petName));
 *   tama.set('petName', 'Hugo');
 */
export {
  registerSettingsSection,
  getSection,
  listSections,
  runSignOutHooks,
  bindPersistence,
  schedulePersist,
  flushPersist
} from './registry.svelte';
export type { SectionConfig, SectionStore, SignOutPolicy } from './types';
