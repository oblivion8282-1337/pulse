/**
 * Anchor registry for LiveKit video tiles (webcams + screen share).
 *
 * Same mechanism as `hqStreamBackground.svelte.ts` and `watchBackground.svelte.ts`:
 * `StreamGrid` registers an anchor per open LiveKit tile (via `use:lkAnchor`),
 * and `LiveKitBackgroundHost` in the app layout renders the matching tile on
 * top of it (docked) or as a corner window when no anchor exists.
 *
 * Keyed `${channelId}::${identity}` — the LiveKit identity is unique per
 * participant and stays stable for the whole room session, even across
 * track re-subscribes.
 *
 * No "open" set here either: that lives in `openedTiles` (kind=`cam` /
 * `screen`).
 */

function rectsEqual(a: DOMRect | null, b: DOMRect | null): boolean {
  if (a === null || b === null) return a === b;
  return a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;
}

class LiveKitBackground {
  #anchorEls = new Map<string, HTMLElement>();
  #rects = $state<Map<string, DOMRect | null>>(new Map());
  #rafId: number | null = null;

  registerAnchor(channelId: string, identity: string, el: HTMLElement): () => void {
    const k = `${channelId}::${identity}`;
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

  anchorRect(channelId: string, identity: string): DOMRect | null {
    return this.#rects.get(`${channelId}::${identity}`) ?? null;
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

export const liveKitBackground = new LiveKitBackground();