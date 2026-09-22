import { guilds } from '$lib/stores/guilds.svelte';
import { roles } from '$lib/stores/roles.svelte';
import { joinedInvites } from '$lib/stores/joinedInvites.svelte';
import { messages } from '$lib/stores/messages.svelte';
import { guildSounds } from '$lib/stores/guildSounds.svelte';
import { readState } from '$lib/stores/readState.svelte';
import { channelPermissions } from '$lib/stores/channelPermissions.svelte';
import type { HandlerContext } from './context';

/** Lokaler Guild-Teardown, geteilt von `guild_deleted` (guild.ts) und dem
 *  kicked-Pfad in `guild_member_removed` (members.ts). Raeumt WS-Subscriptions
 *  der Guild-Kanäle, deren Messages und den Sound-Slot ab — der kicked-Pfad
 *  räumte Sounds bisher nicht ab (Duplikat-Drift, hiermit gefixt). */
// Bughunt Runde 43: bewusst nur der tatsächlich genutzte Schnitt — der
// Ready-Stale-Sweep ruft den Teardown mit einem Partial-Kontext an.
export function teardownGuildLocally(
  guildId: string,
  ctx: Pick<HandlerContext, 'subs' | 'unsubscribe' | 'fireGuildDeleted'>
): void {
  // Drop every WS subscription for channels in that guild — they're
  // gone server-side and would otherwise leak in `ctx.subs`. We walk
  // both `subs` *and* `channelsByGuild` because the former may contain
  // ids the client never navigated to (only got via WS push).
  const channelIds = new Set<string>(
    (guilds.channelsByGuild[guildId] ?? []).map((c) => c.id)
  );
  for (const subId of ctx.subs) {
    if (channelIds.has(subId)) ctx.unsubscribe(subId);
  }
  for (const id of channelIds) {
    messages.clearChannel(id);
    // Bughunt Runde 5: dieselbe Räumung wie im channel_deleted-Pfad
    // (teardownChannel) — sonst leben lastRead/mentions/unread in den
    // localStorage-Karten und die Overwrite-Caches über die Entity hinaus.
    readState.forgetChannel(id);
    channelPermissions.forget(id);
  }
  guilds.remove(guildId);
  guildSounds.remove(guildId);
  // Bughunt Runde 49: Rollen-/Rechte-Restposten der toten Guild — sonst
  // blieb hasGuildPermission(gekickteGuildId, …) bis zum Reload true.
  roles.removeGuild(guildId);
  // Bughunt Runde 4: die Join-Marker dieser Community mit — sonst zeigt
  // die Einladungs-Karte dem Ausgetretenen dauerhaft „Beigetreten".
  joinedInvites.entfernenFuerGuild(guildId);
  ctx.fireGuildDeleted(guildId);
}
