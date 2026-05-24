/**
 * Settings-registry public types. Kept in their own module so plugin
 * authors can `import type { SectionConfig } from '$lib/settings-registry'`
 * without pulling in the rune-using `registry.ts` (which can't be loaded
 * outside of a Svelte runes context).
 */

/**
 * Sign-out behaviour for a section.
 *
 * - `'reset'`     — reinitialise from `defaults` on sign-out (the next user
 *                   on the device shouldn't inherit anything).
 * - `'keep'`      — leave the section untouched (default; applies to device-
 *                   scoped settings like audio devices, theme, screen-share).
 * - object        — partial-merge applied to the section; handy for
 *                   "reset just this one field" (e.g. `{ browserPushEnabled: false }`).
 * - function      — full custom transform; returns the post-sign-out state.
 */
export type SignOutPolicy<T> =
  | 'reset'
  | 'keep'
  | Partial<T>
  | ((state: T) => T);

/**
 * Persistence mode for a section (Plugin-System Schritt 3b).
 *
 * - `'local'`  — `localStorage` only. **Default**; matches the
 *                pre-3b behaviour, every existing section keeps this.
 * - `'server'` — backend ``user_preferences`` row only. Hydrated from
 *                server on sign-in, debounced PUT on each mutation.
 *                The localStorage slice is *not* written to disk.
 *                Best for cross-device-synced plugin state where
 *                staleness > duplication is the failure mode you
 *                want.
 * - `'both'`   — write to both. Server hydration wins on sign-in
 *                (overwrites the local slice). Useful when a plugin
 *                wants offline-resilience plus cross-device sync.
 */
export type PersistenceMode = 'local' | 'server' | 'both';

export interface SectionConfig<T> {
  /** Initial state on first run (and on `reset`). Deep-cloned per registration
   *  so the registry never mutates the caller's object. */
  defaults: T;
  /** Sign-out policy. Default `'keep'` (device-scoped). */
  onSignOut?: SignOutPolicy<T>;
  /** Bumped when the shape changes; pairs with `migrate(...)`. */
  version?: number;
  /** Receives the raw persisted slice (`unknown`) and the version it was
   *  stored under. Return a value-shaped result. Called instead of the
   *  default shallow-merge when version mismatch is detected. */
  migrate?: (oldState: unknown, oldVersion: number) => T;
  /** Parser/clamper — invoked on each load (after migrate) to coerce
   *  arbitrary input into a valid T. Use this for clamps, enum-validation,
   *  drop-unknown-keys etc. If omitted the registry shallow-merges the
   *  stored slice over `defaults`. */
  parse?: (raw: unknown) => T;
  /** Where this section's state lives. **Default `'local'`** — keeps
   *  every existing section's behaviour unchanged. Plugins that need
   *  cross-device sync opt in with `'server'` or `'both'`. See
   *  ``PersistenceMode`` for the semantics. */
  persistence?: PersistenceMode;
}

/**
 * Thin reactive wrapper around one section's state. The `value` getter is
 * the Svelte 5 rune-tracked source; reads inside a `$state`/`$effect` will
 * subscribe normally.
 */
export interface SectionStore<T> {
  readonly name: string;
  readonly value: T;
  get<K extends keyof T>(key: K): T[K];
  set<K extends keyof T>(key: K, value: T[K]): void;
  patch(partial: Partial<T>): void;
  /** Replace the entire section state (used by `reset` + complex setters
   *  that need to reassign nested records reactively). */
  replace(next: T): void;
  reset(): void;
  /** Plain-object snapshot (proxy-stripped) — for persistence + tests. */
  snapshot(): T;
  /** Apply the configured `onSignOut` policy. Called by `runSignOutHooks()`. */
  applySignOut(): void;
}
