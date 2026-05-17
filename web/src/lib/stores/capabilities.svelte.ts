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
  loaded = $state(false);

  async hydrate(): Promise<void> {
    try {
      const c = await chatApi.getCapabilities();
      this.allowGuildCreation = c.allow_guild_creation;
      this.allowMemberInvites = c.allow_member_invites;
      this.loaded = true;
    } catch (e) {
      // Boot before auth-token is ready, network blip — leave defaults.
      // `apply()` below picks up the next WS-pushed snapshot if any.
      console.warn('capabilities.hydrate failed', e);
    }
  }

  /** Apply a snapshot from the `permissions_updated` WS envelope. */
  apply(next: { allow_guild_creation: boolean; allow_member_invites: boolean }): void {
    this.allowGuildCreation = next.allow_guild_creation;
    this.allowMemberInvites = next.allow_member_invites;
    this.loaded = true;
  }

  clear(): void {
    this.allowGuildCreation = true;
    this.allowMemberInvites = true;
    this.loaded = false;
  }
}

export const capabilities = new CapabilitiesStore();
