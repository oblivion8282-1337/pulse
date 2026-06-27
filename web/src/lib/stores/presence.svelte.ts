/**
 * Presence + status for the current user and visible peers.
 *
 * Two slices:
 *  * ``onlineIds`` — the live socket set: ``true`` iff the peer currently has
 *    at least one open WS. Mutated by ``seed()`` (per-ready rewrite), the
 *    ``presence_update`` op (connect/disconnect) and by ``applyStatusChange``
 *    (which mirrors status=='offline' into the set so the two stay in sync).
 *  * ``statuses`` — Etappe-3 status map (online/idle/dnd/offline) for visible
 *    peers, plus ``myStatus`` for the caller's own *real* status (never
 *    masked — the wire payload sends our own status separately so we can
 *    show ``invisible`` in our own UI even though peers see ``offline``).
 *
 * Read-side semantics: ``isOnline()`` and ``displayStatus()`` treat socket
 * presence as the source of truth for online/offline and only consult
 * ``statuses`` for explicit idle/dnd choices on top of "currently online".
 * That way a friend who disconnects immediately flips back to "offline"
 * instead of being stuck on the last cached "dnd" until they reconnect.
 *
 * Seeding contract: ``ready`` calls ``seed()`` for ``onlineIds`` and
 * ``seedStatuses()`` for the status map. The ``presence_status_changed``
 * event is the canonical mutator; ``presence_update`` only flips the
 * boolean.
 */

import { currentServerUserId } from '$lib/stores/currentServerUser';

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
    if (online) this.onlineIds.add(userId);
    else this.onlineIds.delete(userId);
    // Svelte 5 $state<Set> doesn't track Set mutation — reassign for reactivity.
    this.onlineIds = this.onlineIds;
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
    // Eigener User: aus dem ECHTEN Selbst-Status ableiten, nicht aus der
    // Legacy-Online-Menge (der eigene Socket ist immer "online"). Unsichtbar
    // muss sich für einen selbst wie offline lesen — sonst sieht man sich oben
    // in der "Online"-Gruppe, während alle anderen einen offline sehen.
    if (userId === currentServerUserId()) return this.myStatus !== 'invisible';
    // Socket-Präsenz ist die Quelle der Wahrheit für "gerade online". Ein
    // veralteter ``statuses``-Eintrag (z.B. "dnd" von vor dem Disconnect,
    // oder stehengengebliebene Cloud-Freunde nach einem Server-Switch —
    // siehe Kommentar in ``multi-server-reset.ts``) darf nicht über den
    // aktuellen Socket-Zustand triumphieren. Wer nicht in ``onlineIds``
    // steht, ist offline, egal was die letzte bekannte Wahl war.
    if (!this.onlineIds.has(userId)) return false;
    // Explizites ``offline`` (peerseitige Maskierung von ``invisible``) bei
    // gleichzeitig offenem Socket ist ein Widerspruch — der Peer ist live
    // verbunden, also als online zählen.
    return this.statuses[userId] !== 'offline';
  }

  /** Resolve the status string for ``userId`` — the canonical helper for
   *  any presence-dot rendering. Socket presence wins; ``statuses`` only
   *  contributes explicit idle/dnd choices for currently-online peers.
   *  Returns ``'offline'`` for any peer without an open socket, so the
   *  Online filter cannot leak stale values from a disconnected friend. */
  displayStatus(userId: string): PresenceStatus {
    if (userId === currentServerUserId()) {
      const s = this.myStatus;
      return s === 'invisible' ? 'offline' : s;
    }
    // Siehe ``isOnline``: kein Socket → offline. Das schließt sowohl den
    // Disconnect eines Cloud-Freundes (presence_update offline) als auch
    // den Server-Switch-Fall (Cloud-Background bleibt, onlineIds ist auf
    // den aktiven Server frisch geseedet — der getrennte Peer fehlt) ab.
    if (!this.onlineIds.has(userId)) return 'offline';
    const explicit = this.statuses[userId];
    // Peerseitig maskierte ``invisible``-Peers landen als ``offline`` in
    // der Map, sind aber sehr wohl live verbunden (wir haben den Socket
    // gerade geprüft). Online als Default lesen — der explizite
    // Server-Mask hat hier nur historische Bedeutung.
    if (explicit === undefined || explicit === 'offline') return 'online';
    return explicit;
  }

  clear(): void {
    this.onlineIds = new Set();
    this.statuses = {};
    this.myStatus = 'online';
  }
}

export const presence = new PresenceStore();
