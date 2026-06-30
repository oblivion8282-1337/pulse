/**
 * DropBox / Ablage — client for the per-guild file storage channel.
 *
 * Wire-shape mirrors backend ``routes/_dropbox_schemas.py``.
 * Snowflake IDs are strings on the wire (per Pulse convention;
 * JS Number can't represent >2^53 without precision loss).
 */

import { request } from './client';

export type DropboxEntryKind = 0 | 1; // 0 = folder, 1 = file

export interface DropboxConfig {
  guild_id: string;
  enabled: boolean;
  total_quota_bytes: number;
  per_file_max_bytes: number;
  used_bytes: number;
  trash_retention_days: number;
  updated_at: string;
}

export interface DropboxEntry {
  id: string;
  guild_id: string;
  channel_id: string;
  parent_path: string;
  name: string;
  kind: DropboxEntryKind;
  size_bytes: number | null;
  content_type: string | null;
  version: number;
  uploaded_by_id: string;
  uploaded_at: string;
  updated_at: string;
  pinned: boolean;
  deleted_at: string | null;
  /** Presigned GET URL — files only, short-lived (~30 min). */
  url: string | null;
  thumb_url: string | null;
}

export interface DropboxChannel {
  id: string;
  guild_id: string;
  name: string;
  type: number;
  position: number;
  created: boolean;
}

interface DropboxEntriesResp {
  entries: DropboxEntry[];
  parent_path: string;
  truncated: boolean;
}

const BASE = (guildId: string) => `/guilds/${guildId}/dropbox`;

export const dropboxApi = {
  /** Fetch (or lazily create) the guild's dropbox channel + config. */
  ensureChannel(guildId: string): Promise<DropboxChannel> {
    return request<DropboxChannel>(`${BASE(guildId)}/channel`, {
      method: 'GET'
    });
  },

  getQuota(guildId: string): Promise<DropboxConfig> {
    return request<DropboxConfig>(`${BASE(guildId)}/quota`, { method: 'GET' });
  },

  patchQuota(
    guildId: string,
    patch: Partial<
      Pick<
        DropboxConfig,
        'enabled' | 'total_quota_bytes' | 'per_file_max_bytes' | 'trash_retention_days'
      >
    >
  ): Promise<DropboxConfig> {
    return request<DropboxConfig>(`${BASE(guildId)}/settings`, {
      method: 'PATCH',
      body: JSON.stringify(patch)
    });
  },

  listEntries(
    guildId: string,
    opts: { path?: string; q?: string; includeTrash?: boolean } = {}
  ): Promise<DropboxEntriesResp> {
    const params = new URLSearchParams();
    if (opts.path) params.set('path', opts.path);
    if (opts.q) params.set('q', opts.q);
    if (opts.includeTrash) params.set('include_trash', 'true');
    const qs = params.toString();
    return request<DropboxEntriesResp>(
      `${BASE(guildId)}/entries${qs ? `?${qs}` : ''}`,
      { method: 'GET' }
    );
  },

  createFolder(
    guildId: string,
    parentPath: string,
    name: string
  ): Promise<DropboxEntry> {
    return request<DropboxEntry>(`${BASE(guildId)}/folders`, {
      method: 'POST',
      body: JSON.stringify({ parent_path: parentPath, name })
    });
  },

  patchEntry(
    guildId: string,
    entryId: string,
    patch: { name?: string; parent_path?: string; pinned?: boolean }
  ): Promise<DropboxEntry> {
    return request<DropboxEntry>(`${BASE(guildId)}/entries/${entryId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch)
    });
  },

  deleteEntry(guildId: string, entryId: string): Promise<void> {
    return request<void>(`${BASE(guildId)}/entries/${entryId}`, {
      method: 'DELETE'
    });
  },

  restoreEntry(guildId: string, entryId: string): Promise<DropboxEntry> {
    return request<DropboxEntry>(
      `${BASE(guildId)}/entries/${entryId}/restore`,
      { method: 'POST' }
    );
  },

  /** Mint a presigned PUT URL the browser streams directly to MinIO. */
  mintUploadUrl(
    guildId: string,
    payload: {
      parent_path: string;
      name: string;
      content_type: string;
      size_bytes: number;
    }
  ): Promise<{ id: string; upload_url: string; storage_key: string }> {
    return request<{ id: string; upload_url: string; storage_key: string }>(
      `${BASE(guildId)}/upload-url`,
      { method: 'POST', body: JSON.stringify(payload) }
    );
  },

  /**
   * Persist the row after the PUT to MinIO succeeds. The server HEADs
   * the object to confirm size + content-type before returning the
   * live entry — a mismatch (tampering) hands back a 409 + auto-clean.
   */
  finishUpload(
    guildId: string,
    payload: {
      id: string;
      parent_path: string;
      name: string;
      size_bytes: number;
      content_type: string;
    }
  ): Promise<DropboxEntry> {
    return request<DropboxEntry>(`${BASE(guildId)}/finish-upload`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  }
};
