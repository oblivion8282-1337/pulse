/**
 * `shortcuts` section — keyboard binding overrides.
 * Re-exports the existing parser from `lib/shortcuts/persistence.ts`.
 *
 * Account-scoped, cross-device synced (`persistence: 'both'`):
 *   - `'both'` and not `'server'`: bindings must work at the first keystroke
 *     after a cold start. `'server'` keeps no local copy, so every reload would
 *     leave the user shortcut-less until `GET /preferences` returns — offline,
 *     never.
 *   - `onSignOut: 'reset'` is required, not cosmetic: `hydrateServerSections`
 *     skips a section when the signing-in account has no server row
 *     (registry.svelte.ts — `if (row === undefined) continue`), so under the
 *     default `'keep'` the next account on a shared device would inherit the
 *     previous one's bindings. Resetting on sign-out makes a row-less account
 *     start from the (empty) defaults.
 *
 * Cross-INSTANCE scope — do not "fix" this without reading on:
 *   `server-sync.ts` deliberately does NOT go through the per-server routing in
 *   `api/client.ts`. It issues a raw relative `fetch('/api/chat/preferences')`
 *   with the cloud identity token from `loadTokens()` (self-host session tokens
 *   live separately in `session_tokens.svelte.ts`). So for every client served
 *   from howispulse.com — browser and desktop app alike — the bindings land on
 *   the CLOUD chat-gateway regardless of which server is active, and therefore
 *   follow the user onto self-hosted servers too. That is the intended UX: a
 *   keyboard layout is a property of the person, not of the server they visit.
 *   Routing this through `activeServer` would silently scatter one user's
 *   bindings across every instance they join.
 */
import type { SectionConfig } from '../types';
import {
  DEFAULT_SHORTCUTS,
  parseShortcuts,
  type ShortcutsSettings
} from '$lib/shortcuts/persistence';

export const SHORTCUTS_SECTION: SectionConfig<ShortcutsSettings> = {
  defaults: DEFAULT_SHORTCUTS,
  persistence: 'both',
  onSignOut: 'reset',
  parse(raw) {
    return parseShortcuts(raw);
  }
};
