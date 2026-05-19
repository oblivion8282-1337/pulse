/**
 * Admin-panel API client. All endpoints are gated by `is_admin` on the
 * server — the UI also hides them behind the `auth.user.is_admin` check,
 * but a hand-crafted request would still 403 server-side.
 *
 * Two services emit admin endpoints (per PLAN.md anti-pattern: no shared
 * tables): auth-svc owns users + registration_mode, chat-gateway owns
 * DM-limits + chat-side stats. The UI fetches from both and merges where
 * needed (audit-log, stats overview).
 */

import { request } from './client';

export type RegistrationMode = 'open' | 'invite_only' | 'closed';

export type AdminUser = {
  id: string;
  username: string;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  is_admin: boolean;
  disabled: boolean;
  created_at: string;
};

export type AuthSettings = {
  registration_mode: RegistrationMode;
};

export type AuthStats = {
  user_count: number;
  admin_count: number;
  disabled_count: number;
};

export type ChatSettings = {
  dm_attachment_max_size_bytes: number;
  dm_attachment_max_count_per_message: number;
};

export type Permissions = {
  allow_guild_creation: boolean;
  allow_member_invites: boolean;
  /** Per-file cap (bytes) for per-guild sound-override uploads. The
   * Sounds tab in guild settings reads the live value via the
   * capabilities store; this admin view edits it directly. */
  guild_sound_max_size_bytes: number;
};

export type ChatStats = {
  guild_count: number;
  channel_count: number;
  dm_channel_count: number;
  messages_24h: number;
  storage_bytes: number | null;
  /** Total + free disk space of the MinIO backend, summed across drives.
   * Null if the admin endpoint was unreachable. */
  storage_total_bytes: number | null;
  storage_free_bytes: number | null;
};

export type AuditLogEntry = {
  id: string;
  actor_id: string;
  action: string;
  target_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
  /** Locally-tagged service of origin; merged client-side from both audit logs. */
  source: 'auth' | 'chat';
};

export const adminApi = {
  // ---- auth-svc -----------------------------------------------------------

  authStats(): Promise<AuthStats> {
    return request<AuthStats>('/admin/stats', { endpoint: 'auth' });
  },
  listUsers(opts: { before?: string; limit?: number } = {}): Promise<AdminUser[]> {
    const params = new URLSearchParams();
    if (opts.before) params.set('before', opts.before);
    params.set('limit', String(opts.limit ?? 50));
    return request<AdminUser[]>(`/admin/users?${params}`, { endpoint: 'auth' });
  },
  patchUser(
    id: string,
    payload: { is_admin?: boolean; disabled?: boolean }
  ): Promise<AdminUser> {
    return request<AdminUser>(`/admin/users/${id}`, {
      method: 'PATCH',
      endpoint: 'auth',
      body: payload
    });
  },
  getAuthSettings(): Promise<AuthSettings> {
    return request<AuthSettings>('/admin/settings', { endpoint: 'auth' });
  },
  patchAuthSettings(payload: AuthSettings): Promise<AuthSettings> {
    return request<AuthSettings>('/admin/settings', {
      method: 'PATCH',
      endpoint: 'auth',
      body: payload
    });
  },
  authAuditLog(
    opts: { before?: string; limit?: number } = {}
  ): Promise<Omit<AuditLogEntry, 'source'>[]> {
    const params = new URLSearchParams();
    if (opts.before) params.set('before', opts.before);
    params.set('limit', String(opts.limit ?? 50));
    return request<Omit<AuditLogEntry, 'source'>[]>(`/admin/audit-log?${params}`, {
      endpoint: 'auth'
    });
  },

  // ---- chat-gateway -------------------------------------------------------

  chatStats(): Promise<ChatStats> {
    return request<ChatStats>('/admin/stats', { endpoint: 'chat' });
  },
  getDmLimits(): Promise<ChatSettings> {
    return request<ChatSettings>('/admin/dm-limits', { endpoint: 'chat' });
  },
  patchDmLimits(payload: Partial<ChatSettings>): Promise<ChatSettings> {
    return request<ChatSettings>('/admin/dm-limits', {
      method: 'PATCH',
      endpoint: 'chat',
      body: payload
    });
  },
  getPermissions(): Promise<Permissions> {
    return request<Permissions>('/admin/permissions', { endpoint: 'chat' });
  },
  patchPermissions(payload: Partial<Permissions>): Promise<Permissions> {
    return request<Permissions>('/admin/permissions', {
      method: 'PATCH',
      endpoint: 'chat',
      body: payload
    });
  },
  chatAuditLog(
    opts: { before?: string; limit?: number } = {}
  ): Promise<Omit<AuditLogEntry, 'source'>[]> {
    const params = new URLSearchParams();
    if (opts.before) params.set('before', opts.before);
    params.set('limit', String(opts.limit ?? 50));
    return request<Omit<AuditLogEntry, 'source'>[]>(`/admin/audit-log?${params}`, {
      endpoint: 'chat'
    });
  },

  // ---- merged convenience -------------------------------------------------

  /** Fetch both audit logs, tag with their source, sort newest-first. */
  async mergedAuditLog(limit = 50): Promise<AuditLogEntry[]> {
    const [a, c] = await Promise.all([
      this.authAuditLog({ limit }),
      this.chatAuditLog({ limit })
    ]);
    const tagged: AuditLogEntry[] = [
      ...a.map((e) => ({ ...e, source: 'auth' as const })),
      ...c.map((e) => ({ ...e, source: 'chat' as const }))
    ];
    // Sort by created_at desc — both feeds emit ISO timestamps.
    tagged.sort((x, y) => (x.created_at < y.created_at ? 1 : -1));
    return tagged.slice(0, limit);
  }
};
