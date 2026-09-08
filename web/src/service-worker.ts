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
 * Caching: der Install-Pass precacht den Build + Statics (gehashte Namen —
 * Cache-Treffer sind per Definition aktuell) plus den SPA-Fallback
 * ``index.html``. Seit P2.13 bedient der Fetch-Handler daraus eine
 * Offline-Shell: Navigationsanfragen fallen bei Netz-Ausfall auf den
 * Fallback zurück, Build-/Static-Assets kommen cache-first. API, WebSocket
 * und fremde Ursprünge gehen immer ans Netz — Drossel und Auth dürfen nie
 * aus dem Cache antworten.
 */

import { build, files, version } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE = `pulse-cache-${version}`;
// `files` umfasst alles aus statics/ — auch die 13 MB sherpa-onnx-WASM für
// GTCRN. Die gehören NICHT in den Install-Precache (sonst lädt jede Install
// sie herunter, auch wer das Modell nie aktiviert); der HTTP-Cache der
// Browser-Fetches reicht, die Dateien ändern sich nur bei Release-Updates.
const ASSETS = [...build, ...files].filter((p) => !p.startsWith('/gtcrn/'));
// SPA-Fallback des adapter-static — liegt NICHT in `build`, muss für die
// Offline-Navigation aber greifbar sein (P2.13).
const SPA_FALLBACK = '/index.html';
const ASSET_SET = new Set([...ASSETS, SPA_FALLBACK]);

sw.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Pro Datei einzeln tolerieren: `addAll` ist atomar — EIN 404 aus
      // `files` hätte den gesamten Precache (inkl. SPA-Fallback) leer
      // gelassen und die Offline-Shell wäre nie entstanden (Feldbefund
      // 2026-09-08). Fehlende Einzelteile füllt der Fetch-Handler nach.
      await Promise.allSettled(
        ASSETS.map((p) => cache.add(p).catch(() => undefined))
      );
      // Pflichtteil: der SPA-Fallback MUSS liegen, sonst gibt die Offline-
      // Navigation einen toten Bildschirm. Statische Server (vite preview,
      // aber auch manche nginx-Konfigurationen) 404en einen literalen
      // /index.html-Pfad — geholt wird deshalb '/', abgelegt unter dem
      // Fallback-Schlüssel.
      if (!(await cache.match(SPA_FALLBACK))) {
        try {
          const r = await fetch('/');
          if (r.ok) await cache.put(SPA_FALLBACK, r.clone());
        } catch {
          /* offline während der Installation — nächster Start versucht erneut */
        }
      }
    })()
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

/**
 * Offline-Shell (Übergabe P2.13): ohne Netz startet die App aus dem Precache
 * statt in einem toten Bildschirm — der lokale Verlauf (IndexedDB) liefert
 * dann die Daten, sobald die Hülle steht.
 *
 * - Navigationsanfragen: Netz hat Vorrang (Frische), beim Scheitern springt
 *   der SPA-Fallback aus dem Cache. Same-origin only — /api und fremde
 *   Ursprünge bleiben unberührt.
 * - Build-/Static-Assets: Cache zuerst (gehashte Dateinamen — Cache-Treffer
 *   sind per Definition aktuell), Netz füllt Lücken, Fehler laufen weiter
 *   hoch (Rufende Routen haben eigenes Fehlerhandling).
 *
 * Alles andere (API, WebSocket-Upgrades, fremde Ursprünge) geht unberührt
 * durchs Netz — Drossel- und Auth-Logik dürfen niemals aus dem Cache antworten.
 */
sw.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== sw.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(req);
        } catch {
          const cache = await caches.open(CACHE);
          return (
            (await cache.match(url.pathname)) ||
            (await cache.match(SPA_FALLBACK)) ||
            Response.error()
          );
        }
      })()
    );
    return;
  }

  if (ASSET_SET.has(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const hit = await cache.match(url.pathname);
        if (hit) return hit;
        try {
          const resp = await fetch(req);
          if (resp.ok) await cache.put(url.pathname, resp.clone());
          return resp;
        } catch {
          return Response.error();
        }
      })()
    );
  }
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
