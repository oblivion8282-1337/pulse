/**
 * Membership / ban handlers: `guild_member_added`, `guild_member_removed`,
 * `guild_ban_added`, `guild_ban_removed`, `guild_member_updated`.
 *
 * `member_removed` mirrors the `guild_deleted` cleanup path when the
 * kicked user is us. The bans + member_updated cases are no-ops in the
 * dispatcher: open MemberList / BansList components subscribe via
 * `gateway.on()` directly and refetch themselves.
 */
import { guilds } from '$lib/stores/guilds.svelte';
import { messages } from '$lib/stores/messages.svelte';
import { currentServerUserId } from '$lib/stores/currentServerUser';
import { guildSounds } from '$lib/stores/guildSounds.svelte';
import { roles } from '$lib/stores/roles.svelte';
import { chatApi } from '$lib/api/chat';
import { registerWsHandler } from '../handler-registry';
import type { HandlerContext } from './context';

export function register(ctx: HandlerContext): void {
  registerWsHandler('guild_member_removed', (evt) => {
    if (evt.user_id === currentServerUserId()) {
      // The kicked user is us. Drop the guild locally — mirrors the
      // ``guild_deleted`` cleanup path (subscriptions, messages,
      // navigation hook). The WS itself isn't force-closed; the next
      // membership-gated REST call will 403 naturally.
      if (guilds.byId[evt.guild_id]) {
        const channelIds = new Set<string>(
          (guilds.channelsByGuild[evt.guild_id] ?? []).map((c) => c.id)
        );
        for (const subId of ctx.subs) {
          if (channelIds.has(subId)) ctx.unsubscribe(subId);
        }
        for (const id of channelIds) messages.clearChannel(id);
        guilds.remove(evt.guild_id);
        ctx.fireGuildDeleted(evt.guild_id);
      }
    }
    // Either way, an open MemberList re-renders via its local
    // gateway.on listener (which re-fetches on this op).
  });

  registerWsHandler('guild_member_added', (evt) => {
    if (evt.user_id === currentServerUserId()) {
      // We just joined a guild on another tab / via an invite — fetch it
      // so this WS session starts tracking it (voice presence, channel
      // lifecycle, role list, sound overrides). Best-effort.
      guildSounds.ensureSlot(evt.guild_id);
      void guildSounds.refresh(evt.guild_id);
      // Fetch the single guild instead of hydrating the entire list.
      void chatApi
        .getGuild(evt.guild_id)
        .then((guild) => {
          guilds.add(guild);
          return guilds.loadChannels(evt.guild_id);
        })
        .then(() => {
          // Pull the role list + recompute resolved perms — without this
          // the UI gates stay locked until the next WS reconnect.
          import('$lib/api/roles').then(({ rolesApi }) => {
            rolesApi
              .list(evt.guild_id)
              .then((rows) => {
                for (const r of rows) roles.upsertRole(r);
                roles.recomputeGuild(evt.guild_id);
              })
              .catch(() => undefined);
          });
        })
        .catch(() => undefined);
    }
  });

  // No state-store change — open settings components re-fetch via their
  // own gateway.on subscriptions. Register as no-ops so the dispatcher's
  // "unknown op" warning doesn't fire.
  registerWsHandler('guild_ban_added', () => undefined);
  registerWsHandler('guild_ban_removed', () => undefined);
  registerWsHandler('guild_member_updated', () => undefined);
}
