/**
 * Lazy per-member role cache.
 *
 * `roles.svelte.ts` already knows the current user's role-ids per guild
 * (seeded from ready). This store tracks the role-ids for *other*
 * members, lazy-fetched on first access by anything that wants to
 * colour their name or hoist them — typically the member-list panels.
 *
 * `member_roles_updated` events without a payload trigger a refetch
 * for that specific (guild, user) pair. Cache is cleared on signOut.
 */

import { rolesApi } from '$lib/api/roles';

class MemberRolesStore {
  /** (guildId, userId) → role-ids the member holds (excluding @everyone). */
  byMember = $state<Record<string, string[]>>({});
  private _inflight = new Map<string, Promise<string[]>>();

  private _key(guildId: string, userId: string): string {
    return `${guildId}:${userId}`;
  }

  /** Fetch + cache. Returns the role-id list. Idempotent under concurrent
   * callers (one inflight request per key). */
  async ensure(guildId: string, userId: string): Promise<string[]> {
    const key = this._key(guildId, userId);
    const cached = this.byMember[key];
    if (cached) return cached;
    const inflight = this._inflight.get(key);
    if (inflight) return inflight;
    const p = rolesApi
      .listMemberRoles(guildId, userId)
      .then((rows) => {
        const ids = rows.filter((r) => !r.is_everyone).map((r) => r.id);
        this.byMember = { ...this.byMember, [key]: ids };
        return ids;
      })
      .finally(() => {
        this._inflight.delete(key);
      });
    this._inflight.set(key, p);
    return p;
  }

  /** Synchronous lookup — empty array when nothing cached yet. Callers
   * pair this with ``ensure`` for the actual fetch. */
  for(guildId: string, userId: string): string[] {
    return this.byMember[this._key(guildId, userId)] ?? [];
  }

  /** Replace the cached role-ids for *every* member of a guild in one
   * shot. Callers use this after a ``rolesApi.bulkMemberRoles`` fetch
   * so the member-list can colour + hoist-group without N+1 lookups.
   *
   * Members absent from ``payload`` are treated as @everyone-only and
   * get an empty list — the helper writes them explicitly so the
   * ``for()`` synchronous lookup short-circuits to "[]" instead of
   * undefined (which the caller would otherwise see as "not yet
   * loaded" and trigger an extra single-member ``ensure``). */
  seedAll(
    guildId: string,
    payload: Record<string, string[]>,
    knownUserIds: readonly string[]
  ): void {
    const next = { ...this.byMember };
    for (const uid of knownUserIds) {
      const ids = payload[uid] ?? [];
      next[this._key(guildId, uid)] = ids;
    }
    this.byMember = next;
  }

  /** Drop a member's cached roles so a follow-up access re-fetches.
   * Called from the WS handler on ``member_roles_updated``. */
  invalidate(guildId: string, userId: string): void {
    const key = this._key(guildId, userId);
    if (!this.byMember[key]) return;
    const next = { ...this.byMember };
    delete next[key];
    this.byMember = next;
  }

  clear(): void {
    this.byMember = {};
    this._inflight.clear();
  }
}

export const memberRoles = new MemberRolesStore();
