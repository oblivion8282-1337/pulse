/**
 * Guild + role lifecycle handlers: `guild_updated`, `guild_deleted`,
 * `role_created`, `role_updated`, `role_deleted`, `member_roles_updated`,
 * `guild_sound_updated`. Membership-side events (member added/removed,
 * bans, member_updated) live in `members.ts` to keep this module focused.
 */
import { guilds } from '$lib/stores/guilds.svelte';
import { messages } from '$lib/stores/messages.svelte';
import { roles } from '$lib/stores/roles.svelte';
import { memberRoles } from '$lib/stores/memberRoles.svelte';
import { currentServerUserId } from '$lib/stores/currentServerUser';
import { guildSounds } from '$lib/stores/guildSounds.svelte';
import {
  guildPluginActivation,
  setGuildPluginEnabled
} from '$lib/plugins/guild-activation.svelte';
import { registerWsHandler } from '../handler-registry';
import type { HandlerContext } from './context';

export function register(ctx: HandlerContext): void {
  registerWsHandler('guild_updated', (evt) => {
    if (guilds.byId[evt.guild.id]) guilds.updateGuild(evt.guild);
  });

  registerWsHandler('guild_deleted', (evt) => {
    if (!guilds.byId[evt.guild_id]) return;
    // Drop every WS subscription for channels in that guild — they're
    // gone server-side and would otherwise leak in `ctx.subs`. We walk
    // both `subs` *and* `channelsByGuild` because the former may contain
    // ids the client never navigated to (only got via WS push).
    const channelIds = new Set<string>(
      (guilds.channelsByGuild[evt.guild_id] ?? []).map((c) => c.id)
    );
    for (const subId of ctx.subs) {
      if (channelIds.has(subId)) ctx.unsubscribe(subId);
    }
    for (const id of channelIds) messages.clearChannel(id);
    guilds.remove(evt.guild_id);
    guildSounds.remove(evt.guild_id);
    ctx.fireGuildDeleted(evt.guild_id);
  });

  // role_created and role_updated share an implementation: upsertRole
  // does the right thing for both. We register them as two distinct
  // entries (rather than abusing fall-through) so a plugin can override
  // one without the other.
  const upsertRole = (evt: { role: Parameters<typeof roles.upsertRole>[0] }) => {
    roles.upsertRole(evt.role);
  };
  registerWsHandler('role_created', upsertRole);
  registerWsHandler('role_updated', upsertRole);

  registerWsHandler('role_deleted', (evt) => {
    roles.removeRole(evt.guild_id, evt.role_id);
  });

  registerWsHandler('member_roles_updated', (evt) => {
    // Only the target user's role list changed. If we are them, the
    // resolved-permissions store needs to re-pull. Invalidate the
    // lazy cache for this (guild, user) so the next access re-fetches
    // with the new state. Lazy loading will trigger if/when the
    // member list is actually rendered.
    if (currentServerUserId() === evt.user_id) {
      void roles.refreshMyRoles(evt.guild_id);
    }
    memberRoles.invalidate(evt.guild_id, evt.user_id);
  });

  // Guild-Admin hat ein Plugin auf der Guild getoggelt — oder der
  // Bootstrap-Admin hat es instanzweit deaktiviert (enabled=false).
  // Wenn die Guild bereits im Cache liegt, patchen wir den Slot
  // direkt (spart einen HTTP-Roundtrip + matcht den Optimistic-Path
  // im GuildPluginsEditor). Wenn die Guild noch NIE gemountet wurde,
  // ist der Slot leer — wir lassen ihn leer, damit das nächste
  // `ensureGuildPluginsLoaded` einmal komplett vom Server lädt, statt
  // einen lückenhaften Single-Plugin-Slot zu hinterlassen (der den
  // Cache-Check in `ensureGuildPluginsLoaded` als "schon geladen"
  // täuschen würde).
  registerWsHandler('guild_plugins_changed', (evt) => {
    const cached = guildPluginActivation.enabledByGuild[evt.guild_id];
    if (cached === undefined) return;
    setGuildPluginEnabled(evt.guild_id, evt.plugin_name, evt.enabled);
  });

  registerWsHandler('guild_sound_updated', (evt) => {
    // Either side could go silent if we don't refresh promptly — a stale
    // presigned URL still points at the old MinIO object (deletion
    // 4xxs) or just expires. Re-fetch the guild's full sound list:
    // /sounds is cheap (≤13 rows) and gives us all fresh URLs in one
    // call regardless of how many overrides changed at once.
    if (guilds.byId[evt.guild_id]) {
      void guildSounds.refresh(evt.guild_id);
    }
  });
}
