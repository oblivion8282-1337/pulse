/**
 * Einladungs-Benachrichtigungen an Nicht-Freunde (Cloud-only, v1).
 *
 * Spiegelt ``routes/member_invites.py`` im chat-gateway. Fährt auf den
 * Schienen der Freundschaftsanfragen (Annehmen/Ablehnen beim Empfänger),
 * NICHT als DM — DMs bleiben strikt friends-only. Alle Calls laufen gegen
 * den Cloud-Server (Social-Plane), wie ``friendsApi``.
 */

import { request } from './client';
import { serversStore } from './servers.svelte';

export type CommunityInviteNotification = {
  id: string;
  guild_id: string;
  /** Denormalisiert — der Empfänger ist (noch) kein Member. */
  guild_name: string;
  inviter_user_id: string;
  invitee_user_id: string;
  status: 'pending' | 'accepted' | 'declined';
  created_at: string;
};

export type CommunityInviteAcceptResult = {
  guild: { id: string; name: string; icon_url: string | null };
  channel_id: string | null;
};

function cloudRoute(): { serverId?: string } {
  return { serverId: serversStore.cloudId() };
}

export const communityInvitesApi = {
  /** Cloud-User per Nutzername in die Community einladen (CREATE_INVITES). */
  send(guildId: string, username: string): Promise<CommunityInviteNotification> {
    return request<CommunityInviteNotification>(
      `/guilds/${guildId}/member-invites`,
      { method: 'POST', body: { username } },
      cloudRoute()
    );
  },

  /** Eigene offene Einladungen (mit Community-Name). */
  listMine(): Promise<CommunityInviteNotification[]> {
    return request<CommunityInviteNotification[]>('/me/community-invites', {}, cloudRoute());
  },

  /** Annehmen → Membership; Antwort wie der Invite-Code-Beitritt
   *  (Guild + Ziel-Channel für die Navigation). */
  accept(id: string): Promise<CommunityInviteAcceptResult> {
    return request<CommunityInviteAcceptResult>(
      `/me/community-invites/${id}/accept`,
      { method: 'POST' },
      cloudRoute()
    );
  },

  decline(id: string): Promise<void> {
    return request<void>(`/me/community-invites/${id}/decline`, { method: 'POST' }, cloudRoute());
  }
};
