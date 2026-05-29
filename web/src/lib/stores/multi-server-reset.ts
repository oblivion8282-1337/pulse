/**
 * Phase 4.5 — Reset-on-Server-Switch + Sign-Out.
 *
 * Leert alle Server-scoped Stores in einem Rutsch. Aufgerufen von:
 *  - `activeServer.set(id)` beim Server-Wechsel (nicht beim initialen `init()`)
 *  - `auth.signOut()` als Konsolidierung der bisher inline gepflegten
 *    Liste (vorher 15+ einzelne `.clear()`-Calls).
 *
 * Globale UI-State (`settings`, `viewport`, `navDrawer`, `onboardingState`,
 * `uiOverlays`, `privacy`, `capabilities`) bleibt erhalten — die hängt nicht
 * am gerade aktiven Server. `userCache` ist ebenfalls global gehalten und wird
 * nur bei Sign-Out (nicht Switch) geleert — sonst flackern Avatare beim Hin-
 * und Herwechseln.
 *
 * Konvention: **alle** Server-scoped Stores nutzen `.clear()`, mit zwei
 * Ausnahmen:
 *  - `readState.resetCacheOnly()` — der localStorage-Inhalt ist `userId`-keyed
 *    (`pulse.readState.<uid>`), nicht server-keyed. Beim Switch wollen wir die
 *    persistierten Read-Marks **nicht** wegwerfen; nur den In-Memory-Snapshot
 *    leeren, sodass der neue ready-Frame seeden kann.
 *  - `resetGuildPluginsCache()` — Map-Reset, nicht Store-Klasse.
 *
 * Reset-Methoden-Namen sind absichtlich nicht harmonisiert (`clear`
 * vs. `resetCacheOnly`) — die Stores unterscheiden sich semantisch, nicht
 * nur kosmetisch. Wer einen neuen Server-scoped Store hinzufügt, **muss**
 * ihn hier eintragen, sonst leakt sein State über Server-Wechsel hinweg.
 */

import { blocks } from './blocks.svelte';
import { channelPermissions } from './channelPermissions.svelte';
import { directMessages } from './directMessages.svelte';
import { friendRequests } from './friendRequests.svelte';
import { friends } from './friends.svelte';
import { guildSounds } from './guildSounds.svelte';
import { guilds } from './guilds.svelte';
import { memberRoles } from './memberRoles.svelte';
import { messages } from './messages.svelte';
import { presence } from './presence.svelte';
import { readState } from './readState.svelte';
import { roles } from './roles.svelte';
import { streamPresence } from './streamPresence.svelte';
import { voicePresence } from './voicePresence.svelte';
import { watchPartyPresence } from './watchPartyPresence.svelte';
import { resetGuildPluginsCache } from '$lib/plugins';
import { memberListCache } from '$lib/components/MentionAutocomplete.svelte';

/**
 * Leert alle 15 Server-scoped Stores. Idempotent.
 *
 * **Reihenfolge spielt keine Rolle** — die Stores haben keine Inter-Dependencies
 * im Reset-Pfad. UI-Components, die einen `$derived` auf mehreren der Stores
 * laufen lassen, sehen den Zwischenzustand evtl. partiell-geleert — das ist
 * OK, weil Svelte's Reactivity erst nach dem synchronen Block flusht und der
 * nachfolgende ready-Frame die Stores ohnehin neu befüllt.
 */
export function resetServerScopedStores(): void {
  guilds.clear();
  directMessages.clear();
  messages.clear();
  // readState: nur Memory-Cache, localStorage bleibt (userId-keyed).
  readState.resetCacheOnly();
  roles.clear();
  guildSounds.clear();
  channelPermissions.clear();
  memberRoles.clear();
  voicePresence.clear();
  streamPresence.clear();
  watchPartyPresence.clear();
  friends.clear();
  friendRequests.clear();
  blocks.clear();
  presence.clear();
  // Plugin-pro-Guild-Toggle-Cache liegt außerhalb der Store-Klassen.
  resetGuildPluginsCache();
  // Guild-member autocomplete cache — stale after server-switch / sign-out.
  memberListCache.clear();
}
