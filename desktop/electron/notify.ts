/**
 * Pulse desktop shell — system notifications (mention/DM toasts, E2).
 *
 * The renderer decides WHEN to fire (only when `document.hidden ||
 * !document.hasFocus()`); this module just shows the system notification
 * unconditionally and forwards clicks back so the renderer can route to the
 * right channel/message. One source of truth for "should we toast now" — the
 * renderer — avoids two-headed focus-detection bugs.
 *
 * Linux quirk: Electron's `icon` is a *file path* (or NativeImage). HTTP(s)
 * URLs are silently dropped here — libnotify can't async-fetch them, so
 * passing a URL would just yield a notification without an icon. Local file
 * paths (e.g. a future avatar cache) pass through unchanged. The renderer
 * should send `undefined` for remote avatars rather than the URL.
 */

import { app, BrowserWindow, Notification, ipcMain } from 'electron';
import * as path from 'node:path';

export interface NotifyPayload {
  title: string;
  body: string;
  icon?: string;
  channel_id: string;
  guild_id?: string | null;
  message_id: string;
  target_url?: string;
}

export interface NotifyClickPayload {
  channel_id: string;
  guild_id?: string | null;
  message_id: string;
  target_url?: string | null;
}

/**
 * Validate the renderer-supplied click target. It is forwarded back to the
 * renderer and fed to SvelteKit's `goto`, so it must be an in-app absolute
 * path ("/app/..."). Reject external URLs, protocol-relative ("//evil.com"),
 * and non-absolute paths so a compromised renderer can't navigate elsewhere.
 */
function sanitiseTargetUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  if (!raw.startsWith('/')) return undefined;
  if (raw.startsWith('//')) return undefined;
  return raw.slice(0, 512);
}

let notifySeq = 0;

/** Maximum number of live `Notification` objects to keep. Older entries are
 *  closed and evicted when the cap is exceeded, bounding memory growth from
 *  unclicked notifications that persist in the OS notification centre
 *  (finding 160). */
const MAX_LIVE_NOTIFICATIONS = 50;
/** Insertion-ordered map from notification id → Notification instance. */
const liveNotifications = new Map<string, Notification>();

function evictOldestNotification(): void {
  const firstKey = liveNotifications.keys().next().value;
  if (firstKey === undefined) return;
  const old = liveNotifications.get(firstKey);
  liveNotifications.delete(firstKey);
  try { old?.close(); } catch { /* ignore */ }
}

/**
 * Validate the icon field from the renderer.
 *
 * Security (finding 161): the icon value comes from the renderer and could
 * be any string. We must not forward arbitrary paths to libnotify / the OS
 * notification system — doing so lets a compromised renderer cause the
 * notification daemon to read (and potentially probe) arbitrary local files.
 *
 * Accepted: a local path that is strictly inside the app's own resource
 * directory (e.g. packaged assets under `process.resourcesPath`). Everything
 * else — HTTP(s) URLs, `file://` URIs, absolute paths outside app resources,
 * and relative paths — is rejected and the icon is dropped.
 *
 * Currently the only call site passes `undefined` (chat.ts), so this guard
 * is latent protection for future callers.
 */
function sanitiseIcon(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  // Reject HTTP(s) URLs — libnotify can't async-fetch them anyway (silently
  // shows no icon), but we make the rejection explicit.
  if (raw.startsWith('http://') || raw.startsWith('https://')) return undefined;
  // Reject file:// URIs — convert to a path first and re-validate below.
  if (raw.startsWith('file://')) return undefined;
  // Only accept absolute paths.
  if (!path.isAbsolute(raw)) return undefined;
  // Require the path to be within the app's resource directory so the
  // notification daemon cannot be directed at arbitrary files.
  const resourcesDir = process.resourcesPath ?? path.join(app.getAppPath(), '..');
  const resolved = path.resolve(raw);
  if (!resolved.startsWith(resourcesDir + path.sep) && resolved !== resourcesDir) {
    return undefined;
  }
  return resolved;
}

export function wireNotify(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('notify:show', async (_e, payload: NotifyPayload): Promise<string> => {
    const id = `${Date.now().toString(36)}-${(++notifySeq).toString(36)}`;
    if (!Notification.isSupported()) return id;

    // Runtime type guards: validate renderer-supplied payload fields (finding 157).
    // TypeScript types are erased at runtime, so we must check explicitly.
    if (!payload || typeof payload !== 'object') return id;
    if (typeof payload.title !== 'string' || typeof payload.body !== 'string') return id;
    if (typeof payload.channel_id !== 'string' || typeof payload.message_id !== 'string') return id;
    if (payload.guild_id !== null && payload.guild_id !== undefined && typeof payload.guild_id !== 'string') return id;
    // Clamp title and body to reasonable lengths to avoid memory/rendering issues.
    const title = payload.title.slice(0, 256);
    const body = payload.body.slice(0, 1024);

    const icon = sanitiseIcon(payload.icon);
    const notif = new Notification({
      title,
      body,
      icon,
      silent: false,
    });
    const click: NotifyClickPayload = {
      channel_id: payload.channel_id,
      guild_id: payload.guild_id ?? null,
      message_id: payload.message_id,
      target_url: sanitiseTargetUrl(payload.target_url) ?? null,
    };
    notif.on('click', () => {
      // Remove from the live map when clicked so it is GC'd promptly.
      liveNotifications.delete(id);
      const win = getWindow();
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      if (!win.webContents.isDestroyed()) {
        win.webContents.send('notify:click', click);
      }
    });
    // Evict oldest if we have hit the cap, then track this new notification.
    if (liveNotifications.size >= MAX_LIVE_NOTIFICATIONS) evictOldestNotification();
    liveNotifications.set(id, notif);
    try {
      notif.show();
    } catch (e) {
      console.error('[notify] show failed:', e);
      liveNotifications.delete(id);
    }
    return id;
  });
}
