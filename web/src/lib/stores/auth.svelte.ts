import { me } from '$lib/api/auth';
import { clearTokens, loadTokens } from '$lib/api/storage';
import type { User } from '$lib/api/types';

class AuthStore {
  user = $state<User | null>(null);
  loading = $state(false);

  get isAuthenticated(): boolean {
    return this.user !== null;
  }

  async hydrate(): Promise<void> {
    if (this.user || this.loading) return;
    if (!loadTokens()) {
      this.user = null;
      return;
    }
    this.loading = true;
    try {
      this.user = await me();
    } catch {
      clearTokens();
      this.user = null;
    } finally {
      this.loading = false;
    }
  }

  setUser(user: User): void {
    this.user = user;
  }

  signOut(): void {
    clearTokens();
    this.user = null;
  }
}

export const auth = new AuthStore();
