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
import { blocks } from '$lib/stores/blocks.svelte';
import { privacy } from '$lib/stores/privacy.svelte';
import { roles } from '$lib/stores/roles.svelte';
import { guildSounds } from '$lib/stores/guildSounds.svelte';
import { serverAdmin } from '$lib/stores/serverAdmin.svelte';
import { activeServer } from '$lib/stores/active-server.svelte';
import { registerWsHandler } from '../handler-registry';
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
    // The Ready frame is now the single source of truth for the guild
    // list — `+layout.svelte` no longer fires a parallel `GET /guilds`.
    // We upsert each guild (so a reconnect picks up renames/icon-changes
    // that happened while we were offline) and reap stale entries that
    // are no longer in the user's set (e.g. removed from a guild during
    // the disconnect). Lifecycle events that arrived before Ready are
    // still replayed below from the pre-ready buffer.
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
    if (evt.dm_channels) directMessages.seed(evt.dm_channels);
    if (evt.voice_states) voicePresence.seed(evt.voice_states);
    voicePresence.seedOverrides(evt.voice_overrides ?? []);
    streamPresence.seed(evt.stream_states ?? []);
    watchPartyPresence.seed(evt.watch_states ?? []);
    // Calibrate the watch-party clock offset on connect so position
    // extrapolation uses the server clock from the first frame on.
    if (typeof evt.server_now === 'number') clockSync.record(evt.server_now);
    presence.seed(evt.online_user_ids ?? []);
    // Etappe 4 friend-system seeding. All fields optional in the
    // ready frame for back-compat with older mocked tests; we fall
    // through to clean defaults when absent.
    friends.seedAll(evt.friends ?? []);
    friendRequests.seedAll({
      incoming: evt.friend_requests_in ?? [],
      outgoing: evt.friend_requests_out ?? []
    });
    blocks.seedAll(evt.blocked_user_ids ?? []);
    if (evt.privacy) privacy.seed(evt.privacy);
    // Always seed statuses on every reconnect so stale entries from a previous
    // session are cleared. When the fields are absent (back-compat / mocked
    // frames) the empty map and 'online' default reset all statuses to 'offline'.
    presence.seedStatuses(
      evt.user_presence_statuses ?? {},
      evt.presence_status ?? 'online'
    );
    // Per-server admin status (drives the admin-panel gate for the active
    // server — esp. self-hosts, where there's no auth-svc /me). Absent in
    // older/mocked frames → treat as non-admin.
    const sid = activeServer.current?.id;
    if (sid) serverAdmin.set(sid, evt.is_admin ?? false);
    ctx.onReadySeeded();
  });
}
