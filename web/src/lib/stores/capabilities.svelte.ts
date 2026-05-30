/**
 * Read-only view of the server-wide permission flags
 * (`allow_guild_creation`, `allow_member_invites`).
 *
 * Hydrated on app boot, refreshed on the WS `permissions_updated` event
 * the admin's PATCH broadcasts. Components gate UI affordances on this
 * store; the server enforces the same flags for real, so missing the
 * UI gate is "ugly" not "exploitable".
 *
 * Defaults to "everything allowed" so the UI doesn't hide buttons
 * during the millisecond between mount and first fetch.
 */

import { chatApi } from '$lib/api/chat';

class CapabilitiesStore {
  allowGuildCreation = $state(true);
  allowMemberInvites = $state(true);
  /** Pulse-admin-tuned ceiling for per-guild sound-override uploads.
   * Mirrors ``chat_settings.guild_sound_max_size_bytes``; the Sounds tab
   * uses it as the client-side size cap. 512 KB matches the migration
   * default — re-set on the first /capabilities call. */
  guildSoundMaxSizeBytes = $state(524288);
  /** Global HQ-stream quality limits (best-effort, client-enforced — the
   * stream panel + buildStartArgs clamp to these). Defaults mirror the
   * backend migration defaults = no effective restriction. */
  hqBitrateMinKbps = $state(1000);
  hqBitrateMaxKbps = $state(10000);
  hqFpsMin = $state(1);
  hqFpsMax = $state(360);
  /** Resolution ceiling; 'Native' = no cap. */
  hqResolutionMax = $state('Native');
  loaded = $state(false);

  async hydrate(): Promise<void> {
    try {
      const c = await chatApi.getCapabilities();
      this.allowGuildCreation = c.allow_guild_creation;
      this.allowMemberInvites = c.allow_member_invites;
      this.guildSoundMaxSizeBytes = c.guild_sound_max_size_bytes;
      this.hqBitrateMinKbps = c.hq_bitrate_min_kbps;
      this.hqBitrateMaxKbps = c.hq_bitrate_max_kbps;
      this.hqFpsMin = c.hq_fps_min;
      this.hqFpsMax = c.hq_fps_max;
      this.hqResolutionMax = c.hq_resolution_max;
      this.loaded = true;
    } catch (e) {
      // Boot before auth-token is ready, network blip — leave defaults.
      // `apply()` below picks up the next WS-pushed snapshot if any.
      console.warn('capabilities.hydrate failed', e);
    }
  }

  /** Apply a snapshot from the `permissions_updated` WS envelope.
   * ``guild_sound_max_size_bytes`` is optional so older backends that
   * predate Phase 1 keep working. */
  apply(next: {
    allow_guild_creation: boolean;
    allow_member_invites: boolean;
    guild_sound_max_size_bytes?: number;
    hq_bitrate_min_kbps?: number;
    hq_bitrate_max_kbps?: number;
    hq_fps_min?: number;
    hq_fps_max?: number;
    hq_resolution_max?: string;
  }): void {
    this.allowGuildCreation = next.allow_guild_creation;
    this.allowMemberInvites = next.allow_member_invites;
    if (next.guild_sound_max_size_bytes !== undefined) {
      this.guildSoundMaxSizeBytes = next.guild_sound_max_size_bytes;
    }
    // HQ limits — each optional so a pre-Phase-1 backend keeps working.
    if (next.hq_bitrate_min_kbps !== undefined) this.hqBitrateMinKbps = next.hq_bitrate_min_kbps;
    if (next.hq_bitrate_max_kbps !== undefined) this.hqBitrateMaxKbps = next.hq_bitrate_max_kbps;
    if (next.hq_fps_min !== undefined) this.hqFpsMin = next.hq_fps_min;
    if (next.hq_fps_max !== undefined) this.hqFpsMax = next.hq_fps_max;
    if (next.hq_resolution_max !== undefined) this.hqResolutionMax = next.hq_resolution_max;
    this.loaded = true;
  }

  clear(): void {
    this.allowGuildCreation = true;
    this.allowMemberInvites = true;
    this.guildSoundMaxSizeBytes = 524288;
    this.hqBitrateMinKbps = 1000;
    this.hqBitrateMaxKbps = 10000;
    this.hqFpsMin = 1;
    this.hqFpsMax = 360;
    this.hqResolutionMax = 'Native';
    this.loaded = false;
  }
}

export const capabilities = new CapabilitiesStore();
