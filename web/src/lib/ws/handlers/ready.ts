/**
 * `ready` handler — seeds the Svelte stores from the initial frame and
 * triggers the gateway's buffer-flush via the context callback.
 *
 * Kept as a regular handler (not special-cased in the connection) so a
 * plugin can layer extra seeding on top (Phase 4): register a *second*
 * "ready" handler that runs after this one. The downside of `Map.set`
 * overwriting on duplicate keys is a non-issue because the connection
 * itself only calls `register` once during bootstrap.
 */
import { guilds } from '$lib/stores/guilds.svelte';
import { directMessages } from '$lib/stores/directMessages.svelte';
import { voicePresence } from '$lib/stores/voicePresence.svelte';
import { streamPresence } from '$lib/stores/streamPresence.svelte';
import { watchPartyPresence } from '$lib/stores/watchPartyPresence.svelte';
import { clockSync } from '$lib/watch/clockSync';
import { presence } from '$lib/stores/presence.svelte';
import { friends } from '$lib/stores/friends.svelte';
import { friendRequests } from '$lib/stores/friendRequests.svelte';
import { communityInvites } from '$lib/stores/communityInvites.svelte';
import { blocks } from '$lib/stores/blocks.svelte';
import { privacy } from '$lib/stores/privacy.svelte';
import { roles } from '$lib/stores/roles.svelte';
import { Perm } from '$lib/permissions/bitfield';
import { modQueueCounts } from '$lib/stores/modQueueCounts.svelte';
import { guildSounds } from '$lib/stores/guildSounds.svelte';
import { serverAdmin } from '$lib/stores/serverAdmin.svelte';
import { serversStore } from '$lib/api/servers.svelte';
import { serverUser } from '$lib/stores/serverUser.svelte';
import { activeServer } from '$lib/stores/active-server.svelte';
import { registerWsHandler } from '../handler-registry';
import type { ReadyStamps } from '../gateway-connection';
import type { ReadyEvent } from './types';
import type { Guild } from '$lib/api/types';

/** Extra context fields that only the ready handler cares about — kept
 *  separate from `HandlerContext` so other handlers don't see them. */
export type ReadyContext = {
  /** Called once the store seeding is done. The gateway uses it to
   *  resolve `waitForReady()` and replay any buffered events. */
  onReadySeeded: () => void;
};

export function register(ctx: ReadyContext): void {
  registerWsHandler('ready', (evt) => {
    // Global-Friends Stufe 1 — der ready-Frame ist gesplittet:
    //  - SERVER-Teil (guilds/roles/sounds/voice/stream/watch/guild-presence/
    //    clock) gilt nur, wenn DIESE Connection die **aktive** ist.
    //  - SOCIAL-Teil (friends/dm_channels/friend_requests/blocks/eigener
    //    Presence-Status) gilt nur, wenn DIESE Connection die **Cloud** ist.
    // Cloud==aktiv → beide Teile (heutiges Verhalten unverändert). Self-Host
    // aktiv → Server-Teil vom Self-Host-ready + Social-Teil vom Cloud-
    // Background-ready. Die Flags stempelt `gateway-connection._handle`
    // synchron vor dem Dispatch auf das (lokale, nie über die Leitung
    // gesendete) ready-Event.
    const stamped = evt as ReadyEvent & ReadyStamps;
    // Default true (back-compat): ältere/gemockte Frames ohne Stempel werden
    // wie früher behandelt — beides anwenden (entspricht Cloud==aktiv).
    const isActive = stamped._isActive ?? true;
    const isCloud = stamped._isCloud ?? true;

    if (isActive) {
      // ---- SERVER-Teil (aktiv-only) ------------------------------------
      // The Ready frame is the single source of truth for the guild list —
      // `+layout.svelte` no longer fires a parallel `GET /guilds`. We upsert
      // each guild (so a reconnect picks up renames/icon-changes that
      // happened while we were offline) and reap stale entries that are no
      // longer in the user's set. Lifecycle events that arrived before Ready
      // are still replayed from the pre-ready buffer.
      const seen = new Set<string>();
      for (const g of evt.guilds) {
        seen.add(g.id);
        const existing = guilds.byId[g.id];
        guilds.byId[g.id] = {
          ...(existing ?? {}),
          ...g,
          icon_url: g.icon_url ?? existing?.icon_url ?? null,
          created_at: g.created_at ?? existing?.created_at ?? '',
          owner_id: g.owner_id ?? existing?.owner_id ?? ''
        } as Guild;
      }
      for (const gid of Object.keys(guilds.byId)) {
        if (!seen.has(gid)) guilds.remove(gid);
      }
      guilds.loaded = true;
      // The role payload is part of the ready envelope, not REST, so it's
      // populated here (the hydrate() pass on the REST side does not return
      // roles — they only come from /guilds/{id}/roles or this frame).
      roles.seedFromReady(evt.guilds);
      guildSounds.seedFromReady(evt.guilds);
      // Offene-Meldungen-Badge: für jede Community, in der wir moderieren, den
      // Zähler laden. MUSS nach roles.seedFromReady laufen (hasGuildPermission
      // braucht die frisch geseedeten Rollen). Nicht-Mod-Guilds werden nicht
      // abgefragt (der Count-Endpoint würde 403en).
      const modGuildIds = evt.guilds
        .filter(
          (g) =>
            roles.hasGuildPermission(g.id, Perm.MANAGE_MESSAGES) ||
            roles.hasGuildPermission(g.id, Perm.BAN_MEMBERS) ||
            roles.hasGuildPermission(g.id, Perm.MANAGE_GUILD)
        )
        .map((g) => g.id);
      void modQueueCounts.hydrate(modGuildIds);
      if (evt.voice_states) voicePresence.seed(evt.voice_states);
      voicePresence.seedOverrides(evt.voice_overrides ?? []);
      streamPresence.seed(evt.stream_states ?? []);
      watchPartyPresence.seed(evt.watch_states ?? []);
      // Calibrate the watch-party clock offset on connect so position
      // extrapolation uses the server clock from the first frame on.
      if (typeof evt.server_now === 'number') clockSync.record(evt.server_now);
      // Guild-Presence (wer ist auf DIESEM Server online) bleibt server-lokal.
      presence.seed(evt.online_user_ids ?? []);
    }

    if (isCloud) {
      // ---- SOCIAL-Teil (Cloud-only) ------------------------------------
      // Globale Freunde/DMs/Requests/Blocks kommen ausschließlich aus dem
      // Cloud-ready. All fields optional for back-compat with older mocked
      // ready frames; we fall through to clean defaults when absent.
      if (evt.dm_channels) directMessages.seed(evt.dm_channels);
      friends.seedAll(evt.friends ?? []);
      friendRequests.seedAll({
        incoming: evt.friend_requests_in ?? [],
        outgoing: evt.friend_requests_out ?? []
      });
      communityInvites.seedAll(evt.community_invites ?? []);
      blocks.seedAll(evt.blocked_user_ids ?? []);
      if (evt.privacy) privacy.seed(evt.privacy);
      // Own presence status + the friend-presence status map come from the
      // Cloud. Seeded on every reconnect so stale entries from a previous
      // session are cleared; absent fields reset to the 'online'/offline
      // defaults.
      presence.seedStatuses(
        evt.user_presence_statuses ?? {},
        evt.presence_status ?? 'online'
      );
      // Cloud-global: den Freundes-Präsenz-Topf setzen. Getrennt vom
      // aktiven-Server-Set (Zeile ~97, isActive) — ein Self-Host-ready darf die
      // Freundes-Präsenz nicht überschreiben. Nur die Cloud befüllt ihn.
      presence.seedFriends(evt.online_user_ids ?? []);
      presence.seedFriendStatuses(evt.user_presence_statuses ?? {});
    }

    // Per-server admin + per-server user id are bound to the DISPATCHING
    // server (active OR cloud-background), so they're applied for both ready
    // variants. The id of *this* server's account — Cloud id and self-host id
    // differ, so "is this mine?" checks must use serverUser, not auth.user.id.
    const sid = stamped._serverId ?? activeServer.current?.id;
    if (sid) {
      serverAdmin.set(sid, evt.is_admin ?? false);
      serverUser.set(sid, evt.user_id);
      // Instanzweiter Anzeigename vom Server-Admin → als Default-Name dieses
      // Servers cachen (greift nur, wenn der User keinen eigenen vergeben hat;
      // s. serverDisplayName). null überschreibt einen stale Namen bewusst.
      serversStore.update(sid, { server_name: evt.instance_name ?? null });
    }
    ctx.onReadySeeded();
  });
}
