import { request } from '$lib/api/client';

export type UserSummary = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
};

class UserCacheStore {
  byId = $state<Record<string, UserSummary>>({});

  private pending = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  get(id: string): UserSummary | null {
    return this.byId[id] ?? null;
  }

  displayName(id: string): string {
    const u = this.byId[id];
    if (!u) return `…`;
    return u.display_name ?? u.username;
  }

  /** Queue an ID for batch fetch; deduped and debounced 50ms. */
  queue(id: string): void {
    if (this.byId[id] || this.pending.has(id)) return;
    this.pending.add(id);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this._flush(), 50);
  }

  private async _flush(): Promise<void> {
    if (this.pending.size === 0) return;
    const ids = [...this.pending].slice(0, 100);
    ids.forEach((id) => this.pending.delete(id));
    this.debounceTimer = null;
    try {
      const result = await request<UserSummary[]>(
        `/users?ids=${ids.join(',')}`,
        { endpoint: 'auth' }
      );
      const next = { ...this.byId };
      for (const u of result) next[u.id] = u;
      this.byId = next;
    } catch {
      // silent — display fallback until next attempt
    }
    // If more were added during the flush, schedule another round.
    if (this.pending.size > 0) {
      this.debounceTimer = setTimeout(() => void this._flush(), 50);
    }
  }

  seed(users: UserSummary[]): void {
    // Only write state if something actually changed to avoid re-render loops.
    const changed = users.filter((u) => {
      const cached = this.byId[u.id];
      return !cached || cached.username !== u.username ||
        cached.display_name !== u.display_name || cached.avatar_url !== u.avatar_url;
    });
    if (changed.length === 0) return;
    const next = { ...this.byId };
    for (const u of changed) next[u.id] = u;
    this.byId = next;
  }

  clear(): void {
    this.byId = {};
    this.pending.clear();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}

export const userCache = new UserCacheStore();
