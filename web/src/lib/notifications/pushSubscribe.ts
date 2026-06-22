/**
 * Browser Web-Push subscription helpers.
 *
 * The service worker (`web/src/service-worker.ts`) handles incoming push
 * events. This module is everything that lives *in the page*: feature
 * detection, permission requesting, VAPID-key conversion, and the round-trip
 * to the backend so it knows where to fan out future pushes.
 *
 * Electron is intentionally reported as "unsupported": the desktop shell
 * exposes its own `window.pulse.notify.show()` IPC bridge (see
 * `lib/platform/pulse.d.ts`), and the renderer's `Notification` API would
 * either no-op or duplicate native toasts.
 */

import { isElectron } from '$lib/platform/runtime';
import { base64UrlDecode, base64UrlEncode } from '$lib/utils/base64url';
import {
  fetchVapidPublicKey,
  postPushSubscription,
  deletePushSubscription
} from './api';

export type PushPermissionState = 'granted' | 'denied' | 'default' | 'unsupported';

/** True when this UA can subscribe to web-push. Electron renderer falls into
 *  the unsupported branch (push goes through the main process IPC). */
function pushSupported(): boolean {
  if (typeof window === 'undefined') return false;
  if (isElectron()) return false;
  return (
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export function getPushPermissionState(): PushPermissionState {
  if (!pushSupported()) return 'unsupported';
  return Notification.permission as PushPermissionState;
}

/**
 * OS-notification permission state for the *in-page* path (WS-driven toasts via
 * `inPage.ts`), independent of web-push. Unlike `getPushPermissionState` this
 * only needs the `Notification` API — no ServiceWorker/PushManager — so a
 * deployment without server-side push can still surface mention/DM/friend
 * notifications. Electron has its own native bridge → 'unsupported'.
 */
export function getNotificationPermissionState(): PushPermissionState {
  if (typeof window === 'undefined' || isElectron()) return 'unsupported';
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission as PushPermissionState;
}

/**
 * Request the OS notification permission for the in-page path only — no
 * web-push subscribe, no VAPID, no backend round-trip. Used by the settings
 * "Allow notifications" affordance so WS-driven toasts can fire even when the
 * user never enables server push (or the server has push disabled).
 */
export async function requestNotificationPermission(): Promise<PushPermissionState> {
  if (typeof window === 'undefined' || isElectron()) return 'unsupported';
  if (!('Notification' in window)) return 'unsupported';
  const result = await Notification.requestPermission();
  return result as PushPermissionState;
}

/**
 * Raw subscription → `{endpoint, keys: {p256dh, auth}}` shape the backend
 * expects. The keys come out of `getKey()` as ArrayBuffers; we base64-url
 * encode them so they round-trip through JSON.
 */
function serializeSubscription(s: PushSubscription): {
  endpoint: string;
  keys: { p256dh: string; auth: string };
} {
  const p256dhBuf = s.getKey('p256dh');
  const authBuf = s.getKey('auth');
  if (!p256dhBuf || !authBuf) {
    throw new Error('subscription missing p256dh/auth key');
  }
  return {
    endpoint: s.endpoint,
    keys: {
      p256dh: base64UrlEncode(p256dhBuf),
      auth: base64UrlEncode(authBuf)
    }
  };
}

async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  // `ready` resolves once an active SW controls the page. After a fresh page
  // load with a newly-installed SW that can be a couple hundred ms — fine,
  // permission UI is a click anyway.
  return navigator.serviceWorker.ready;
}

/** Request the OS-level notifications permission. On `granted`, immediately
 *  walks the subscribe flow. Errors during subscribe surface as a rejected
 *  promise so the UI can re-toggle off. */
export async function requestPushPermission(): Promise<PushPermissionState> {
  if (!pushSupported()) return 'unsupported';
  const result = await Notification.requestPermission();
  if (result === 'granted') {
    await subscribeUser();
  }
  return result as PushPermissionState;
}

/**
 * End-to-end: fetch VAPID → `pushManager.subscribe` → POST to backend.
 * Idempotent at the browser level (`subscribe()` returns the existing sub if
 * one is already active for the same `applicationServerKey`) so this is safe
 * to call repeatedly. Throws if the server reports push as disabled (503).
 */
export async function subscribeUser(): Promise<void> {
  if (!pushSupported()) throw new Error('push not supported');
  const reg = await getRegistration();
  if (!reg) throw new Error('no service worker registration');
  const vapid = await fetchVapidPublicKey();
  if (!vapid) throw new Error('push_disabled');
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlDecode(vapid)
  });
  const payload = serializeSubscription(sub);
  const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : undefined;
  await postPushSubscription({
    ...payload,
    user_agent: userAgent ? userAgent.substring(0, 256) : undefined
  });
}

/** Cancel the active subscription on this device + tell the backend. Best-
 *  effort: a missing local sub (already gone) still pings the backend with
 *  the previously-known endpoint if we can recover it, but it's not an
 *  error to be "already unsubscribed". */
export async function unsubscribeUser(): Promise<void> {
  if (!pushSupported()) return;
  const reg = await getRegistration();
  if (!reg) return;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  try {
    await sub.unsubscribe();
  } catch {
    /* swallow — we still want to free the server-side record */
  }
  try {
    await deletePushSubscription(endpoint);
  } catch {
    /* tolerate 404 / network — DELETE is idempotent server-side */
  }
}

/** Is there an active PushSubscription on *this* device? Used by the settings
 *  UI to decide between "Aktivieren" and "Deaktivieren". */
export async function hasActiveSubscription(): Promise<boolean> {
  if (!pushSupported()) return false;
  const reg = await getRegistration();
  if (!reg) return false;
  const sub = await reg.pushManager.getSubscription();
  return sub !== null;
}
