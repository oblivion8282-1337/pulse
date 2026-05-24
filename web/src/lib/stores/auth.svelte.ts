import { me } from '$lib/api/auth';
import { clearTokens, loadTokens } from '$lib/api/storage';
import { readState } from './readState.svelte';
import { voicePresence } from './voicePresence.svelte';
import { streamPresence } from './streamPresence.svelte';
import { userCache } from './users.svelte';
import { directMessages } from './directMessages.svelte';
import { guilds } from './guilds.svelte';
import { messages } from './messages.svelte';
import { roles } from './roles.svelte';
import { guildSounds } from './guildSounds.svelte';
import { channelPermissions } from './channelPermissions.svelte';
import { memberRoles } from './memberRoles.svelte';
import { capabilities } from './capabilities.svelte';
import { settings } from './settings.svelte';
import { hydrateServerSections } from '$lib/settings-registry';
import { friends } from './friends.svelte';
import { friendRequests } from './friendRequests.svelte';
import { blocks } from './blocks.svelte';
import { privacy } from './privacy.svelte';
import { presence } from './presence.svelte';
import { resetGuildPluginsCache } from '$lib/plugins';
import { goto } from '$app/navigation';
import type { User } from '$lib/api/types';

const ACCESS_KEY = 'dcc.tokens.access';

class AuthStore {
  user = $state<User | null>(null);
  loading = $state(false);
  private _hydrateInflight: Promise<void> | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (e) => {
        if (e.key === ACCESS_KEY && !e.newValue) {
          this.signOut();
        }
      });
    }
  }

  get isAuthenticated(): boolean {
    return this.user !== null;
  }

  hydrate(): Promise<void> {
    if (this._hydrateInflight) return this._hydrateInflight;
    if (this.user) return Promise.resolve();
    if (!loadTokens()) {
      this.user = null;
      return Promise.resolve();
    }
    this._hydrateInflight = this._doHydrate();
    return this._hydrateInflight;
  }

  private async _doHydrate(): Promise<void> {
    this.loading = true;
    try {
      this.user = await me();
      if (this.user) {
        readState.hydrateForUser(this.user.id);
        // Schritt 3b: pull server-backed settings sections so plugins
        // that opted into cross-device sync see the latest state.
        // Best-effort; a network blip just leaves the local slice in
        // place, the next mutation will push it back up.
        void hydrateServerSections();
      }
    } catch {
      clearTokens();
      this.user = null;
    } finally {
      this.loading = false;
      this._hydrateInflight = null;
    }
  }

  setUser(user: User): void {
    this.user = user;
    readState.hydrateForUser(user.id);
    // Same Schritt-3b cross-device hydrate as in _doHydrate. Triggered
    // by the login flow's `auth.setUser(...)` call right after the
    // tokens are saved.
    void hydrateServerSections();
  }

  signOut(): void {
    clearTokens();
    this.user = null;
    // Clear all session-scoped stores so a re-login (or a different user
    // signing in on the same tab without a reload) starts from a clean slate.
    // guilds/messages are cleared by UserFooter.onSignOut where it's the
    // user-initiated path; this method also runs from the WS connection's
    // refresh-failure path, which is why the clearing belongs here.
    readState.clear();
    voicePresence.clear();
    streamPresence.clear();
    userCache.clear();
    directMessages.clear();
    guilds.clear();
    messages.clear();
    roles.clear();
    guildSounds.clear();
    channelPermissions.clear();
    memberRoles.clear();
    capabilities.clear();
    friends.clear();
    friendRequests.clear();
    blocks.clear();
    privacy.clear();
    presence.clear();
    resetGuildPluginsCache();
    settings.resetUserScoped();
    void goto('/login');
  }
}

export const auth = new AuthStore();
