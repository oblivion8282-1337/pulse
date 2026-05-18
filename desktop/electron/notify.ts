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

import { BrowserWindow, Notification, ipcMain } from 'electron';

export interface NotifyPayload {
  title: string;
  body: string;
  icon?: string;
  channel_id: string;
  guild_id?: string | null;
  message_id: string;
}

export interface NotifyClickPayload {
  channel_id: string;
  guild_id?: string | null;
  message_id: string;
}

let notifySeq = 0;

export function wireNotify(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('notify:show', async (_e, payload: NotifyPayload): Promise<string> => {
    const id = `${Date.now().toString(36)}-${(++notifySeq).toString(36)}`;
    if (!Notification.isSupported()) return id;
    // Only accept local file paths for the icon — `new Notification({icon:
    // 'https://…'})` silently shows no icon on Linux.
    const icon = payload.icon && !payload.icon.startsWith('http') ? payload.icon : undefined;
    const notif = new Notification({
      title: payload.title,
      body: payload.body,
      icon,
      silent: false,
    });
    const click: NotifyClickPayload = {
      channel_id: payload.channel_id,
      guild_id: payload.guild_id ?? null,
      message_id: payload.message_id,
    };
    notif.on('click', () => {
      const win = getWindow();
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      if (!win.webContents.isDestroyed()) {
        win.webContents.send('notify:click', click);
      }
    });
    try {
      notif.show();
    } catch (e) {
      console.error('[notify] show failed:', e);
    }
    return id;
  });
}
