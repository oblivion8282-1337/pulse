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
  loaded = $state(false);

  async hydrate(): Promise<void> {
    try {
      const c = await chatApi.getCapabilities();
      this.allowGuildCreation = c.allow_guild_creation;
      this.allowMemberInvites = c.allow_member_invites;
      this.guildSoundMaxSizeBytes = c.guild_sound_max_size_bytes;
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
  }): void {
    this.allowGuildCreation = next.allow_guild_creation;
    this.allowMemberInvites = next.allow_member_invites;
    if (next.guild_sound_max_size_bytes !== undefined) {
      this.guildSoundMaxSizeBytes = next.guild_sound_max_size_bytes;
    }
    this.loaded = true;
  }

  clear(): void {
    this.allowGuildCreation = true;
    this.allowMemberInvites = true;
    this.guildSoundMaxSizeBytes = 524288;
    this.loaded = false;
  }
}

export const capabilities = new CapabilitiesStore();
