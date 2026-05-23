/**
 * Confirmed friendships for the current user.
 *
 * Wire shape mirrors ``FriendOut`` from chat-gateway: ``user_id`` is *always*
 * the other party (computed server-side from the sorted pair). ``since`` is
 * the ISO timestamp of the moment the friendship was installed.
 *
 * Hydrated from ``ready.friends`` on every WS connect; live-mutated by the
 * ``friend_request_accepted`` and ``friend_removed`` events. The friend set
 * is also consulted by ``directMessages.svelte.ts`` to refresh ``can_send``
 * on lifecycle changes (Etappe 4 hard-cut foundation).
 */

export type Friend = {
  user_id: string;
  since: string;
};

class FriendsStore {
  /** key = user_id (string snowflake) → since iso */
  byId = $state<Record<string, string>>({});
  loaded = $state(false);

  /** Replace the whole map — used by ``ready`` seeding. */
  seedAll(items: { user_id: string; since: string }[]): void {
    const next: Record<string, string> = {};
    for (const it of items) next[it.user_id] = it.since;
    this.byId = next;
    this.loaded = true;
  }

  add(userId: string, since: string): void {
    if (this.byId[userId] === since) return;
    this.byId = { ...this.byId, [userId]: since };
  }

  remove(userId: string): void {
    if (!(userId in this.byId)) return;
    const next = { ...this.byId };
    delete next[userId];
    this.byId = next;
  }

  has(userId: string): boolean {
    return userId in this.byId;
  }

  /** Sorted by most-recent friendship first (ISO timestamps lex-sortable
   *  within the same century — same trick the DM list uses). */
  list = $derived(
    Object.entries(this.byId)
      .map(([user_id, since]) => ({ user_id, since }) as Friend)
      .sort((a, b) => (a.since === b.since ? 0 : a.since < b.since ? 1 : -1))
  );

  clear(): void {
    this.byId = {};
    this.loaded = false;
  }
}

export const friends = new FriendsStore();
