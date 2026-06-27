/**
 * Anchor registry for HQ stream tiles — same shape as
 * `watchBackground.svelte.ts`, but for HQ streams (user snowflake key, no
 * "open" set: that already lives in `openedTiles`).
 *
 * `StreamGrid` registers an anchor per open HQ tile; `HqStreamBackgroundHost`
 * in the app layout overlays the `WhepPlayer` on it (docked) or renders it
 * as a corner window when no anchor exists (you navigated to a text channel
 * or DM).
 *
 * A single rAF ticker measures anchor rects and only writes to state on
 * actual change — the exact same pattern as `watchBackground`.
 */

function rectsEqual(a: DOMRect | null, b: DOMRect | null): boolean {
  if (a === null || b === null) return a === b;
  return a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;
}

class HqStreamBackground {
  #anchorEls = new Map<string, HTMLElement>();
  #rects = $state<Map<string, DOMRect | null>>(new Map());
  #rafId: number | null = null;

  registerAnchor(channelId: string, userId: string, el: HTMLElement): () => void {
    const k = `${channelId}::${userId}`;
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

  anchorRect(channelId: string, userId: string): DOMRect | null {
    return this.#rects.get(`${channelId}::${userId}`) ?? null;
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

export const hqStreamBackground = new HqStreamBackground();