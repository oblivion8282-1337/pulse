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
import { rolesApi } from '$lib/api/roles';
import { memberListCache } from '$lib/components/MentionAutocomplete.svelte';
import { toast } from 'svelte-sonner';
import { m } from '$lib/paraglide/messages.js';
import { joinGuildByInvite } from '$lib/guilds/joinByInvite';
import { registerWsHandler } from '../handler-registry';
import type { HandlerContext } from './context';

/** "Wieder beitreten" aus dem Entbann-Hinweis: löst die mitgelieferte
 *  Einladung über den kanonischen Beitritts-Fluss ein. Der hydratisiert die
 *  Community aktiv in den Store (guilds.hydrate + Rollen + Sounds) und
 *  navigiert hinein — anders als ein blankes ``acceptInvite``, das sich aufs
 *  WS-Ereignis verlässt, das der frisch beigetretene Client evtl. gar nicht
 *  mehr durchgereicht bekommt (Grund, warum die Community vorher ausblieb). */
async function rejoinViaInvite(code: string, guildName: string): Promise<void> {
  try {
    await joinGuildByInvite(code);
    toast.success(m.mod_unban_rejoin_success({ guild: guildName }));
  } catch (e) {
    toast.error(m.mod_unban_rejoin_failed(), {
      description: e instanceof Error ? e.message : String(e)
    });
  }
}

export function register(ctx: HandlerContext): void {
  registerWsHandler('guild_member_removed', (evt) => {
    // Mitgliederliste dieser Guild hat sich geändert → den @-Mention-
    // Autocomplete-Cache verwerfen, sonst schlägt er ausgetretene/neue/
    // umbenannte Mitglieder bis zum nächsten Reconnect veraltet vor.
    memberListCache.invalidate(evt.guild_id);
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
    memberListCache.invalidate(evt.guild_id);
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
          rolesApi
            .list(evt.guild_id)
            .then((rows) => {
              for (const r of rows) roles.upsertRole(r);
              roles.recomputeGuild(evt.guild_id);
            })
            .catch(() => undefined);
        })
        .catch(() => undefined);
    }
  });

  // No state-store change — open settings components re-fetch via their
  // own gateway.on subscriptions. Register as no-ops so the dispatcher's
  // "unknown op" warning doesn't fire.
  registerWsHandler('guild_ban_added', () => undefined);
  registerWsHandler('guild_ban_removed', () => undefined);

  // Direkt an DICH gerichtet: du wurdest gebannt/gekickt. Die Community-
  // Aufräumung läuft schon über `guild_member_removed`; hier nur der
  // dauerhafte Hinweis, damit die Community nicht kommentarlos verschwindet.
  registerWsHandler('guild_membership_revoked', (evt) => {
    // Auto-dismiss: the durable record is the moderation DM in the user's
    // inbox — the toast is just an immediate heads-up, so it shouldn't linger.
    if (evt.kind === 'ban') {
      const base = m.mod_ban_notice_body({ guild: evt.guild_name });
      toast.error(m.mod_ban_notice_title(), {
        description: evt.reason
          ? `${base} ${m.mod_ban_notice_reason({ reason: evt.reason })}`
          : base,
        duration: 10000
      });
    } else {
      toast.info(m.mod_kick_notice_title(), {
        description: m.mod_kick_notice_body({ guild: evt.guild_name }),
        duration: 10000
      });
    }
  });

  // Deine Sperre wurde aufgehoben → Hinweis mit Ein-Klick-„Wieder beitreten"
  // (die mitgelieferte Einladung spart das Erbetteln einer neuen).
  registerWsHandler('guild_ban_lifted', (evt) => {
    toast.success(m.mod_unban_notice_title(), {
      description: m.mod_unban_notice_body({ guild: evt.guild_name }),
      // Generous but finite — long enough to notice + hit "rejoin", but it
      // shouldn't stick around forever (there's no durable fallback here).
      duration: 30000,
      action: {
        label: m.mod_unban_notice_rejoin(),
        onClick: () => void rejoinViaInvite(evt.invite_code, evt.guild_name)
      }
    });
  });
  // Nickname/Avatar-Änderung eines Mitglieds → Autocomplete-Cache verwerfen,
  // damit @-Vorschläge den neuen Namen zeigen (sonst stale bis Reconnect).
  registerWsHandler('guild_member_updated', (evt) => {
    memberListCache.invalidate(evt.guild_id);
  });
}
