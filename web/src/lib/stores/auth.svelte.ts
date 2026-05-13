import { me } from '$lib/api/auth';
import { clearTokens, loadTokens } from '$lib/api/storage';
import { readState } from './readState.svelte';
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
      if (this.user) readState.hydrateForUser(this.user.id);
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
  }

  signOut(): void {
    clearTokens();
    this.user = null;
    readState.clear();
    void goto('/login');
  }
}

export const auth = new AuthStore();
