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

  // -- friend requests (chat-gateway) --------------------------------------
  sendFriendRequest(targetUserId: string): Promise<FriendRequestCreateResponse> {
    return request<FriendRequestCreateResponse>('/friend-requests', {
      method: 'POST',
      body: { target_user_id: targetUserId }
    });
  },
  listFriendRequests(
    direction: 'in' | 'out' | 'both' = 'both'
  ): Promise<FriendRequestListResponse> {
    return request<FriendRequestListResponse>(
      `/friend-requests?direction=${direction}`
    );
  },
  acceptRequest(id: string): Promise<FriendPayload> {
    return request<FriendPayload>(`/friend-requests/${id}/accept`, {
      method: 'POST'
    });
  },
  declineRequest(id: string): Promise<void> {
    return request<void>(`/friend-requests/${id}/decline`, { method: 'POST' });
  },
  cancelRequest(id: string): Promise<void> {
    return request<void>(`/friend-requests/${id}`, { method: 'DELETE' });
  },

  // -- friendships ---------------------------------------------------------
  listFriends(): Promise<FriendPayload[]> {
    return request<FriendPayload[]>('/friends');
  },
  removeFriend(userId: string): Promise<void> {
    return request<void>(`/friends/${userId}`, { method: 'DELETE' });
  },

  // -- blocks --------------------------------------------------------------
  listBlocks(): Promise<BlockPayload[]> {
    return request<BlockPayload[]>('/blocks');
  },
  blockUser(targetUserId: string): Promise<BlockPayload> {
    return request<BlockPayload>('/blocks', {
      method: 'POST',
      body: { target_user_id: targetUserId }
    });
  },
  unblockUser(userId: string): Promise<void> {
    return request<void>(`/blocks/${userId}`, { method: 'DELETE' });
  },

  // -- privacy -------------------------------------------------------------
  getPrivacy(): Promise<PrivacyResponse> {
    return request<PrivacyResponse>('/me/privacy');
  },
  updatePrivacy(patch: PrivacyPatch): Promise<PrivacyResponse> {
    return request<PrivacyResponse>('/me/privacy', { method: 'PUT', body: patch });
  },

  // -- presence ------------------------------------------------------------
  setPresenceStatus(status: PresenceStatusValue): Promise<void> {
    return request<void>('/me/presence-status', {
      method: 'PUT',
      body: { status }
    });
  }
};
