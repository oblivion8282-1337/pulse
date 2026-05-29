/**
 * Roles + resolved-permission state.
 *
 * Seeded from the ready frame (guild list carries `roles[]`,
 * `my_role_ids[]`, and `my_permissions` per guild) and kept current via
 * the `role_created` / `role_updated` / `role_deleted` /
 * `member_roles_updated` WS events. Channel-level overwrites live in
 * ``channelPermissions.svelte.ts`` — they're lazy-loaded per channel
 * rather than eager-fetched into ready.
 */

import { rolesApi, type Role } from '$lib/api/roles';
import { auth } from './auth.svelte';
import { guilds } from './guilds.svelte';
import { activeServer } from './active-server.svelte';
import { serverAdmin } from './serverAdmin.svelte';
import {
  GRANT_ALL_SAFE,
  Perm,
  type Permission,
  type RoleSnapshot,
  has,
  resolveGuildPermissions,
  toBitfield
} from '$lib/permissions/bitfield';

class RoleStore {
  /** Roles per guild, including the implicit @everyone row. */
  byGuild = $state<Record<string, Role[]>>({});
  /** Role-IDs the current user holds, per guild. @everyone is implicit
   * and NOT included here — the resolver pulls it from ``byGuild``. */
  myRoleIds = $state<Record<string, string[]>>({});
  /** Resolved guild-wide permission bitfield for the current user. As a
   * string so reactivity doesn't compare bigints. */
  myGuildPerms = $state<Record<string, string>>({});
  /** Parsed-bigint cache for hasGuildPermission — avoids re-parsing the
   * string on every reactive read. Kept in sync via _setGuildPerm(). */
  private _permBigInt = new Map<string, bigint>();
  /** Memoised RoleSnapshot[] per guild — computed once in recomputeGuild
   * (and seedFromReady-triggered recomputes) so snapshotsForUser() is a
   * cheap cache read instead of a filter+map+toBitfield on every call. */
  private _snapshotsCache = new Map<string, RoleSnapshot[]>();
  /** Flat role-id → Role map across ALL guilds for O(1) lookups (e.g.
   * roleMentionLabel in messageRender.ts). Maintained by upsertRole() and
   * removeRole() so callers never need to iterate byGuild. */
  roleIdMap = new Map<string, Role>();

  seedFromReady(
    entries: {
      id: string;
      roles?: Role[];
      my_role_ids?: string[];
      my_permissions?: string;
    }[]
  ): void {
    // Merge per-guild — never wipe a guild's slot just because the ready
    // frame omitted its field. Older mocks / partial payloads / WS-role
    // events that ran before ready would otherwise vanish silently. We
    // also use this as the merge point for events buffered out of order
    // (ws/connection.ts now flushes pre-ready role events through here).
    const nextRoles: Record<string, Role[]> = { ...this.byGuild };
    const nextMy: Record<string, string[]> = { ...this.myRoleIds };
    const nextPerms: Record<string, string> = { ...this.myGuildPerms };
    for (const e of entries) {
      if (e.roles) {
        nextRoles[e.id] = e.roles;
        for (const r of e.roles) this.roleIdMap.set(r.id, r);
      }
      if (e.my_role_ids) nextMy[e.id] = e.my_role_ids;
      if (e.my_permissions !== undefined) {
        nextPerms[e.id] = e.my_permissions;
        this._permBigInt.set(e.id, toBitfield(e.my_permissions));
      }
    }
    this.byGuild = nextRoles;
    this.myRoleIds = nextMy;
    this.myGuildPerms = nextPerms;
  }

  upsertRole(role: Role): void {
    const list = this.byGuild[role.guild_id] ?? [];
    const next = list.some((r) => r.id === role.id)
      ? list.map((r) => (r.id === role.id ? role : r))
      : [...list, role];
    this.byGuild = { ...this.byGuild, [role.guild_id]: next };
    this.roleIdMap.set(role.id, role);
    // The role's permissions may now affect my resolved guild perms.
    this.recomputeGuild(role.guild_id);
  }

  removeRole(guildId: string, roleId: string): void {
    const list = this.byGuild[guildId];
    if (!list) return;
    this.byGuild = {
      ...this.byGuild,
      [guildId]: list.filter((r) => r.id !== roleId)
    };
    this.roleIdMap.delete(roleId);
    const mine = this.myRoleIds[guildId];
    if (mine?.includes(roleId)) {
      this.myRoleIds = {
        ...this.myRoleIds,
        [guildId]: mine.filter((id) => id !== roleId)
      };
    }
    this.recomputeGuild(guildId);
  }

  /** Refresh the caller's own role list for a guild. Triggered by
   * `member_roles_updated` events that target the current user.
   * Backend pushes only "something changed for this (guild, user)" — we
   * re-fetch to learn what specifically. */
  async refreshMyRoles(guildId: string): Promise<void> {
    const me = auth.user?.id;
    if (!me) return;
    try {
      const rows = await rolesApi.listMemberRoles(guildId, me);
      this.myRoleIds = {
        ...this.myRoleIds,
        [guildId]: rows.map((r) => r.id)
      };
      this.recomputeGuild(guildId);
    } catch {
      /* swallow: WS will retry on the next event */
    }
  }

  /** Force a fresh resolver run for a guild. Called after any local
   * mutation that could change the caller's resolved perms; cheaper
   * than waiting for a round-trip to `/permissions/me`. */
  recomputeGuild(guildId: string): void {
    const me = auth.user?.id;
    if (!me) return;
    const guild = guilds.byId[guildId];
    const isOwner = !!guild && !!guild.owner_id && guild.owner_id === me;
    // Admin is per-server: cloud → auth.user.is_admin; self-host → serverAdmin
    // (cert-login users have no auth /me on self-host).
    const srv = activeServer.current;
    const isAdmin = srv?.isCloud
      ? !!auth.user?.is_admin
      : serverAdmin.isAdmin(activeServer.serverId);
    if (isOwner || isAdmin) {
      this._snapshotsCache.delete(guildId);
      this._setGuildPerm(guildId, GRANT_ALL_SAFE);
      return;
    }
    const allRoles = this.byGuild[guildId] ?? [];
    const mine = new Set(this.myRoleIds[guildId] ?? []);
    const snapshots: RoleSnapshot[] = allRoles
      .filter((r) => r.is_everyone || mine.has(r.id))
      .map((r) => ({
        id: r.id,
        position: r.position,
        permissions: toBitfield(r.permissions),
        is_everyone: r.is_everyone
      }));
    // Cache the snapshot list so snapshotsForUser() can skip the
    // filter+map+toBitfield on every channel-permission read.
    this._snapshotsCache.set(guildId, snapshots);
    const value = resolveGuildPermissions({
      isGlobalAdmin: isAdmin,
      isOwner,
      isMember: !!guild,
      userId: me,
      roles: snapshots,
      overwrites: []
    });
    this._setGuildPerm(guildId, value);
  }

  /** Set guild perm string + bigint cache atomically. */
  private _setGuildPerm(guildId: string, value: bigint): void {
    this._permBigInt.set(guildId, value);
    this.myGuildPerms = { ...this.myGuildPerms, [guildId]: value.toString() };
  }

  /** Returns the snapshot list the channel-permission resolver needs
   * (only the caller's roles, with @everyone included). Pulled by the
   * channel-permissions store; kept here so the role logic stays
   * co-located.
   *
   * Returns the cached snapshot built in recomputeGuild() when available,
   * avoiding repeated filter+map+toBitfield on every channel-perm read. */
  snapshotsForUser(guildId: string): RoleSnapshot[] {
    const cached = this._snapshotsCache.get(guildId);
    if (cached) return cached;
    // Fallback for guilds not yet recomputed (e.g. during early hydration).
    const all = this.byGuild[guildId] ?? [];
    const mine = new Set(this.myRoleIds[guildId] ?? []);
    return all
      .filter((r) => r.is_everyone || mine.has(r.id))
      .map((r) => ({
        id: r.id,
        position: r.position,
        permissions: toBitfield(r.permissions),
        is_everyone: r.is_everyone
      }));
  }

  /** Convenience: does the caller hold ``perm`` at guild scope? */
  hasGuildPermission(guildId: string, perm: Permission): boolean {
    // Use the pre-parsed bigint cache to avoid BigInt(string) on every
    // reactive read. Falls back to parsing myGuildPerms if the cache slot
    // is missing (e.g. seeded by an older code path).
    const cached = this._permBigInt.get(guildId);
    const value = cached ?? (this.myGuildPerms[guildId] ? toBitfield(this.myGuildPerms[guildId]) : null);
    if (value === null) return false;
    return has(value, perm);
  }

  /** Highest-position role with a non-null color among the given ids,
   * scoped to one guild. Returned null when no such role exists — the
   * caller should fall back to a default member colour. */
  topColorRole(guildId: string, roleIds: readonly string[]) {
    const all = this.byGuild[guildId];
    if (!all || roleIds.length === 0) return null;
    const set = new Set(roleIds);
    let best: { position: number; color: number } | null = null;
    for (const r of all) {
      if (!set.has(r.id) || r.color == null) continue;
      if (!best || r.position > best.position) {
        best = { position: r.position, color: r.color };
      }
    }
    return best;
  }

  /** Highest-position role with ``hoist=true`` among the given ids.
   * Used by the member list to group hoisted members under their
   * top-most hoist role. Returns null when no hoist role applies. */
  topHoistRole(guildId: string, roleIds: readonly string[]) {
    const all = this.byGuild[guildId];
    if (!all || roleIds.length === 0) return null;
    const set = new Set(roleIds);
    let best: { id: string; name: string; position: number } | null = null;
    for (const r of all) {
      if (!set.has(r.id) || !r.hoist) continue;
      if (!best || r.position > best.position) {
        best = { id: r.id, name: r.name, position: r.position };
      }
    }
    return best;
  }

  clear(): void {
    this.byGuild = {};
    this.myRoleIds = {};
    this.myGuildPerms = {};
    this._permBigInt.clear();
    this._snapshotsCache.clear();
    this.roleIdMap.clear();
  }
}

export const roles = new RoleStore();
export { Perm } from '$lib/permissions/bitfield';
