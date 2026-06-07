/**
 * Friends + blocks + privacy + user-search REST wrapper.
 *
 * Backend split: ``/users/search`` lives in auth-svc, everything else in
 * chat-gateway. ``request()`` routes to the matching base via the
 * ``endpoint`` option.
 *
 * Snowflake IDs are always strings on the wire (CLAUDE.md). We mirror
 * that — no BigInt casts here.
 */

import { request } from './client';
import { serversStore } from './servers.svelte';

/** Global-Friends Stufe 1: Friends/Blocks/Privacy/Presence sind cloud-only.
 *  Jeder Call wird explizit gegen den Cloud-Server geroutet, damit er auch
 *  dann korrekt landet, wenn der aktive Server ein Self-Host ist (sonst liefe
 *  z.B. ein /friends gegen den Self-Host und käme leer/fehlerhaft zurück).
 *  `searchUsers` ist `endpoint:'auth'` → ohnehin immer Cloud (buildUrl). */
function cloudRoute(): { serverId?: string } {
  return { serverId: serversStore.cloudId() };
}

// ---- Types ---------------------------------------------------------------

export type UserSearchHit = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
};

export type FriendRequestPayload = {
  id: string;
  sender_id: string;
  receiver_id: string;
  created_at: string;
};

export type FriendPayload = {
  user_id: string;
  since: string;
};

export type FriendRequestListResponse = {
  incoming: FriendRequestPayload[];
  outgoing: FriendRequestPayload[];
};

export type FriendRequestCreateResponse =
  | FriendRequestPayload
  | { auto_accepted: true; friendship: FriendPayload };

export type BlockPayload = {
  user_id: string;
  since: string;
};

export type PrivacyResponse = {
  dm_policy: number;
  friend_request_policy: number;
  show_in_search: boolean;
};

export type PrivacyPatch = Partial<PrivacyResponse>;

export type PresenceStatusValue = 'online' | 'idle' | 'dnd' | 'invisible';

// ---- API surface ---------------------------------------------------------

export const friendsApi = {
  // -- user search (auth-svc) ----------------------------------------------
  searchUsers(q: string, limit = 20): Promise<UserSearchHit[]> {
    const params = new URLSearchParams({ q, limit: String(limit) });
    return request<UserSearchHit[]>(`/users/search?${params.toString()}`, {
      endpoint: 'auth'
    });
  },

  // -- friend requests (chat-gateway, cloud-only) --------------------------
  sendFriendRequest(targetUserId: string): Promise<FriendRequestCreateResponse> {
    return request<FriendRequestCreateResponse>('/friend-requests', {
      method: 'POST',
      body: { target_user_id: targetUserId }
    }, cloudRoute());
  },
  listFriendRequests(
    direction: 'in' | 'out' | 'both' = 'both'
  ): Promise<FriendRequestListResponse> {
    return request<FriendRequestListResponse>(
      `/friend-requests?direction=${direction}`,
      {},
      cloudRoute()
    );
  },
  acceptRequest(id: string): Promise<FriendPayload> {
    return request<FriendPayload>(`/friend-requests/${id}/accept`, {
      method: 'POST'
    }, cloudRoute());
  },
  declineRequest(id: string): Promise<void> {
    return request<void>(`/friend-requests/${id}/decline`, { method: 'POST' }, cloudRoute());
  },
  cancelRequest(id: string): Promise<void> {
    return request<void>(`/friend-requests/${id}`, { method: 'DELETE' }, cloudRoute());
  },

  // -- friendships ---------------------------------------------------------
  listFriends(): Promise<FriendPayload[]> {
    return request<FriendPayload[]>('/friends', {}, cloudRoute());
  },
  removeFriend(userId: string): Promise<void> {
    return request<void>(`/friends/${userId}`, { method: 'DELETE' }, cloudRoute());
  },

  // -- blocks --------------------------------------------------------------
  listBlocks(): Promise<BlockPayload[]> {
    return request<BlockPayload[]>('/blocks', {}, cloudRoute());
  },
  blockUser(targetUserId: string): Promise<BlockPayload> {
    return request<BlockPayload>('/blocks', {
      method: 'POST',
      body: { target_user_id: targetUserId }
    }, cloudRoute());
  },
  unblockUser(userId: string): Promise<void> {
    return request<void>(`/blocks/${userId}`, { method: 'DELETE' }, cloudRoute());
  },

  // -- privacy -------------------------------------------------------------
  getPrivacy(): Promise<PrivacyResponse> {
    return request<PrivacyResponse>('/me/privacy', {}, cloudRoute());
  },
  updatePrivacy(patch: PrivacyPatch): Promise<PrivacyResponse> {
    return request<PrivacyResponse>('/me/privacy', { method: 'PUT', body: patch }, cloudRoute());
  },

  // -- presence ------------------------------------------------------------
  setPresenceStatus(status: PresenceStatusValue): Promise<void> {
    return request<void>('/me/presence-status', {
      method: 'PUT',
      body: { status }
    }, cloudRoute());
  }
};
