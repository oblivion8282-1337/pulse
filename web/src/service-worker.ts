/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

/**
 * Pulse service worker.
 *
 * Two jobs:
 *  1. Web-Push receiver: on a `push` event we decode the JSON payload and call
 *     `showNotification(...)`. Backend payload shape (see `pushSubscribe.ts`):
 *     `{type, title, body, channel_id, message_id, guild_id?, author_name?, icon?}`.
 *  2. `notificationclick` router: focus an existing Pulse tab (and post-message
 *     it the channel/guild to navigate to) or open a new one on the right URL.
 *
 * Caching is intentionally minimal — SvelteKit's adapter-static already serves
 * everything with strong hash-based filenames + the API is uncacheable. We
 * keep a tiny precache of the build manifest so the install pass at least
 * primes the browser cache; deliberately NO offline shell yet.
 */

import { build, files, version } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE = `pulse-cache-${version}`;
const ASSETS = [...build, ...files];

sw.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).catch(() => undefined)
  );
  // New SW takes over on the next navigation rather than waiting.
  void sw.skipWaiting();
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop old versions.
      for (const key of await caches.keys()) {
        if (key !== CACHE) await caches.delete(key);
      }
      await sw.clients.claim();
    })()
  );
});

// We don't try to be an offline-first PWA yet. Pass everything through to the
// network. Keeping this listener present (even as a no-op) ensures the SW
// counts as "fetch-handling" so installability checks succeed on iOS/Android.
sw.addEventListener('fetch', () => {
  /* network only — no respondWith */
});

type PushPayload = {
  type?: string;
  title?: string;
  body?: string;
  channel_id?: string;
  message_id?: string;
  guild_id?: string | null;
  author_name?: string;
  icon?: string | null;
  /** Explicit click destination — overrides the channel-derived URL. Used by
   *  friend events that have no channel and route to /app/friends. */
  target_url?: string;
};

/**
 * Read the DND flag from IndexedDB (set by StatusPicker on status changes).
 * Falls back to ``false`` on any error (show notification by default).
 */
function readDndFromIdb(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      const req = indexedDB.open('pulse_presence', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('status');
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('status', 'readonly');
        const get = tx.objectStore('status').get('dnd');
        get.onsuccess = () => resolve(get.result === true);
        get.onerror = () => resolve(false);
      };
      req.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

sw.addEventListener('push', (event) => {
  let payload: PushPayload = {};
  try {
    payload = (event.data?.json() ?? {}) as PushPayload;
  } catch {
    // Backend might (in degraded mode) push raw text; fall back to a best-
    // effort title-only notification.
    payload = { title: event.data?.text() ?? 'Pulse' };
  }
  const title = payload.title ?? 'Pulse';
  const body = payload.body ?? '';
  const tag = payload.message_id ?? `${payload.channel_id ?? 'pulse'}-${Date.now()}`;
  const data = {
    channel_id: payload.channel_id ?? null,
    guild_id: payload.guild_id ?? null,
    message_id: payload.message_id ?? null,
    target_url: payload.target_url ?? null
  };
  event.waitUntil(
    readDndFromIdb().then((dnd) => {
      // DND: skip showNotification — badge counters keep incrementing server-side.
      if (dnd) return;
      return sw.registration.showNotification(title, {
        body,
        icon: payload.icon ?? '/pulse-mark.svg',
        badge: '/pulse-mark-white.svg',
        tag,
        // Re-fire the OS-level UI even when the same tag is reused (multiple
        // mentions in the same channel still chime + show again).
        renotify: true,
        requireInteraction: false,
        data
      });
    })
  );
});

function buildTargetUrl(channelId: string | null, guildId: string | null | undefined): string {
  if (!channelId) return '/app';
  if (guildId) return `/app/guilds/${guildId}/channels/${channelId}`;
  // DM channel.
  return `/app/@me/${channelId}`;
}

sw.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = (event.notification.data ?? {}) as {
    channel_id?: string | null;
    guild_id?: string | null;
    target_url?: string | null;
  };
  const channelId = data.channel_id ?? null;
  const guildId = data.guild_id ?? null;
  const url = data.target_url ?? buildTargetUrl(channelId, guildId);

  event.waitUntil(
    (async () => {
      const wins = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // Prefer an already-open Pulse tab. Origin-match keeps us from focusing
      // a same-browser tab on an unrelated host that happens to share the SW
      // scope (won't normally happen but cheap to guard).
      for (const c of wins) {
        try {
          const u = new URL(c.url);
          if (u.origin === sw.location.origin) {
            await c.focus();
            c.postMessage({
              type: 'navigateTo',
              url,
              channel_id: channelId,
              guild_id: guildId
            });
            return;
          }
        } catch {
          /* skip non-URL clients */
        }
      }
      if (sw.clients.openWindow) {
        await sw.clients.openWindow(url);
      }
    })()
  );
});
