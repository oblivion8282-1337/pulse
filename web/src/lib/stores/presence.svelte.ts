/**
 * Presence + status for the current user and visible peers.
 *
 * Two slices:
 *  * ``onlineIds`` — legacy boolean online/offline set, kept because the
 *    existing MemberList / DM dot still consult it; the gateway also still
 *    emits the cheap ``presence_update`` op for socket open/close. New
 *    presence-aware UI prefers ``displayStatus()`` below.
 *  * ``statuses`` — Etappe-3 status map (online/idle/dnd/offline) for visible
 *    peers, plus ``myStatus`` for the caller's own *real* status (never
 *    masked — the wire payload sends our own status separately so we can
 *    show ``invisible`` in our own UI even though peers see ``offline``).
 *
 * Seeding contract: ``ready`` calls ``seedAll`` which fills BOTH the legacy
 * online set (so the dot stays consistent) AND the status map. The
 * ``presence_status_changed`` event is the canonical mutator; legacy
 * ``presence_update`` only flips the boolean.
 */

export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline';
export type OwnPresenceStatus = 'online' | 'idle' | 'dnd' | 'invisible';

class PresenceStore {
  onlineIds = $state<Set<string>>(new Set());
  /** Peer status map. Missing key = ``offline`` (caller hasn't been seen
   *  online during the lifetime of this socket, or is genuinely offline). */
  statuses = $state<Record<string, PresenceStatus>>({});
  /** The caller's own *real* status — server delivers it via the
   *  presence_status_changed envelope addressed to our own sockets even
   *  when invisible (where peers see ``offline``). */
  myStatus = $state<OwnPresenceStatus>('online');

  /** Seed the legacy online set from ``ready.online_user_ids``. Kept as a
   *  separate call from ``seedStatuses`` so the WS-handler order stays
   *  identical to the pre-Etappe-4 codepath. */
  seed(userIds: string[]): void {
    this.onlineIds = new Set(userIds);
  }

  /** Seed the Etappe-3 status payload (``ready.presence_status`` /
   *  ``ready.user_presence_statuses``). */
  seedStatuses(map: Record<string, PresenceStatus>, ownStatus: OwnPresenceStatus): void {
    this.statuses = { ...map };
    this.myStatus = ownStatus;
  }

  apply(userId: string, online: boolean): void {
    const next = new Set(this.onlineIds);
    if (online) next.add(userId);
    else next.delete(userId);
    this.onlineIds = next;
  }

  /** Apply a ``presence_status_changed`` for a peer (masked value — caller
   *  already maps invisible → offline before this is called). */
  applyStatusChange(userId: string, status: PresenceStatus): void {
    if (this.statuses[userId] === status) return;
    this.statuses = { ...this.statuses, [userId]: status };
    // Keep the boolean set in sync so legacy consumers behave consistently.
    const next = new Set(this.onlineIds);
    if (status === 'offline') next.delete(userId);
    else next.add(userId);
    this.onlineIds = next;
  }

  /** Setter for the caller's own *real* status — used by the WS handler
   *  when ``presence_status_changed.user_id === me`` and by the REST flow
   *  to keep the local UI snappy before the WS echo lands. */
  setOwnStatus(status: OwnPresenceStatus): void {
    if (this.myStatus === status) return;
    this.myStatus = status;
  }

  isOnline(userId: string): boolean {
    return this.onlineIds.has(userId);
  }

  /** Resolve the status string for ``userId`` — the canonical helper for
   *  any presence-dot rendering. Returns ``'offline'`` when unknown. */
  displayStatus(userId: string): PresenceStatus {
    return this.statuses[userId] ?? 'offline';
  }

  clear(): void {
    this.onlineIds = new Set();
    this.statuses = {};
    this.myStatus = 'online';
  }
}

export const presence = new PresenceStore();
