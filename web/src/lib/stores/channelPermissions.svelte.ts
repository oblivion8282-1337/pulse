/**
 * Channel-level permission overwrites + resolved per-channel permission
 * cache. Lazy: a channel's overwrites are fetched on first access (when
 * the user opens it or the settings dialog), then kept current via the
 * ``channel_permissions_updated`` WS event.
 */

import { overwritesApi, type Overwrite } from '$lib/api/roles';
import { auth } from './auth.svelte';
import { guilds } from './guilds.svelte';
import { roles } from './roles.svelte';
import {
  type Permission,
  has,
  resolveChannelPermissions,
  toBitfield
} from '$lib/permissions/bitfield';

class ChannelPermissionsStore {
  byChannel = $state<Record<string, Overwrite[]>>({});
  /** Fetched-once guard so concurrent callers don't double-fetch. */
  private _inflight = new Map<string, Promise<Overwrite[]>>();

  async ensure(channelId: string): Promise<Overwrite[]> {
    const cached = this.byChannel[channelId];
    if (cached) return cached;
    const inflight = this._inflight.get(channelId);
    if (inflight) return inflight;
    const p = overwritesApi
      .list(channelId)
      .then((rows) => {
        this.byChannel = { ...this.byChannel, [channelId]: rows };
        return rows;
      })
      .finally(() => {
        this._inflight.delete(channelId);
      });
    this._inflight.set(channelId, p);
    return p;
  }

  /** Replace the cached overwrites for ``channelId``. Called from the
   * WS handler when the server pushes a fresh list after a mutation. */
  apply(channelId: string, overwrites: Overwrite[]): void {
    this.byChannel = { ...this.byChannel, [channelId]: overwrites };
  }

  forget(channelId: string): void {
    if (!this.byChannel[channelId]) return;
    const next = { ...this.byChannel };
    delete next[channelId];
    this.byChannel = next;
  }

  /** Resolve the caller's bitfield for one channel. Falls back to
   * guild-level perms when no overwrites are cached — that's fine, it
   * matches what the resolver would compute with an empty overwrite
   * list. */
  resolveForUser(guildId: string, channelId: string): bigint {
    const me = auth.user?.id;
    if (!me) return 0n;
    const guild = guilds.byId[guildId];
    const isOwner = !!guild && guild.owner_id === me;
    const isAdmin = !!auth.user?.is_admin;
    const overwrites = (this.byChannel[channelId] ?? []).map((ow) => ({
      target_type: ow.target_type,
      target_id: ow.target_id,
      allow: toBitfield(ow.allow),
      deny: toBitfield(ow.deny)
    }));
    return resolveChannelPermissions({
      isGlobalAdmin: isAdmin,
      isOwner,
      isMember: !!guild,
      userId: me,
      roles: roles.snapshotsForUser(guildId),
      overwrites
    });
  }

  /** Predicate over the resolved cache. Convenience for UI gating
   * code that doesn't care about the raw bitfield. */
  hasChannelPermission(guildId: string, channelId: string, perm: Permission): boolean {
    return has(this.resolveForUser(guildId, channelId), perm);
  }

  clear(): void {
    this.byChannel = {};
    this._inflight.clear();
  }
}

export const channelPermissions = new ChannelPermissionsStore();
