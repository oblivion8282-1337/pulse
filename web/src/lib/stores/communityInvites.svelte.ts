/**
 * Offene Community-Einladungen (Nutzername-Einladungen an Nicht-Freunde)
 * des eingeloggten Users — Empfängerseite.
 *
 * Store-Init-Pattern wie [[friendRequests]]: geseedet aus dem ready-Frame
 * (``community_invites``), live-mutiert vom ``community_invite_received``-
 * WS-Event und den Accept/Decline-REST-Antworten; geleert vom
 * multi-server-reset (Account-/Server-Wechsel).
 */

import type { CommunityInviteNotification } from '$lib/api/communityInvites';

function _sortDescByCreated(
  a: CommunityInviteNotification,
  b: CommunityInviteNotification
): number {
  if (a.created_at === b.created_at) return 0;
  return a.created_at < b.created_at ? 1 : -1;
}

class CommunityInvitesStore {
  /** Offene Einladungen, Key = Invite-ID. */
  pending = $state<Record<string, CommunityInviteNotification>>({});

  list = $derived(Object.values(this.pending).sort(_sortDescByCreated));
  count = $derived(Object.keys(this.pending).length);

  /** Vollersatz — ready-Frame-Seeding. */
  seedAll(invites: CommunityInviteNotification[]): void {
    const map: Record<string, CommunityInviteNotification> = {};
    for (const inv of invites) map[inv.id] = inv;
    this.pending = map;
  }

  add(inv: CommunityInviteNotification): void {
    if (this.pending[inv.id]) return;
    this.pending = { ...this.pending, [inv.id]: inv };
  }

  remove(id: string): void {
    if (!(id in this.pending)) return;
    const next = { ...this.pending };
    delete next[id];
    this.pending = next;
  }

  clear(): void {
    this.pending = {};
  }
}

export const communityInvites = new CommunityInvitesStore();
