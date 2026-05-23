/**
 * Pending friend requests for the current user, both directions.
 *
 * Wire shape mirrors ``FriendRequestOut`` from chat-gateway: the request id,
 * sender_id, receiver_id (all snowflake strings) plus created_at.
 *
 * Seeded from ``ready.friend_requests_in`` / ``ready.friend_requests_out``;
 * live-mutated by the 4 lifecycle events (received / accepted / declined /
 * cancelled). On accept the entry leaves the pending lists and the matching
 * friendship is added to ``friends.svelte.ts`` (separate stores so callers
 * can subscribe to just one slice).
 */

export type FriendRequest = {
  id: string;
  sender_id: string;
  receiver_id: string;
  created_at: string;
};

function _sortDescByCreated(a: FriendRequest, b: FriendRequest): number {
  if (a.created_at === b.created_at) return 0;
  return a.created_at < b.created_at ? 1 : -1;
}

class FriendRequestsStore {
  /** Incoming (= caller is receiver). Key = request id. */
  incoming = $state<Record<string, FriendRequest>>({});
  /** Outgoing (= caller is sender). Key = request id. */
  outgoing = $state<Record<string, FriendRequest>>({});

  incomingList = $derived(Object.values(this.incoming).sort(_sortDescByCreated));
  outgoingList = $derived(Object.values(this.outgoing).sort(_sortDescByCreated));

  /** Replace both lists — used by ``ready`` seeding. */
  seedAll(args: { incoming: FriendRequest[]; outgoing: FriendRequest[] }): void {
    const inMap: Record<string, FriendRequest> = {};
    for (const r of args.incoming) inMap[r.id] = r;
    const outMap: Record<string, FriendRequest> = {};
    for (const r of args.outgoing) outMap[r.id] = r;
    this.incoming = inMap;
    this.outgoing = outMap;
  }

  addIncoming(req: FriendRequest): void {
    if (this.incoming[req.id]) return;
    this.incoming = { ...this.incoming, [req.id]: req };
  }

  addOutgoing(req: FriendRequest): void {
    if (this.outgoing[req.id]) return;
    this.outgoing = { ...this.outgoing, [req.id]: req };
  }

  removeIncoming(id: string): void {
    if (!(id in this.incoming)) return;
    const next = { ...this.incoming };
    delete next[id];
    this.incoming = next;
  }

  removeOutgoing(id: string): void {
    if (!(id in this.outgoing)) return;
    const next = { ...this.outgoing };
    delete next[id];
    this.outgoing = next;
  }

  /** Drop the row from whichever bucket holds it. Used by the lifecycle
   *  events that don't know the direction off-hand (e.g. ``friend_request_
   *  accepted`` arrives at both sides). */
  removeById(id: string): void {
    this.removeIncoming(id);
    this.removeOutgoing(id);
  }

  clear(): void {
    this.incoming = {};
    this.outgoing = {};
  }
}

export const friendRequests = new FriendRequestsStore();
