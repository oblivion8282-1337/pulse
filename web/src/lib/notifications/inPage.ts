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
import { presence } from '$lib/stores/presence.svelte';
import { dispatchingServerId } from '$lib/ws/gateway-connection';
import { serversStore } from '$lib/api/servers.svelte';
import { sichtschutzAktiv } from '$lib/remote/sichtschutz';

/** True when the user has set DND — callers should suppress sounds + toasts. */
export function isDnd(): boolean {
  return presence.myStatus === 'dnd';
}

export type NotifyKind = 'mention' | 'dm' | 'friend_request' | 'friend_accept';

export type InPageNotifyInput = {
  kind: NotifyKind;
  title: string;
  body: string;
  /** Chat target — present for mention/dm, omitted for friend events. */
  channelId?: string;
  messageId?: string;
  /** null for DMs, omitted for friend events. */
  guildId?: string | null;
  /** Explicit click destination (SPA path). Overrides the channel-derived URL —
   *  used by friend events that route to /app/friends. */
  targetUrl?: string;
  iconUrl?: string | null;
};

function buildTargetUrl(input: InPageNotifyInput): string {
  if (input.targetUrl) return input.targetUrl;
  const { channelId, guildId } = input;
  if (!channelId) return '/app/friends';
  if (!guildId) return `/app/@me/${channelId}`;
  return `/app/guilds/${guildId}/channels/${channelId}`;
}

/**
 * Trust indicator for the notification title.
 *
 * A self-host server controls the entire `mention_added` / `dm_bump` payload —
 * author name, channel name and the message snippet that become the
 * notification title + body. Without an origin marker a malicious operator can
 * fire an OS-level notification that impersonates Pulse Cloud ("your password
 * was changed, verify at …") and phish the user, who trusts notifications from
 * the Pulse app.
 *
 * We prefix the title with the originating server's *hostname* — which the
 * user themselves chose when adding the server, never anything the server
 * supplies (the `label` can be server-set, the hostname cannot). Cloud
 * notifications get no prefix (clean), third-party ones are visibly attributed.
 * `dispatchingServerId()` is valid here because callers fire synchronously
 * inside WS dispatch, which sets it right before invoking handlers.
 */
function originPrefix(): string {
  const sid = dispatchingServerId();
  if (!sid) return '';
  const entry = serversStore.servers.find((s) => s.id === sid);
  if (!entry || entry.isCloud) return '';
  const host = entry.hostname.replace(/^https?:\/\//, '');
  return `[${host}] `;
}

function shouldFire(input: InPageNotifyInput): boolean {
  const kind = input.kind;
  // DND suppresses both toasts and browser notifications.
  if (presence.myStatus === 'dnd') return false;

  // Sichtschutz: jemand steuert dieses Standplatz-Gerät gerade fern
  // (`$lib/remote/sichtschutz.ts`). Dieser Weg ist der schlimmste von allen,
  // weil er das Dokument verlässt: die Betriebssystem-Meldung liegt ausserhalb
  // jedes Riegels, den der Renderer setzen kann, und bei einer Erwähnung trägt
  // sie 140 Zeichen Nachrichtentext samt Autor und Kanal nach draussen — vor
  // die Augen dessen, der gerade den Bildschirm sieht. Die Meldung fällt
  // ersatzlos aus; ungelesen bleibt sie ohnehin, der Zähler steht in der App.
  if (sichtschutzAktiv()) return false;

  // Per-server notification mode gates GUILD mentions. Discord-like: muting a
  // server silences its guild activity, not personal DMs / friend events (those
  // keep their own global sub-toggles below). The mode is per-backend-server, so
  // we look it up via the server currently dispatching this WS frame.
  // Note: with only a mention/dm in-page path today, "all" and "mentions" behave
  // identically (there is no regular-message notification); "none" is the
  // distinction that now takes effect. Forward-compatible if that path is added.
  if (kind === 'mention' && input.guildId) {
    const sid = dispatchingServerId();
    const entry = sid ? serversStore.servers.find((s) => s.id === sid) : undefined;
    if (entry?.notification_mode === 'none') return false;
  }

  if (kind === 'mention' && !settings.notifications.onMention) return false;
  if (kind === 'dm' && !settings.notifications.onDM) return false;
  if (
    (kind === 'friend_request' || kind === 'friend_accept') &&
    !settings.notifications.onFriendRequests
  )
    return false;
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
  if (!shouldFire(input)) return;
  const inBackground =
    document.visibilityState === 'hidden' || !document.hasFocus();
  if (!inBackground) return;

  // Attribute third-party (self-host) notifications so the title can't
  // impersonate Pulse Cloud — see originPrefix().
  const title = originPrefix() + input.title;

  if (isElectron()) {
    // Electron: hand off to the main process IPC bridge. `notify` may be
    // absent on older preload bundles — optional-chain so it degrades to
    // "no notification" rather than throw on the renderer.
    const api = window.pulse?.notify;
    if (!api) return;
    void api
      .show({
        title,
        body: input.body,
        channel_id: input.channelId ?? '',
        message_id: input.messageId ?? '',
        guild_id: input.guildId ?? null,
        target_url: buildTargetUrl(input),
        icon: input.iconUrl ?? undefined
      })
      .catch(() => undefined);
    return;
  }

  // Browser path. Permission must already be `granted`; we don't prompt here.
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, {
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
      void goto(buildTargetUrl(input));
      n.close();
    });
  } catch {
    /* swallow — some Safari builds throw on construct in a hidden tab */
  }
}
