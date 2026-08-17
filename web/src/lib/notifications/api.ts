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

/**
 * `bearerOverride`: für den Sign-Out-Pfad, wo `clearTokens()` schon synchron
 * gelaufen ist, bevor dieser (async, dynamisch importierte) Aufruf feuert —
 * `request()` fände über `loadTokens()` sonst keinen Token mehr und das
 * DELETE liefe unauthentifiziert ins Leere (Bughunt 2026-08-17, chat.md:
 * „vor dem Verwerfen der Tokens aufrufen, damit … noch autorisiert
 * durchgeht"). `auth: false` unterdrückt die automatische Bearer-Auflösung,
 * damit der übergebene Header nicht überschrieben wird.
 */
export async function deletePushSubscription(
  endpoint: string,
  bearerOverride?: string
): Promise<void> {
  await request<void>('/notifications/subscribe', {
    method: 'DELETE',
    body: { endpoint },
    ...(bearerOverride
      ? { auth: false, headers: { Authorization: `Bearer ${bearerOverride}` } }
      : {})
  });
}

export async function listSubscriptions(): Promise<SubscriptionDescriptor[]> {
  return request<SubscriptionDescriptor[]>('/notifications/subscriptions');
}
