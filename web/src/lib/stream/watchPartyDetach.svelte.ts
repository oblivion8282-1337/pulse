/**
 * Watch-Party-Detach — analog zu `detach.svelte.ts` für HQ-Streams, aber
 * per-Channel (eine Party pro Channel, kein User-ID-Tupel).
 *
 * Architektur ist sauberer als das ScreenShare-Detach: der Watch-Party-
 * Player ist client-rendered (YouTube/Twitch-iframe oder NativeVideo) —
 * jedes Fenster mountet seinen eigenen Player, syncronisiert sich über die
 * Gateway-WS-Heartbeats. Host-Duties wandern automatisch mit, weil nur ein
 * Fenster zur Zeit den `<WatchPartyTile>` gemountet hat: Main *oder* Popup.
 *
 * BroadcastChannel-Sync mit dem Hauptfenster: 'close' (Main fordert Popup
 * zum Schließen auf, z.B. wenn die Party endet) + 'closed' (Popup meldet
 * Schließung beim Hauptfenster, damit der Player wieder inline mountet).
 */
const CHANNEL_NAME = 'pulse:watch-party-detach';

type WatchDetachMessage =
  | { kind: 'closed'; cid: string }
  | { kind: 'close'; cid: string };

class DetachedWatchParties {
  #set = $state<Set<string>>(new Set());
  #windows = new Map<string, Window>();
  #channel: BroadcastChannel | null = null;
  #pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    if (typeof window === 'undefined') return;
    this.#channel = new BroadcastChannel(CHANNEL_NAME);
    this.#channel.onmessage = (ev: MessageEvent<WatchDetachMessage>) => {
      const m = ev.data;
      if (!m || typeof m !== 'object') return;
      if (m.kind === 'closed') this.#markAttached(m.cid);
    };
    this.#pollTimer = setInterval(() => this.#sweepClosedWindows(), 800);
  }

  has(channelId: string): boolean {
    return this.#set.has(channelId);
  }

  open(channelId: string): boolean {
    const existing = this.#windows.get(channelId);
    if (existing && !existing.closed) {
      existing.focus();
      return true;
    }
    const url = `/watch-popup/${encodeURIComponent(channelId)}`;
    const w = 1100;
    const h = 680;
    const x = Math.round((window.screen.availWidth - w) / 2);
    const y = Math.round((window.screen.availHeight - h) / 2);
    const features = `popup=yes,width=${w},height=${h},left=${x},top=${y},resizable=yes`;
    const popup = window.open(url, `pulse-watch-${channelId}`, features);
    if (!popup) return false;
    this.#windows.set(channelId, popup);
    this.#set = new Set(this.#set).add(channelId);
    return true;
  }

  reattach(channelId: string): void {
    const w = this.#windows.get(channelId);
    if (w && !w.closed) w.close();
    this.#windows.delete(channelId);
    this.#channel?.postMessage({ kind: 'close', cid: channelId } satisfies WatchDetachMessage);
    this.#markAttached(channelId);
  }

  notifyClosed(channelId: string): void {
    this.#channel?.postMessage({ kind: 'closed', cid: channelId } satisfies WatchDetachMessage);
  }

  onCloseRequest(cb: (cid: string) => void): () => void {
    if (!this.#channel) return () => {};
    const ch = this.#channel;
    const handler = (ev: MessageEvent<WatchDetachMessage>) => {
      const m = ev.data;
      if (m && m.kind === 'close') cb(m.cid);
    };
    ch.addEventListener('message', handler);
    return () => ch.removeEventListener('message', handler);
  }

  #markAttached(channelId: string): void {
    if (!this.#set.has(channelId)) return;
    const next = new Set(this.#set);
    next.delete(channelId);
    this.#set = next;
  }

  #sweepClosedWindows(): void {
    for (const [k, w] of this.#windows) {
      if (w.closed) {
        this.#windows.delete(k);
        if (this.#set.has(k)) {
          const next = new Set(this.#set);
          next.delete(k);
          this.#set = next;
        }
      }
    }
  }
}

export const detachedWatchParties = new DetachedWatchParties();
