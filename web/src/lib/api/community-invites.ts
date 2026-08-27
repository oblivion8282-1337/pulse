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
 * Der Broker legt seit 2026-08-27 eine Zeile in der Einladungs-Inbox an und
 * schickt `community_invite_received` (`routes/community_invites.py`) —
 * KEINE DM mehr. Gelesen und beantwortet wird über `communityInvites.ts`;
 * deshalb gibt es hier weiterhin nur den Erstell-Aufruf.
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
