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
    // Trigger Svelte reactivity by re-assigning the reference.
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
    // Den autoritativen Status-Map ZUERST konsultieren: ``onlineIds`` ist die
    // server-lokale Legacy-Menge, die ``seed()`` bei jedem ready komplett
    // ersetzt — ein Switch auf einen Self-Host (dessen ready ``seed`` mit den
    // Self-Host-pairwise-IDs aufruft) würde sonst die Cloud-Freunde aus
    // ``onlineIds`` werfen, obwohl ihr Online-Status in ``statuses`` (Cloud-
    // seedStatuses/applyStatusChange) weiter korrekt ist. ID-Räume sind
    // disjunkt (Cloud-IDs vs. pairwise), also ist das Vorziehen kollisionsfrei.
    // Self-Host-Guild-Mitglieder stehen nicht in ``statuses`` → Fallback auf die
    // (für den aktiven Server frisch geseedete) Legacy-Menge.
    const status = this.statuses[userId];
    if (status !== undefined) return status !== 'offline';
    return this.onlineIds.has(userId);
  }

  /** Resolve the status string for ``userId`` — the canonical helper for
   *  any presence-dot rendering. Returns ``'offline'`` when unknown. For the
   *  caller themselves the real ``myStatus`` is used (invisible → offline-
   *  looking grey dot), so you never see yourself as online while invisible. */
  displayStatus(userId: string): PresenceStatus {
    if (userId === currentServerUserId()) {
      const s = this.myStatus;
      return s === 'invisible' ? 'offline' : s;
    }
    return this.statuses[userId] ?? 'offline';
  }

  clear(): void {
    this.onlineIds = new Set();
    this.statuses = {};
    this.myStatus = 'online';
  }
}

export const presence = new PresenceStore();
