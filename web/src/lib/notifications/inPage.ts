/**
 * In-page (tab open, not focused) notification path.
 *
 * Fired from the WS `mention_added` and `dm_bump` handlers (`lib/ws/connection.ts`).
 * The push-service-worker path will *also* trigger when the user is subscribed,
 * but the OS notification system collapses on the shared `tag` (= message_id)
 * so the user sees one popup, not two — whichever transport gets there first
 * wins. This in-page path is mostly a latency win (WS arrives faster than push
 * for own-server users) and the only path when push is unsupported / denied.
 *
 * Click routing for in-page notifications mirrors the SW: an `<a href>`-style
 * URL is built and `goto`'d. Electron path uses `window.pulse.notify.show()`
 * and its `onClick` listener (set up in `app/+layout.svelte`).
 */

import { goto } from '$app/navigation';
import { isElectron } from '$lib/platform/runtime';
import { settings } from '$lib/stores/settings.svelte';

export type NotifyKind = 'mention' | 'dm';

export type InPageNotifyInput = {
  kind: NotifyKind;
  title: string;
  body: string;
  channelId: string;
  messageId: string;
  /** null for DMs. */
  guildId: string | null;
  iconUrl?: string | null;
};

function buildTargetUrl(channelId: string, guildId: string | null): string {
  if (!guildId) return `/app/@me/${channelId}`;
  return `/app/guilds/${guildId}/channels/${channelId}`;
}

function shouldFire(kind: NotifyKind): boolean {
  if (kind === 'mention' && !settings.notifications.onMention) return false;
  if (kind === 'dm' && !settings.notifications.onDM) return false;
  return true;
}

/**
 * Send an in-page notification if the tab is currently in the background.
 * No-op when the tab is focused (the message will appear inline) or when the
 * relevant sub-toggle is off. Browser-path also no-ops when the OS
 * permission isn't `granted` — the SW push remains the only fallback there.
 */
export function fireInPageNotification(input: InPageNotifyInput): void {
  if (typeof document === 'undefined') return;
  if (!shouldFire(input.kind)) return;
  const inBackground =
    document.visibilityState === 'hidden' || !document.hasFocus();
  if (!inBackground) return;

  if (isElectron()) {
    // Electron: hand off to the main process IPC bridge. `notify` may be
    // absent on older preload bundles — optional-chain so it degrades to
    // "no notification" rather than throw on the renderer.
    const api = window.pulse?.notify;
    if (!api) return;
    void api
      .show({
        title: input.title,
        body: input.body,
        channel_id: input.channelId,
        message_id: input.messageId,
        guild_id: input.guildId,
        icon: input.iconUrl ?? undefined
      })
      .catch(() => undefined);
    return;
  }

  // Browser path. Permission must already be `granted`; we don't prompt here.
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  try {
    const n = new Notification(input.title, {
      body: input.body,
      icon: input.iconUrl ?? '/pulse-mark.svg',
      tag: input.messageId,
      data: { channel_id: input.channelId, guild_id: input.guildId }
    });
    n.addEventListener('click', () => {
      try {
        window.focus();
      } catch {
        /* some browsers don't allow programmatic focus here */
      }
      void goto(buildTargetUrl(input.channelId, input.guildId));
      n.close();
    });
  } catch {
    /* swallow — some Safari builds throw on construct in a hidden tab */
  }
}
