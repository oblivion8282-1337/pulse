/**
 * Typed wrappers around the chat-gateway notifications endpoints. Backend
 * routes (mounted under `/api/chat/notifications/...`):
 *
 *  - `GET  /notifications/vapid-public-key`  → `{public_key}` (503 if disabled)
 *  - `POST /notifications/subscribe`         → 204
 *  - `DELETE /notifications/subscribe`       → 204
 *  - `GET  /notifications/subscriptions`     → list of subs
 *
 * Kept here (and not folded into `chat.ts`) so the file stays small + so the
 * push code path is easy to delete-and-replace later if we change provider.
 */

import { request, ApiError } from '$lib/api/client';

export type VapidKey = { public_key: string };

export type SubscriptionDescriptor = {
  id: string;
  endpoint: string;
  user_agent: string | null;
  created_at: string;
  last_used_at: string | null;
};

export type PushSubscriptionPayload = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  user_agent?: string;
};

/**
 * Backend returns 503 with `{"detail":"push_disabled"}` when no VAPID keys are
 * configured. We surface that as `null` so the caller can render a friendly
 * "not configured on this server" hint without inspecting status codes.
 */
export async function fetchVapidPublicKey(): Promise<string | null> {
  try {
    const r = await request<VapidKey>('/notifications/vapid-public-key');
    return r.public_key;
  } catch (e) {
    if (e instanceof ApiError && e.status === 503) return null;
    throw e;
  }
}

export async function postPushSubscription(p: PushSubscriptionPayload): Promise<void> {
  await request<void>('/notifications/subscribe', { method: 'POST', body: p });
}

export async function deletePushSubscription(endpoint: string): Promise<void> {
  await request<void>('/notifications/subscribe', {
    method: 'DELETE',
    body: { endpoint }
  });
}

export async function listSubscriptions(): Promise<SubscriptionDescriptor[]> {
  return request<SubscriptionDescriptor[]>('/notifications/subscriptions');
}
