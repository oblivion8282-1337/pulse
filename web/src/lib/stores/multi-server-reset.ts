/**
 * Phase 4.5 — Reset-on-Server-Switch + Sign-Out.
 *
 * Leert alle Server-scoped Stores in einem Rutsch. Aufgerufen von:
 *  - `activeServer.set(id)` beim Server-Wechsel (nicht beim initialen `init()`)
 *  - `auth.signOut()` als Konsolidierung der bisher inline gepflegten
 *    Liste (vorher 15+ einzelne `.clear()`-Calls).
 *
 * Globale UI-State (`settings`, `viewport`, `navDrawer`, `uiOverlays`,
 * `privacy`, `capabilities`) bleibt erhalten — die hängt nicht
 * am gerade aktiven Server. `userCache` ist ebenfalls global gehalten und wird
 * nur bei Sign-Out (nicht Switch) geleert — sonst flackern Avatare beim Hin-
 * und Herwechseln.
 *
 * Konvention: **alle** Server-scoped Stores nutzen `.clear()`, mit zwei
 * Ausnahmen:
 *  - `readState.resetCacheOnly()` — der localStorage-Inhalt ist `userId`-keyed
 *    (`pulse.readState.<uid>`), nicht server-keyed. Beim Switch wollen wir die
 *    persistierten Read-Marks **nicht** wegwerfen. Geleert wird deshalb nur
 *    `latestByChannel` (die Sitzungsbeobachtung); die persistierten Karten
 *    werden aus dem Speicher **neu eingelesen** statt auf `{}` gesetzt — sonst
 *    schriebe der nächste `markRead` den kontoweiten Eintrag aus einer leeren
 *    Karte heraus fort und löschte den Lesestand aller anderen Server
 *    (Bughunt 2026-08-17).
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
import { drafts } from './drafts.svelte';
import { friendRequests } from './friendRequests.svelte';
import { communityInvites } from './communityInvites.svelte';
import { directStatus } from './directStatus.svelte';
import { friends } from './friends.svelte';
import { guildSounds } from './guildSounds.svelte';
import { guilds } from './guilds.svelte';
import { memberRoles } from './memberRoles.svelte';
import { messages } from './messages.svelte';
import { modQueueCounts } from './modQueueCounts.svelte';
import { presence } from './presence.svelte';
import { readState } from './readState.svelte';
import { roles } from './roles.svelte';
import { streamChat } from './streamChat.svelte';
import { streamPresence } from './streamPresence.svelte';
import { typing } from './typing.svelte';
import { voicePresence } from './voicePresence.svelte';
import { watchChat } from './watchChat.svelte';
import { watchPartyPresence } from './watchPartyPresence.svelte';
import { watchWatchers } from './watchWatchers.svelte';
import { resetGuildPluginsCache } from '$lib/plugins';
import { memberListCache } from '$lib/components/MentionAutocomplete.svelte';
import { deviceStore } from '$lib/devices/store.svelte';
import { schirmWarten } from '$lib/devices/schirme.svelte';

/**
 * Leert die Server-scoped Stores (Guild-Realtime des aktiven Servers).
 * Idempotent. Aufgerufen beim Server-**Switch** und (zusammen mit
 * `resetSocialStores()`) beim **Sign-Out**.
 *
 * **WICHTIG (Global-Friends Stufe 1):** Die Social-Stores
 * (`friends`/`friendRequests`/`blocks`/`directMessages` + die globale
 * Freund-`presence`) sind **NICHT** mehr Teil dieses Resets. Sie werden global
 * aus der **persistenten Cloud-Connection** gespeist und überleben einen
 * Server-Switch bewusst — beim Switch sendet die Cloud keinen neuen ready-Frame,
 * ein Wipe würde sie also dauerhaft leeren. Sie werden nur bei Sign-Out via
 * `resetSocialStores()` geleert.
 *
 * **Reihenfolge spielt keine Rolle** — die Stores haben keine Inter-Dependencies
 * im Reset-Pfad. UI-Components, die einen `$derived` auf mehreren der Stores
 * laufen lassen, sehen den Zwischenzustand evtl. partiell-geleert — das ist
 * OK, weil Svelte's Reactivity erst nach dem synchronen Block flusht und der
 * nachfolgende ready-Frame die Stores ohnehin neu befüllt.
 */
export function resetServerScopedStores(): void {
  guilds.clear();
  messages.clear();
  // readState: nur Memory-Cache, localStorage bleibt (userId-keyed).
  readState.resetCacheOnly();
  roles.clear();
  guildSounds.clear();
  channelPermissions.clear();
  memberRoles.clear();
  modQueueCounts.clear();
  voicePresence.clear();
  streamPresence.clear();
  streamChat.clearAll();
  watchChat.clearAll();
  watchPartyPresence.clear();
  watchWatchers.clear();
  typing.clearAll();
  // Standplatz-Geräte (Bughunt 2026-08-16): der Store ist server-scoped wie
  // `guilds`, stand aber nicht in dieser Liste. Folge: A→B→A zeigte die alten
  // Zeilen samt ihrem alten Zustand („bereit", obwohl der Rechner längst weg
  // ist), und `byChannelOwner` — der Weg von einer laufenden Fernsteuerung
  // zurück zum Gerät — suchte über die Communitys ALLER Server. `reset()` statt
  // `clear()`, weil der Store neben den Zeilen auch seinen Geladen-Merker
  // fallen lassen muss; sonst lädt die Community nach dem Wechsel nie neu.
  deviceStore.reset();
  // Und die Wünsche auf ein Bild dazu: ihre Zeitgeber überlebten den Wechsel
  // und schrieben danach Fehlermeldungen zu Geräten, die es hier nicht gibt.
  schirmWarten.reset();
  // Plugin-pro-Guild-Toggle-Cache liegt außerhalb der Store-Klassen.
  resetGuildPluginsCache();
  // Guild-member autocomplete cache — stale after server-switch / sign-out.
  memberListCache.clear();
}

/**
 * Leert die globale Social-Schicht (Cloud): Freunde/Requests/Blocks/DMs +
 * Freund-Presence. **Nur bei Sign-Out** — beim Server-Switch bleiben diese
 * Stores stehen (siehe `resetServerScopedStores`). Idempotent.
 */
export function resetSocialStores(): void {
  friends.clear();
  friendRequests.clear();
  communityInvites.clear();
  directStatus.clearAll();
  blocks.clear();
  directMessages.clear();
  presence.clear();
  // Nachrichten-Entwürfe sind Texte des Vorgängers — nur hier (Sign-Out/
  // Account-Wechsel) leeren, NICHT beim Server-Switch (resetServerScopedStores):
  // Entwürfe sollen Channel-/Server-Wechsel ja gerade überleben.
  drafts.clearAll();
}
