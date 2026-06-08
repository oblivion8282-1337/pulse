/**
 * Community-Invite REST wrapper (Global-Friends Stufe 3).
 *
 * Cloud-geroutet (`cloudRoute()`), da Community-Invites eine Cloud-Broker-
 * Funktion sind — analog zu friends.ts.
 *
 * Backend-Kontrakt (Cloud-only):
 *   POST /community-invites  {invitee_id, target_host, target_instance_id?,
 *                             target_guild_id, target_guild_name, code}
 *
 * Der Broker erzeugt serverseitig eine DM mit „Beitreten"-Karte an den
 * Invitee (`routes/community_invites.py`). Es gibt deshalb KEINE separate
 * Pending-Liste mehr — entsprechend kein GET/DELETE-Wrapper hier.
 */

import { request } from './client';
import { serversStore } from './servers.svelte';

function cloudRoute(): { serverId?: string } {
  return { serverId: serversStore.cloudId() };
}

// ---- Types ---------------------------------------------------------------

export type CommunityInvitePayload = {
  id: string;
  inviter_id: string;
  invitee_id: string;
  target_host: string;
  target_instance_id: string | null;
  target_guild_id: string;
  target_guild_name: string;
  code: string;
  created_at: string;
};

export type CreateCommunityInviteBody = {
  invitee_id: string;
  target_host: string;
  target_instance_id?: string | null;
  target_guild_id: string;
  target_guild_name: string;
  code: string;
};

// ---- API surface ---------------------------------------------------------

export const communityInvitesApi = {
  create(body: CreateCommunityInviteBody): Promise<CommunityInvitePayload> {
    return request<CommunityInvitePayload>('/community-invites', {
      method: 'POST',
      body
    }, cloudRoute());
  }
};
