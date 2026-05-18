/**
 * Roles + permission overwrites + owner transfer.
 *
 * Wire format ships every bitfield as a string (snowflake-style) — see
 * ``permissions/bitfield.ts`` for the rationale. This module deals in
 * strings; the caller converts via ``toBitfield`` only at the resolver
 * boundary.
 */

import { request } from './client';

export type Role = {
  id: string;
  guild_id: string;
  name: string;
  /** Bitfield as a snowflake-style string (BigInt-safe). */
  permissions: string;
  color: number | null;
  position: number;
  hoist: boolean;
  mentionable: boolean;
  is_everyone: boolean;
};

export type Overwrite = {
  target_type: 0 | 1;
  target_id: string;
  allow: string;
  deny: string;
};

export type RoleCreatePayload = {
  name: string;
  permissions?: string;
  color?: number | null;
  hoist?: boolean;
  mentionable?: boolean;
};

export type RolePatchPayload = {
  name?: string;
  permissions?: string;
  color?: number | null;
  hoist?: boolean;
  mentionable?: boolean;
};

export const rolesApi = {
  list(guildId: string): Promise<Role[]> {
    return request<Role[]>(`/guilds/${guildId}/roles`);
  },
  create(guildId: string, payload: RoleCreatePayload): Promise<Role> {
    return request<Role>(`/guilds/${guildId}/roles`, { method: 'POST', body: payload });
  },
  patch(guildId: string, roleId: string, payload: RolePatchPayload): Promise<Role> {
    return request<Role>(`/guilds/${guildId}/roles/${roleId}`, {
      method: 'PATCH',
      body: payload
    });
  },
  delete(guildId: string, roleId: string): Promise<void> {
    return request<void>(`/guilds/${guildId}/roles/${roleId}`, { method: 'DELETE' });
  },
  setPositions(guildId: string, positions: { id: string; position: number }[]): Promise<Role[]> {
    return request<Role[]>(`/guilds/${guildId}/roles-positions`, {
      method: 'PATCH',
      body: { positions }
    });
  },
  assign(guildId: string, userId: string, roleId: string): Promise<void> {
    return request<void>(`/guilds/${guildId}/members/${userId}/roles/${roleId}`, {
      method: 'PUT'
    });
  },
  unassign(guildId: string, userId: string, roleId: string): Promise<void> {
    return request<void>(`/guilds/${guildId}/members/${userId}/roles/${roleId}`, {
      method: 'DELETE'
    });
  },
  listMemberRoles(guildId: string, userId: string): Promise<Role[]> {
    return request<Role[]>(`/guilds/${guildId}/members/${userId}/roles`);
  },
  /** Every member's role-id list for the guild in one batched call.
   * Empty/absent entries == @everyone-only. Use this rather than
   * iterating ``listMemberRoles`` over a long member list. */
  bulkMemberRoles(guildId: string): Promise<Record<string, string[]>> {
    return request<Record<string, string[]>>(`/guilds/${guildId}/member-roles`);
  },
  myGuildPermissions(guildId: string): Promise<{ permissions: string }> {
    return request<{ permissions: string }>(`/guilds/${guildId}/permissions/me`);
  }
};

export const overwritesApi = {
  list(channelId: string): Promise<Overwrite[]> {
    return request<Overwrite[]>(`/channels/${channelId}/permissions`);
  },
  set(
    channelId: string,
    target_type: 0 | 1,
    target_id: string,
    body: { allow: string; deny: string }
  ): Promise<Overwrite> {
    return request<Overwrite>(
      `/channels/${channelId}/permissions/${target_type}/${target_id}`,
      { method: 'PUT', body }
    );
  },
  delete(channelId: string, target_type: 0 | 1, target_id: string): Promise<void> {
    return request<void>(`/channels/${channelId}/permissions/${target_type}/${target_id}`, {
      method: 'DELETE'
    });
  }
};

export const guildOwnershipApi = {
  transfer(
    guildId: string,
    payload: { new_owner_id: string; confirm_name: string }
  ): Promise<void> {
    return request<void>(`/guilds/${guildId}/transfer-ownership`, {
      method: 'POST',
      body: payload
    });
  }
};
