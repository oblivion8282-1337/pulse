/**
 * Users the caller has blocked.
 *
 * One direction only (we never see "who blocked me"; per backend, that's by
 * design — Discord parity). Seeded from ``ready.blocked_user_ids``; live-
 * mutated by ``user_blocked`` / ``user_unblocked`` events.
 *
 * The set is consulted by ``directMessages.svelte.ts`` to refresh
 * ``can_send`` on lifecycle changes, by the friends/add UI to label a
 * search-hit as "blocked" instead of "add", and by ``MessageItem.svelte``
 * (via ``nachrichtVonBlockiertem``) to collapse a message from a blocked
 * sender in a private group — the DM path never reaches that check, the
 * server withholds delivery there already.
 */

export type BlockedEntry = {
  user_id: string;
  since: string;
};

class BlocksStore {
  /** key = user_id (snowflake string) → since iso */
  byId = $state<Record<string, string>>({});
  loaded = $state(false);

  /** Replace the whole set — used by ``ready`` seeding. ``ready`` only
   *  carries the id list; the timestamp isn't on the wire there, so we
   *  store the current ISO as a best-effort placeholder until the next
   *  ``GET /blocks`` (which the BlockedList tab fires on mount). */
  seedAll(ids: string[]): void {
    const next: Record<string, string> = {};
    const stamp = new Date().toISOString();
    for (const id of ids) next[id] = stamp;
    this.byId = next;
    this.loaded = true;
  }

  /** Hydrate with full ``GET /blocks`` rows (real ``since`` timestamps). */
  hydrate(rows: BlockedEntry[]): void {
    const next: Record<string, string> = {};
    for (const r of rows) next[r.user_id] = r.since;
    this.byId = next;
    this.loaded = true;
  }

  add(userId: string, since?: string): void {
    const next = { ...this.byId, [userId]: since ?? new Date().toISOString() };
    this.byId = next;
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

  list = $derived(
    Object.entries(this.byId)
      .map(([user_id, since]) => ({ user_id, since }) as BlockedEntry)
      .sort((a, b) => (a.since === b.since ? 0 : a.since < b.since ? 1 : -1))
  );

  clear(): void {
    this.byId = {};
    this.loaded = false;
  }
}

export const blocks = new BlocksStore();
