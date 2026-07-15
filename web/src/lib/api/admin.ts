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
  /** Owner (Betreiber): genehmigt Self-Host-/App-Host-Anträge, gegen
   *  Demote/Ban geschützt. Nicht über die UI setzbar. */
  is_owner?: boolean;
  disabled: boolean;
  created_at: string;
  self_host_enabled: boolean;
};

export type AuthSettings = {
  registration_mode: RegistrationMode;
};

export type Invite = {
  code: string;
  created_at: string;
  expires_at: string | null;
  /** null = unbegrenzt oft einlösbar. */
  max_uses: number | null;
  uses: number;
  revoked: boolean;
  note: string | null;
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
  /** Self-Host-only: Wenn true, können keine neuen Nutzer beitreten (auch nicht per Invite/öffentlicher Adresse). */
  locked: boolean;
  /** Self-Host-only: instanzweiter Anzeigename, den alle verbundenen Clients
   *  sehen (statt der URL). null = keiner gesetzt. */
  instance_name: string | null;
  /** Per-file cap (bytes) for per-guild sound-override uploads. The
   * Sounds tab in guild settings reads the live value via the
   * capabilities store; this admin view edits it directly. */
  guild_sound_max_size_bytes: number;
  /** Global HQ-stream quality limits (best-effort, client-enforced).
   * ``hq_resolution_max`` is a ceiling; 'Native' = no cap. */
  hq_bitrate_min_kbps: number;
  hq_bitrate_max_kbps: number;
  hq_fps_min: number;
  hq_fps_max: number;
  hq_resolution_max: string;
  /** Normal-stream (browser screen-share) limits — separate value set. */
  ns_bitrate_min_kbps: number;
  ns_bitrate_max_kbps: number;
  ns_fps_min: number;
  ns_fps_max: number;
  ns_resolution_max: string;
  /** Webcam capture ceiling (resolution stage + max fps). */
  cam_resolution_max: string;
  cam_fps_max: number;
};

export type SmtpProvider = 'brevo' | 'mailgun' | 'resend' | 'gmail' | 'custom';

export type SmtpSettings = {
  provider: SmtpProvider;
  host: string | null;
  port: number;
  username: string | null;
  from_email: string | null;
  use_ssl: boolean;
  configured: boolean;
  /** Server tells the UI whether a password is stored, without ever sending
   * the value. Lets the password input render as "leave blank to keep" vs
   * "empty" without a separate flag. */
  has_password: boolean;
};

/** PATCH payload — every field except ``password`` is required (sent every
 * time). ``password`` is tri-state: omitted/null preserves, ""  clears,
 * non-empty replaces. Mirrors ``SmtpSettingsPatch`` in the auth-svc. */
export type SmtpSettingsPatch = {
  provider: SmtpProvider;
  host: string | null;
  port: number;
  username: string | null;
  password?: string | null;
  from_email: string | null;
  use_ssl: boolean;
};

export type SmtpTestPayload = {
  to: string;
  provider?: SmtpProvider | null;
  host?: string | null;
  port?: number | null;
  username?: string | null;
  password?: string | null;
  from_email?: string | null;
  use_ssl?: boolean | null;
};

export type SmtpTestResult = {
  ok: boolean;
  error: string | null;
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

/** Self-Host pg_dump-Snapshots (F11b) — vom Instanz-backup-Service. */
export type SelfHostBackupEntry = {
  filename: string;
  size_bytes: number;
  created_at: string;
};
export type SelfHostBackupStatus = {
  enabled: boolean;
  directory: string;
  backups: SelfHostBackupEntry[];
  last_backup_at: string | null;
  total_bytes: number;
};

/** Instanzweite Nutzer (F11c) — die `cached_user_profiles` der aktiven
 * Self-Host-Instanz. `user_identifier` ist die pairwise-sub (TEXT, kein
 * Snowflake). `banned_at != null` = instanzweit gebannt. */
export type InstanceMember = {
  user_identifier: string;
  username: string;
  display_name: string;
  avatar_hash: string | null;
  banned_at: string | null;
  ban_reason: string | null;
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

/** Status snapshot of the restic backup sidecar. Read-only — there is no
 * trigger/restore endpoint by design (see infra/prod/backup/restore.md). */
export type BackupStatus = {
  /** False if the pulse_backups volume isn't mounted into auth-svc — i.e.
   * the backup sidecar hasn't been deployed yet (dev / pre-setup). */
  configured: boolean;
  /** ISO-8601 UTC of the most recent successful run, or null if no run
   * has happened yet (fresh deploy within the entrypoint-touch window). */
  last_backup_at: string | null;
  age_seconds: number | null;
  /** Mirrors the compose healthcheck: false once age > stale_threshold. */
  healthy: boolean;
  stale_threshold_seconds: number;
};

/** One community (guild) row in the owner's cloud-wide oversight list.
 *  Metadata only — never any chat content. ``owner_id`` is resolved to a name
 *  on the client via the user cache. */
export type Community = {
  id: string;
  name: string;
  owner_id: string;
  icon_url: string | null;
  is_public: boolean;
  handle: string | null;
  created_at: string;
  member_count: number;
  storage_bytes: number;
  /** Platform-frozen by the operator — members lose access until unsuspended. */
  suspended: boolean;
  /** Operator-only note (never shown to members); null when none/active. */
  suspended_reason: string | null;
  /** Per-community quality caps. null = inherit the instance default. */
  voice_bitrate_max_kbps: number | null;
  stream_bitrate_max_kbps: number | null;
  stream_fps_max: number | null;
  stream_resolution_max: string | null;
};

/** Owner-set per-community quality caps. Full set sent each save; null clears. */
export type CommunityLimits = {
  voice_bitrate_max_kbps: number | null;
  stream_bitrate_max_kbps: number | null;
  stream_fps_max: number | null;
  stream_resolution_max: string | null;
};

export type CommunityList = {
  communities: Community[];
  /** Cursor for the next page, or null when the last page was reached. */
  next_before: string | null;
};

function paginationParams(opts: { before?: string; limit?: number }, defaultLimit = 50): URLSearchParams {
  const params = new URLSearchParams();
  if (opts.before) params.set('before', opts.before);
  params.set('limit', String(opts.limit ?? defaultLimit));
  return params;
}

export const adminApi = {
  // ---- auth-svc -----------------------------------------------------------

  authStats(): Promise<AuthStats> {
    return request<AuthStats>('/admin/stats', { endpoint: 'auth' });
  },
  listUsers(
    opts: {
      before?: string;
      limit?: number;
      q?: string;
      filter?: 'admins' | 'disabled' | 'self_host';
    } = {}
  ): Promise<AdminUser[]> {
    const params = paginationParams(opts);
    if (opts.q) params.set('q', opts.q);
    if (opts.filter) params.set('filter', opts.filter);
    return request<AdminUser[]>(`/admin/users?${params}`, { endpoint: 'auth' });
  },
  patchUser(
    id: string,
    payload: { is_admin?: boolean; disabled?: boolean; self_host_enabled?: boolean }
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
  getSmtpSettings(): Promise<SmtpSettings> {
    return request<SmtpSettings>('/admin/smtp', { endpoint: 'auth' });
  },
  patchSmtpSettings(payload: SmtpSettingsPatch): Promise<SmtpSettings> {
    return request<SmtpSettings>('/admin/smtp', {
      method: 'PATCH',
      endpoint: 'auth',
      body: payload
    });
  },
  testSmtp(payload: SmtpTestPayload): Promise<SmtpTestResult> {
    return request<SmtpTestResult>('/admin/smtp/test', {
      method: 'POST',
      endpoint: 'auth',
      body: payload
    });
  },
  getBackupStatus(): Promise<BackupStatus> {
    return request<BackupStatus>('/admin/backup-status', { endpoint: 'auth' });
  },
  authAuditLog(
    opts: { before?: string; limit?: number } = {}
  ): Promise<Omit<AuditLogEntry, 'source'>[]> {
    const params = paginationParams(opts);
    return request<Omit<AuditLogEntry, 'source'>[]>(`/admin/audit-log?${params}`, {
      endpoint: 'auth'
    });
  },
  listInvites(): Promise<Invite[]> {
    return request<Invite[]>('/admin/invites', { endpoint: 'auth' });
  },
  createInvite(payload: {
    max_uses?: number | null;
    expires_in_days?: number | null;
    note?: string | null;
  }): Promise<Invite> {
    return request<Invite>('/admin/invites', {
      method: 'POST',
      endpoint: 'auth',
      body: payload
    });
  },
  revokeInvite(code: string): Promise<void> {
    return request<void>(`/admin/invites/${encodeURIComponent(code)}`, {
      method: 'DELETE',
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
    const params = paginationParams(opts);
    return request<Omit<AuditLogEntry, 'source'>[]>(`/admin/audit-log?${params}`, {
      endpoint: 'chat'
    });
  },
  // ---- owner (Cloud-operator) cloud-wide oversight ------------------------

  /** Cloud-wide community list (owner-only). Metadata, never chat content. */
  listCommunities(
    opts: { before?: string; limit?: number; q?: string } = {}
  ): Promise<CommunityList> {
    const params = paginationParams(opts);
    if (opts.q) params.set('q', opts.q);
    return request<CommunityList>(`/owner/communities?${params}`, { endpoint: 'chat' });
  },
  /** Freeze a community (owner-only). Members lose access until unsuspended. */
  suspendCommunity(guildId: string, reason?: string): Promise<Community> {
    return request<Community>(`/owner/communities/${guildId}/suspend`, {
      method: 'POST',
      endpoint: 'chat',
      body: { reason: reason ?? null }
    });
  },
  /** Unfreeze a community (owner-only). */
  unsuspendCommunity(guildId: string): Promise<Community> {
    return request<Community>(`/owner/communities/${guildId}/unsuspend`, {
      method: 'POST',
      endpoint: 'chat'
    });
  },
  /** Set this community's per-community quality caps (owner-only). Full set;
   *  null clears an override back to the instance default. */
  setCommunityLimits(guildId: string, limits: CommunityLimits): Promise<Community> {
    return request<Community>(`/owner/communities/${guildId}/limits`, {
      method: 'PATCH',
      endpoint: 'chat',
      body: limits
    });
  },
  /** Permanently delete a community + everything in it. Global-admin gated on
   *  the server (a platform admin may delete any guild). Irreversible. */
  deleteCommunity(guildId: string): Promise<void> {
    return request<void>(`/guilds/${guildId}`, { method: 'DELETE', endpoint: 'chat' });
  },

  /** Self-Host-Backup-Status — gegen die aktive Instanz (chat-gateway). */
  selfHostBackups(): Promise<SelfHostBackupStatus> {
    return request<SelfHostBackupStatus>('/admin/self-host/backups', { endpoint: 'chat' });
  },

  /** Instanzweite Member-Verwaltung (F11c) — gegen die aktive Instanz. */
  listMembers(): Promise<InstanceMember[]> {
    return request<InstanceMember[]>('/admin/members', { endpoint: 'chat' });
  },
  banMember(userIdentifier: string, reason?: string): Promise<InstanceMember> {
    return request<InstanceMember>(
      `/admin/members/${encodeURIComponent(userIdentifier)}/ban`,
      { method: 'POST', endpoint: 'chat', body: { reason: reason ?? null } }
    );
  },
  unbanMember(userIdentifier: string): Promise<InstanceMember> {
    return request<InstanceMember>(
      `/admin/members/${encodeURIComponent(userIdentifier)}/unban`,
      { method: 'POST', endpoint: 'chat' }
    );
  },

  // ---- merged convenience -------------------------------------------------

  /**
   * Fetch both audit logs, tag with their source, sort newest-first.
   *
   * ``includeAuth=false`` (Self-Host): nur der chat-gateway-Audit von der aktiven
   * Instanz. Der auth-svc-Audit liegt auf der Cloud (Identity-Plane) und ist für
   * einen Cert-Login-Admin nicht zugänglich (403) + inhaltlich leer (keine
   * lokalen auth.users-Aktionen).
   */
  async mergedAuditLog(limit = 50, includeAuth = true): Promise<AuditLogEntry[]> {
    const [a, c] = await Promise.all([
      includeAuth ? this.authAuditLog({ limit }) : Promise.resolve([]),
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
