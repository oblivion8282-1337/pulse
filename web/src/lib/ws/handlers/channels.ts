/**
 * Channel-lifecycle handlers: `channel_created`, `channel_updated`,
 * `channel_deleted`, `permissions_updated`, `channel_permissions_updated`.
 *
 * The deletion path also invokes the context hook so the
 * `/channels/[id]/+page.svelte` route can navigate away when the user is
 * actively viewing a freshly-deleted channel.
 */
import { guilds } from '$lib/stores/guilds.svelte';
import { messages } from '$lib/stores/messages.svelte';
import { capabilities } from '$lib/stores/capabilities.svelte';
import { channelPermissions } from '$lib/stores/channelPermissions.svelte';
import { registerWsHandler } from '../handler-registry';
import type { HandlerContext } from './context';

export function register(ctx: HandlerContext): void {
  registerWsHandler('channel_created', (evt) => {
    if (guilds.byId[evt.channel.guild_id]) guilds.addChannel(evt.channel);
  });

  registerWsHandler('channel_updated', (evt) => {
    if (guilds.byId[evt.channel.guild_id]) guilds.updateChannel(evt.channel);
  });

  registerWsHandler('channel_deleted', (evt) => {
    if (guilds.byId[evt.guild_id]) {
      guilds.removeChannel(evt.channel_id);
      ctx.unsubscribe(evt.channel_id);
      messages.clearChannel(evt.channel_id);
      ctx.fireChannelDeleted(evt.guild_id, evt.channel_id);
    }
  });

  registerWsHandler('permissions_updated', (evt) => {
    capabilities.apply({
      allow_guild_creation: evt.allow_guild_creation,
      allow_member_invites: evt.allow_member_invites,
      guild_sound_max_size_bytes: evt.guild_sound_max_size_bytes,
      hq_bitrate_min_kbps: evt.hq_bitrate_min_kbps,
      hq_bitrate_max_kbps: evt.hq_bitrate_max_kbps,
      hq_fps_min: evt.hq_fps_min,
      hq_fps_max: evt.hq_fps_max,
      hq_resolution_max: evt.hq_resolution_max
    });
  });

  registerWsHandler('channel_permissions_updated', (evt) => {
    channelPermissions.apply(evt.channel_id, evt.overwrites);
  });
}
