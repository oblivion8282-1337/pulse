/**
 * API-Client für Moderation-Endpoints (Phase 3.4).
 *
 * Nutzt Bearer-Auth via `request()` aus client.ts — alle Endpoints sind
 * guild-gated und verlangen ein gültiges Access-Token.
 * Snowflake-IDs werden konsequent als strings übertragen.
 */

import { request } from './client';

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

export type ReasonCode = 'spam' | 'harassment' | 'illegal' | 'csam' | 'other';
export type ReportStatus = 'new' | 'triaged' | 'resolved' | 'dismissed';
export type ActionType =
  | 'ban'
  | 'kick'
  | 'message_delete'
  | 'warn'
  | 'role_change'
  | 'other';

export interface Report {
  id: string;
  reporter_user_id: string;
  target_message_id: string | null;
  target_user_id: string | null;
  target_channel_id: string | null;
  reason_code: ReasonCode;
  body: string;
  created_at: string;
  status: ReportStatus;
  resolver_user_id: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
}

export interface ReportInput {
  target_message_id?: string;
  target_user_id?: string;
  target_channel_id?: string;
  reason_code: ReasonCode;
  body: string;
}

export interface ResolveInput {
  resolution: 'resolved' | 'dismissed';
  action_type?: ActionType;
  target_kind?: string;
  target_id?: string;
  resolution_note?: string;
}

export interface AuditLogEntry {
  id: string;
  guild_id: string;
  actor_user_id: string;
  action_type: string;
  target_kind: string | null;
  target_id: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
  actor_username?: string;
}

// ---------------------------------------------------------------------------
// API-Funktionen
// ---------------------------------------------------------------------------

/**
 * Sendet eine neue Meldung an den Server.
 * Kann eine Nachricht, einen User oder einen Channel als Ziel haben.
 */
export async function createReport(
  body: ReportInput
): Promise<{ id: string; status: string }> {
  return request<{ id: string; status: string }>('/reports', {
    method: 'POST',
    body
  });
}

/**
 * Listet Reports in der Mod-Queue einer Guild.
 * Setzt MANAGE_MESSAGES OR BAN_MEMBERS OR MANAGE_GUILD voraus.
 */
export async function listModQueue(
  guildId: string,
  status?: ReportStatus
): Promise<Report[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  return request<Report[]>(`/guilds/${guildId}/mod-queue${qs}`);
}

/**
 * Schließt einen Report ab (resolved oder dismissed).
 * Setzt MANAGE_MESSAGES OR BAN_MEMBERS OR MANAGE_GUILD voraus.
 */
export async function resolveReport(
  guildId: string,
  reportId: string,
  body: ResolveInput
): Promise<void> {
  return request<void>(`/guilds/${guildId}/mod-queue/${reportId}/resolve`, {
    method: 'POST',
    body
  });
}

/**
 * Holt den Guild-Audit-Log (Mod-Aktionen chronologisch absteigend).
 * Setzt MANAGE_GUILD voraus. Pagination via `before` (ISO-Timestamp).
 */
export async function listAuditLog(
  guildId: string,
  limit = 50,
  before?: string
): Promise<AuditLogEntry[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (before) params.set('before', before);
  return request<AuditLogEntry[]>(`/guilds/${guildId}/mod-audit-log?${params}`);
}
