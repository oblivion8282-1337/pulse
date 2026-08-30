/**
 * Community-Einladungen — die eine Schiene.
 *
 * Spiegelt ``routes/member_invites.py`` im chat-gateway. Seit 2026-08-27
 * laufen BEIDE Wege hierüber (unter Freunden und per Nutzername); der frühere
 * Weg als Karte im DM-Verlauf ist entfallen, weil der Server dafür eine
 * Nachricht im Namen des Einladenden hätte schreiben müssen — mit
 * verschlüsselten Direktnachrichten unmöglich.
 *
 * Alle Calls laufen gegen den Cloud-Server (Social-Plane), wie ``friendsApi``.
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
  /** null = Cloud-Ziel. Sonst der Server, auf dem die Community lebt. */
  target_host: string | null;
  /** Host-coined Code — der Klient joint Link-artig VOR dem Annehmen (die
   *  Karte bleibt bei Fehlschlag erhalten und wird erst bei Erfolg entfernt). */
  code: string | null;
  created_at: string;
};

export type CommunityInviteAcceptResult = {
  guild: { id: string; name: string; icon_url: string | null };
  channel_id: string | null;
  /** Nur bei einer Einladung auf einen fremden Server gesetzt: die Cloud legt
   *  dort keine Mitgliedschaft an, sondern reicht Ziel und Code zurück — der
   *  Beitritt läuft danach über den normalen Einladungsweg gegen den Host. */
  target_host?: string | null;
  code?: string | null;
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
