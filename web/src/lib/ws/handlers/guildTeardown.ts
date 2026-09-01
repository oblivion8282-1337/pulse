import { guilds } from '$lib/stores/guilds.svelte';
import { messages } from '$lib/stores/messages.svelte';
import { guildSounds } from '$lib/stores/guildSounds.svelte';
import type { HandlerContext } from './context';

/** Lokaler Guild-Teardown, geteilt von `guild_deleted` (guild.ts) und dem
 *  kicked-Pfad in `guild_member_removed` (members.ts). Raeumt WS-Subscriptions
 *  der Guild-Kanäle, deren Messages und den Sound-Slot ab — der kicked-Pfad
 *  räumte Sounds bisher nicht ab (Duplikat-Drift, hiermit gefixt). */
export function teardownGuildLocally(guildId: string, ctx: HandlerContext): void {
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
  for (const id of channelIds) messages.clearChannel(id);
  guilds.remove(guildId);
  guildSounds.remove(guildId);
  ctx.fireGuildDeleted(guildId);
}
