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

  seedFromReady(
    entries: {
      id: string;
      roles?: Role[];
      my_role_ids?: string[];
      my_permissions?: string;
    }[]
  ): void {
    const nextRoles: Record<string, Role[]> = {};
    const nextMy: Record<string, string[]> = {};
    const nextPerms: Record<string, string> = {};
    for (const e of entries) {
      if (e.roles) nextRoles[e.id] = e.roles;
      if (e.my_role_ids) nextMy[e.id] = e.my_role_ids;
      if (e.my_permissions !== undefined) nextPerms[e.id] = e.my_permissions;
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
    const isOwner = !!guild && guild.owner_id === me;
    const isAdmin = !!auth.user?.is_admin;
    if (isOwner || isAdmin) {
      this.myGuildPerms = { ...this.myGuildPerms, [guildId]: GRANT_ALL_SAFE.toString() };
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
    const value = resolveGuildPermissions({
      isGlobalAdmin: isAdmin,
      isOwner,
      isMember: !!guild,
      userId: me,
      roles: snapshots,
      overwrites: []
    });
    this.myGuildPerms = { ...this.myGuildPerms, [guildId]: value.toString() };
  }

  /** Returns the snapshot list the channel-permission resolver needs
   * (only the caller's roles, with @everyone included). Pulled by the
   * channel-permissions store; kept here so the role logic stays
   * co-located. */
  snapshotsForUser(guildId: string): RoleSnapshot[] {
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
    const value = this.myGuildPerms[guildId];
    if (!value) return false;
    return has(toBitfield(value), perm);
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
  }
}

export const roles = new RoleStore();
export { Perm } from '$lib/permissions/bitfield';
