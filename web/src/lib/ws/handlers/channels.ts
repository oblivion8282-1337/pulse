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
import { readState } from '$lib/stores/readState.svelte';
import { registerWsHandler } from '../handler-registry';
import type { HandlerContext } from './context';

export function register(ctx: HandlerContext): void {
  // Full local teardown for a channel the user no longer sees — used by
  // channel_deleted (server removed it) and channel_hidden (voice-pull
  // grant revoked). Guarded by guild membership so events for guilds the
  // user has left are ignored.
  function teardownChannel(guildId: string, channelId: string): void {
    if (!guilds.byId[guildId]) return;
    guilds.removeChannel(channelId);
    ctx.unsubscribe(channelId);
    messages.clearChannel(channelId);
    channelPermissions.forget(channelId);
    readState.forgetChannel(channelId);
    ctx.fireChannelDeleted(guildId, channelId);
  }

  registerWsHandler('channel_created', (evt) => {
    if (guilds.byId[evt.channel.guild_id]) guilds.addChannel(evt.channel);
  });

  registerWsHandler('channel_updated', (evt) => {
    if (guilds.byId[evt.channel.guild_id]) guilds.updateChannel(evt.channel);
  });

  registerWsHandler('channel_deleted', (evt) => {
    teardownChannel(evt.guild_id, evt.channel_id);
  });

  // Voice-pull grant added: a previously-hidden channel is now visible to
  // this one user. Same insert as channel_created (idempotent).
  registerWsHandler('channel_revealed', (evt) => {
    if (guilds.byId[evt.channel.guild_id]) guilds.addChannel(evt.channel);
  });

  // Voice-pull grant revoked (user left the channel): the channel leaves
  // this user's view — same local teardown as channel_deleted.
  registerWsHandler('channel_hidden', (evt) => {
    teardownChannel(evt.guild_id, evt.channel_id);
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
      hq_resolution_max: evt.hq_resolution_max,
      ns_bitrate_min_kbps: evt.ns_bitrate_min_kbps,
      ns_bitrate_max_kbps: evt.ns_bitrate_max_kbps,
      ns_fps_min: evt.ns_fps_min,
      ns_fps_max: evt.ns_fps_max,
      ns_resolution_max: evt.ns_resolution_max,
      cam_resolution_max: evt.cam_resolution_max,
      cam_fps_max: evt.cam_fps_max
    });
  });

  registerWsHandler('channel_permissions_updated', (evt) => {
    channelPermissions.apply(evt.channel_id, evt.overwrites);
    // Keep the sidebar lock indicator live: the event carries the
    // server-computed flag (merge-update preserves all other fields).
    if (guilds.byId[evt.guild_id]) {
      guilds.updateChannel({
        id: evt.channel_id,
        guild_id: evt.guild_id,
        restricted: evt.restricted
      });
    }
  });
}
