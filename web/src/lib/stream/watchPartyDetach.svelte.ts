/**
 * Watch-Party-Detach — analog zu `detach.svelte.ts` für HQ-Streams. Da mehrere
 * Partys pro Channel laufen können, ist alles per `(channelId, partyId)` gekeyt.
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
/** Window-scoped suppress marker. sessionStorage (not the reactive `#set`) is
 * what `shouldSuppressLeave` actually reads: it is one store per window
 * regardless of how many times the module gets evaluated (HMR / dual-eval), and
 * it is set *before* `window.open()` so the inline tile's unmount — which can
 * fire synchronously off the focus-steal of opening the popup, i.e. before the
 * reactive `#set` write — still sees the marker. Time-stamped so a stale value
 * can never suppress forever. */
const SUPPRESS_PREFIX = 'pulse:wp-suppress-leave:';
const SUPPRESS_TTL_MS = 30_000;

/** Composite key — several parties can be detached from one channel. */
function pkey(channelId: string, partyId: string): string {
  return `${channelId} ${partyId}`;
}

type WatchDetachMessage =
  | { kind: 'closed'; cid: string; pid: string }
  | { kind: 'close'; cid: string; pid: string };

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
      if (m.kind === 'closed') this.#markAttached(m.cid, m.pid);
    };
  }

  /** Start the sweep poll when the first popup is opened; stop when all are closed. */
  #ensurePollRunning(): void {
    if (this.#pollTimer === null && this.#windows.size > 0) {
      this.#pollTimer = setInterval(() => this.#sweepClosedWindows(), 800);
    }
  }

  /** Stop the poll if no more windows are being tracked. */
  #ensurePollStopped(): void {
    if (this.#pollTimer !== null && this.#windows.size === 0) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }
  }

  has(channelId: string, partyId: string): boolean {
    return this.#set.has(pkey(channelId, partyId));
  }

  /** Whether a tile unmounting for this party should SKIP its `watch_leave`.
   * True while the party is detached into a popup: the inline tile unmounts the
   * instant `open()` flips `#set`, but the popup runs in a fresh window with its
   * own gateway session and needs a cold-start (auth → connect → ready → join)
   * before it joins the watcher set. A `watch_leave` from the inline tile in
   * that gap is the host's *last* socket leaving → the server ends the party
   * (`end_if_host`) before the popup can take over. Suppressing it keeps the
   * main-window socket as the watcher anchor until the popup is up; the popup's
   * own join is purely additive (same user, sibling socket). */
  shouldSuppressLeave(channelId: string, partyId: string): boolean {
    try {
      const raw = sessionStorage.getItem(SUPPRESS_PREFIX + pkey(channelId, partyId));
      if (raw && Date.now() - Number(raw) < SUPPRESS_TTL_MS) return true;
    } catch {
      /* sessionStorage unavailable — fall through to the reactive flag */
    }
    return this.#set.has(pkey(channelId, partyId));
  }

  open(channelId: string, partyId: string): boolean {
    const k = pkey(channelId, partyId);
    const existing = this.#windows.get(k);
    if (existing && !existing.closed) {
      existing.focus();
      return true;
    }
    const url = `/watch-popup/${encodeURIComponent(channelId)}/${encodeURIComponent(partyId)}`;
    const w = 1100;
    const h = 680;
    const x = Math.round((window.screen.availWidth - w) / 2);
    const y = Math.round((window.screen.availHeight - h) / 2);
    const features = `popup=yes,width=${w},height=${h},left=${x},top=${y},resizable=yes`;
    // Mark BEFORE window.open(): opening the popup steals focus, which can
    // synchronously unmount the inline tile (→ its `watch_leave` cleanup) before
    // the reactive `#set` write below lands. The sessionStorage marker is what
    // `shouldSuppressLeave` reads, so it must be set first.
    try {
      sessionStorage.setItem(SUPPRESS_PREFIX + k, String(Date.now()));
    } catch {
      /* ignore */
    }
    const popup = window.open(url, `pulse-watch-${k}`, features);
    if (!popup) {
      try {
        sessionStorage.removeItem(SUPPRESS_PREFIX + k);
      } catch {
        /* ignore */
      }
      return false;
    }
    this.#windows.set(k, popup);
    this.#set = new Set(this.#set).add(k);
    this.#ensurePollRunning();
    return true;
  }

  reattach(channelId: string, partyId: string): void {
    const k = pkey(channelId, partyId);
    const w = this.#windows.get(k);
    if (w && !w.closed) w.close();
    this.#windows.delete(k);
    this.#channel?.postMessage({
      kind: 'close',
      cid: channelId,
      pid: partyId
    } satisfies WatchDetachMessage);
    this.#markAttached(channelId, partyId);
  }

  notifyClosed(channelId: string, partyId: string): void {
    this.#channel?.postMessage({
      kind: 'closed',
      cid: channelId,
      pid: partyId
    } satisfies WatchDetachMessage);
  }

  /** The party ended while detached. Drop the detached flag so a later re-open
   * of the same party starts clean. The popup self-closes on the null-state
   * push; this just clears the main window's local tracking. The caller (the
   * `watch_state` null handler) additionally releases the main-window watcher
   * anchor, since {@link shouldSuppressLeave} held its `watch_leave` back and
   * the inline tile won't remount on an ended party to release it itself. */
  markPartyEnded(channelId: string, partyId: string): void {
    this.#markAttached(channelId, partyId);
  }

  onCloseRequest(cb: (cid: string, pid: string) => void): () => void {
    if (!this.#channel) return () => {};
    const ch = this.#channel;
    const handler = (ev: MessageEvent<WatchDetachMessage>) => {
      const m = ev.data;
      if (m && m.kind === 'close') cb(m.cid, m.pid);
    };
    ch.addEventListener('message', handler);
    return () => ch.removeEventListener('message', handler);
  }

  #markAttached(channelId: string, partyId: string): void {
    const k = pkey(channelId, partyId);
    // Handoff is over (reattach / party ended / popup closed) — drop the
    // window-scoped suppress marker so the next real unmount leaves normally.
    try {
      sessionStorage.removeItem(SUPPRESS_PREFIX + k);
    } catch {
      /* ignore */
    }
    if (!this.#set.has(k)) return;
    const next = new Set(this.#set);
    next.delete(k);
    this.#set = next;
    this.#ensurePollStopped();
  }

  #sweepClosedWindows(): void {
    for (const [k, w] of this.#windows) {
      if (w.closed) {
        this.#windows.delete(k);
        try {
          sessionStorage.removeItem(SUPPRESS_PREFIX + k);
        } catch {
          /* ignore */
        }
        if (this.#set.has(k)) {
          const next = new Set(this.#set);
          next.delete(k);
          this.#set = next;
        }
      }
    }
    this.#ensurePollStopped();
  }
}

export const detachedWatchParties = new DetachedWatchParties();
