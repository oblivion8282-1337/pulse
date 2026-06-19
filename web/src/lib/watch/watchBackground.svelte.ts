// web/src/lib/watch/watchBackground.svelte.ts
/**
 * Background watch-party player state.
 *
 * Lets a watch party keep playing (audio + video) when you navigate away from
 * the voice channel you're connected to. The player is mounted ONCE in the app
 * layout (`WatchBackgroundHost`) and never unmounts on navigation — it only
 * changes position:
 *   - viewing the party's channel → overlaid on a measured anchor the
 *     `StreamGrid` renders (looks docked / in-grid);
 *   - navigated away while still in that voice channel → a fixed corner window.
 *
 * This store owns two things, both reactive:
 *  1. The per-viewer "open" set, keyed `channelId::partyId`. Unlike `openedTiles`
 *     (which clears on a viewed-channel switch), party opens live as long as the
 *     viewer keeps them — the navigate-away lifecycle is handled by the anchor
 *     action in StreamGrid (closes only when you leave the view AND aren't in
 *     that voice channel) and by the WatchBackgroundHost (voice disconnect).
 *  2. An anchor registry: StreamGrid registers an empty placeholder element per
 *     open party while its channel is viewed. The host overlays its fixed player
 *     onto that element's rect. No anchor => the host shows the corner window.
 *
 * A single rAF ticker (active only while >= 1 anchor is registered) re-reads
 * every anchor's getBoundingClientRect each frame and updates state ONLY on
 * change, so the docked overlay follows size AND position shifts (resize,
 * sidebar toggle, participants joining) without reactive thrash.
 *
 * Deliberately NO drag, focus-key, or detach state here — that machinery is what
 * made the earlier PiP attempt fragile. See the design spec.
 */

export function partyKey(channelId: string, partyId: string): string {
  return `${channelId}::${partyId}`;
}

function rectsEqual(a: DOMRect | null, b: DOMRect | null): boolean {
  if (a === null || b === null) return a === b;
  return a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;
}

class WatchBackground {
  #open = $state<Set<string>>(new Set());
  #anchorEls = new Map<string, HTMLElement>();
  #rects = $state<Map<string, DOMRect | null>>(new Map());
  #rafId: number | null = null;

  openParty(channelId: string, partyId: string): void {
    const k = partyKey(channelId, partyId);
    if (this.#open.has(k)) return;
    this.#open = new Set(this.#open).add(k);
  }

  closeParty(channelId: string, partyId: string): void {
    const k = partyKey(channelId, partyId);
    if (!this.#open.has(k)) return;
    const next = new Set(this.#open);
    next.delete(k);
    this.#open = next;
  }

  isOpenParty(channelId: string, partyId: string): boolean {
    return this.#open.has(partyKey(channelId, partyId));
  }

  openParties(): { channelId: string; partyId: string }[] {
    const out: { channelId: string; partyId: string }[] = [];
    for (const k of this.#open) {
      const sep = k.indexOf('::');
      if (sep < 0) continue;
      out.push({ channelId: k.slice(0, sep), partyId: k.slice(sep + 2) });
    }
    return out;
  }

  /** Drop every open party in a channel — used when the voice connection drops. */
  resetChannel(channelId: string): void {
    const prefix = `${channelId}::`;
    let changed = false;
    const next = new Set(this.#open);
    for (const k of this.#open) {
      if (k.startsWith(prefix)) {
        next.delete(k);
        changed = true;
      }
    }
    if (changed) this.#open = next;
  }

  registerAnchor(channelId: string, partyId: string, el: HTMLElement): () => void {
    const k = partyKey(channelId, partyId);
    this.#anchorEls.set(k, el);
    // Measure immediately so the docked overlay has a rect before the first
    // rAF frame (no flash); the ticker keeps it in sync afterwards.
    const rect = el.getBoundingClientRect();
    if (!rectsEqual(this.#rects.get(k) ?? null, rect)) {
      const next = new Map(this.#rects);
      next.set(k, rect);
      this.#rects = next;
    }
    this.#ensureTicker();
    return () => {
      this.#anchorEls.delete(k);
      if (this.#rects.has(k)) {
        const next = new Map(this.#rects);
        next.delete(k);
        this.#rects = next;
      }
      if (this.#anchorEls.size === 0) this.#stopTicker();
    };
  }

  anchorRect(channelId: string, partyId: string): DOMRect | null {
    return this.#rects.get(partyKey(channelId, partyId)) ?? null;
  }

  #ensureTicker(): void {
    if (this.#rafId !== null || typeof requestAnimationFrame === 'undefined') return;
    const tick = (): void => {
      let next: Map<string, DOMRect | null> | null = null;
      for (const [k, el] of this.#anchorEls) {
        const rect = el.getBoundingClientRect();
        if (!rectsEqual(this.#rects.get(k) ?? null, rect)) {
          next ??= new Map(this.#rects);
          next.set(k, rect);
        }
      }
      if (next) this.#rects = next;
      this.#rafId = requestAnimationFrame(tick);
    };
    this.#rafId = requestAnimationFrame(tick);
  }

  #stopTicker(): void {
    if (this.#rafId !== null) {
      cancelAnimationFrame(this.#rafId);
      this.#rafId = null;
    }
  }
}

export const watchBackground = new WatchBackground();
