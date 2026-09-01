/**
 * Watch-Party-Detach — baut auf der gemeinsamen `PopupDetacher`-Basis auf.
 * Da mehrere Partys pro Channel laufen können, ist alles per
 * `(channelId, partyId)` gekeyt.
 *
 * Architektur ist sauberer als das ScreenShare-Detach: der Watch-Party-
 * Player ist client-rendered (YouTube/Twitch-iframe oder NativeVideo) —
 * jedes Fenster mountet seinen eigenen Player, syncronisiert sich über die
 * Gateway-WS-Heartbeats. Host-Duties wandern automatisch mit, weil nur ein
 * Fenster zur Zeit den `<WatchPartyTile>` gemountet hat: Main *oder* Popup.
 *
 * BroadcastChannel-Sync mit dem Hauptfenster:
 *  - 'close'  (Main → Popup): fordert das Popup zum Schließen auf, z. B. der
 *             User klickt im Hauptfenster auf „Andocken".
 *  - 'closed' (Popup → Main): Popup meldet seine Schließung, damit der Player
 *             wieder inline am Hauptfenster mountet.
 */
import { PopupDetacher } from './popupDetacher.svelte';

/** Window-scoped suppress marker. sessionStorage (not the reactive `set`) is
 * what `shouldSuppressLeave` actually reads: it is one store per window
 * regardless of how many times the module gets evaluated (HMR / dual-eval), and
 * it is set *before* `window.open()` so the inline tile's unmount — which can
 * fire synchronously off the focus-steal of opening the popup, i.e. before the
 * reactive `set` write — still sees the marker. Time-stamped so a stale value
 * can never suppress forever. */
const SUPPRESS_PREFIX = 'pulse:wp-suppress-leave:';
const SUPPRESS_TTL_MS = 30_000;

/** Composite key — several parties can be detached from one channel. */
function pkey(channelId: string, partyId: string): string {
  return `${channelId} ${partyId}`;
}

class DetachedWatchParties extends PopupDetacher<[string, string]> {
  constructor() {
    super({
      channelName: 'pulse:watch-party-detach',
      key: (channelId, partyId) => pkey(channelId, partyId),
      msg: (kind, cid, pid) => ({ kind, cid, pid }),
      parse: (m) => [m.cid as string, m.pid as string],
      popupUrl: (channelId, partyId) =>
        `/watch-popup/${encodeURIComponent(channelId)}/${encodeURIComponent(partyId)}`,
      windowName: (k) => `pulse-watch-${k}`
    });
  }

  /** Watch-Party-Marker vor `window.open()` setzen: das Öffnen klaut den
   *  Fokus, was das inline Tile synchron unmounten kann (→ `watch_leave`-
   *  Cleanup), bevor der reaktive `set`-Write unten landet. */
  protected override beforeOpen(k: string): void {
    try {
      sessionStorage.setItem(SUPPRESS_PREFIX + k, String(Date.now()));
    } catch {
      /* ignore */
    }
  }

  protected override onOpenAborted(k: string): void {
    try {
      sessionStorage.removeItem(SUPPRESS_PREFIX + k);
    } catch {
      /* ignore */
    }
  }

  /** Sweep hat ein geschlossenes Popup erkannt — auch hier den Marker lösen. */
  protected override onKeyCleared(k: string): void {
    try {
      sessionStorage.removeItem(SUPPRESS_PREFIX + k);
    } catch {
      /* ignore */
    }
  }

  /** Whether a tile unmounting for this party should SKIP its `watch_leave`.
   * True while the party is detached into a popup: the inline tile unmounts the
   * instant `open()` flips `set`, but the popup runs in a fresh window with its
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
    return this.set.has(pkey(channelId, partyId));
  }

  protected override markAttached(channelId: string, partyId: string): void {
    const k = pkey(channelId, partyId);
    // Handoff is over (reattach / party ended / popup closed) — drop the
    // window-scoped suppress marker so the next real unmount leaves normally.
    try {
      sessionStorage.removeItem(SUPPRESS_PREFIX + k);
    } catch {
      /* ignore */
    }
    // Drop the tracked window so the sweep poll can stop once the last detached
    // party reattaches — `ensurePollStopped` gates on `windows.size`.
    this.windows.delete(k);
    if (!this.set.has(k)) {
      this.ensurePollStopped();
      return;
    }
    const next = new Set(this.set);
    next.delete(k);
    this.set = next;
    this.ensurePollStopped();
  }

  /** The party ended while detached. Drop the detached flag so a later re-open
   * of the same party starts clean. The popup self-closes on the null-state
   * push; this just clears the main window's local tracking. The caller (the
   * `watch_state` null handler) additionally releases the main-window watcher
   * anchor, since {@link shouldSuppressLeave} held its `watch_leave` back and
   * the inline tile won't remount on an ended party to release it itself. */
  markPartyEnded(channelId: string, partyId: string): void {
    this.markAttached(channelId, partyId);
  }
}

export const detachedWatchParties = new DetachedWatchParties();
