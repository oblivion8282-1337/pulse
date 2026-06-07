/**
 * Pending Community Invites (Global-Friends Stufe 3).
 *
 * Hält die eingehenden Community-Invites des aktuellen Users.
 * Geseedet beim App-Init via `listCommunityInvites()`; live-mutiert durch
 * WS-Events `community_invite_received` / `community_invite_removed`.
 *
 * Wird bei Sign-Out in `resetSocialStores()` geleert.
 */

import type { CommunityInvitePayload } from '$lib/api/community-invites';

function _sortDescByCreated(
  a: CommunityInvitePayload,
  b: CommunityInvitePayload
): number {
  if (a.created_at === b.created_at) return 0;
  return a.created_at < b.created_at ? 1 : -1;
}

class CommunityInvitesStore {
  /** Alle pending incoming invites. Key = invite id. */
  private _items = $state<Record<string, CommunityInvitePayload>>({});

  incomingList = $derived(Object.values(this._items).sort(_sortDescByCreated));

  /** Setzt alle Invites auf einmal — beim Hydrate-Call. */
  seedAll(invites: CommunityInvitePayload[]): void {
    const map: Record<string, CommunityInvitePayload> = {};
    for (const inv of invites) map[inv.id] = inv;
    this._items = map;
  }

  /** Fügt einen Invite hinzu oder aktualisiert ihn (WS received). */
  upsert(inv: CommunityInvitePayload): void {
    this._items = { ...this._items, [inv.id]: inv };
  }

  /** Entfernt einen Invite (WS removed / nach Accept/Decline). */
  remove(id: string): void {
    if (!(id in this._items)) return;
    const next = { ...this._items };
    delete next[id];
    this._items = next;
  }

  clear(): void {
    this._items = {};
  }
}

export const communityInvites = new CommunityInvitesStore();
