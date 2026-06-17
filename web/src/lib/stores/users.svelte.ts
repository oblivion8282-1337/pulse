import { request } from '$lib/api/client';
import { activeServer } from '$lib/stores/active-server.svelte';

export type UserSummary = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  /** Hex-Namensfarbe aus den Profileinstellungen; optional, da ältere
   *  Seed-Aufrufer (und gemockte Test-Payloads) sie nicht mitsenden. */
  profile_color?: string | null;
  /** Optionale zweite Farbe für einen Namens-Verlauf (profile_color → diese). */
  profile_color_secondary?: string | null;
  /** Richtung des Verlaufs in Grad (0–360); fehlend/null = Default 90° (links→rechts). */
  profile_gradient_angle?: number | null;
};

class UserCacheStore {
  byId = $state<Record<string, UserSummary>>({});

  private pending = new Set<string>();
  // Ids the server confirmed it has no record of (deleted / never existed).
  // Without this, `queue(id)` for such an id never short-circuits — and
  // `messageRender.userMentionLabel` re-queues on every render of an
  // `@unknown` mention, so each re-render fires another `/users` request.
  private unknown = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  get(id: string): UserSummary | null {
    return this.byId[id] ?? null;
  }

  displayName(id: string): string {
    const u = this.byId[id];
    if (!u) return `…`;
    return u.display_name ?? u.username;
  }

  /** Queue an ID for batch fetch; deduped and debounced 50ms. Already-cached,
   *  in-flight and known-absent ids short-circuit. */
  queue(id: string): void {
    if (this.byId[id] || this.pending.has(id) || this.unknown.has(id)) return;
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
      // Auf einem Self-Host kennt die Cloud-Auth die per-Instanz-IDs nicht →
      // Namen vom Self-Host (endpoint 'chat') holen statt von der Cloud.
      const onSelfHost = activeServer.current ? !activeServer.current.isCloud : false;
      const result = await request<UserSummary[]>(
        `/users?ids=${ids.join(',')}`,
        { endpoint: onSelfHost ? 'chat' : 'auth' }
      );
      const returned = new Set<string>();
      for (const u of result) {
        this.byId[u.id] = u;
        returned.add(u.id);
      }

      let unresolved = ids.filter((id) => !returned.has(id));
      // Cloud-Fallback: was der Self-Host nicht kennt (z.B. DM-Empfänger /
      // Freunde = Cloud-User), bei der Cloud-Auth nachschlagen. Verhindert eine
      // Regression der DM-/Friends-Namen, während man auf einem Self-Host ist.
      // (`endpoint:'auth'` ist immer Cloud-relativ.)
      if (onSelfHost && unresolved.length > 0) {
        try {
          const cloud = await request<UserSummary[]>(
            `/users?ids=${unresolved.join(',')}`,
            { endpoint: 'auth' }
          );
          for (const u of cloud) {
            this.byId[u.id] = u;
            returned.add(u.id);
          }
          unresolved = unresolved.filter((id) => !returned.has(id));
        } catch {
          // transient — bleibt retrybar (nicht tombstonen)
          unresolved = [];
        }
      }
      // Tombstone ids no source returned so we stop re-fetching them. Only on a
      // *successful* response — a network failure leaves them un-tombstoned
      // (retryable) via the empty-list assignment above / the outer catch.
      for (const id of unresolved) this.unknown.add(id);
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
        cached.display_name !== u.display_name || cached.avatar_url !== u.avatar_url ||
        (u.profile_color !== undefined && cached.profile_color !== u.profile_color) ||
        (u.profile_color_secondary !== undefined &&
          cached.profile_color_secondary !== u.profile_color_secondary) ||
        (u.profile_gradient_angle !== undefined &&
          cached.profile_gradient_angle !== u.profile_gradient_angle);
    });
    if (changed.length === 0) return;
    const next = { ...this.byId };
    // Spread-Merge: Seeds ohne profile_color (undefined) lassen eine bereits
    // gecachte Farbe stehen; explizites null überschreibt (Farbe entfernt).
    for (const u of changed) next[u.id] = { ...next[u.id], ...u };
    this.byId = next;
  }

  clear(): void {
    this.byId = {};
    this.pending.clear();
    this.unknown.clear();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}

export const userCache = new UserCacheStore();
