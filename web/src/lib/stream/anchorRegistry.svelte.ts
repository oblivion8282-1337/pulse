/**
 * Generischer Anker-Registry: Elemente werden unter einem String-Key
 * registriert, ein einzelner rAF-Ticker misst ihre Rects und schreibt nur
 * bei tatsächlicher Änderung in den reaktiven Store (kein Thrash bei
 * Resize/Navigation). Aktiv nur, solange ≥ 1 Anker registriert ist.
 *
 * Verwandte Instanzen: `hqStreamBackground`, `liveKitBackground`,
 * `watchBackground` — alle vorher Byte-identische Klassenkopien.
 */

function rectsEqual(a: DOMRect | null, b: DOMRect | null): boolean {
  if (a === null || b === null) return a === b;
  return a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;
}

export type AnchorRegistry = {
  /** Anker registrieren; gibt die Unregister-Funktion zurück. */
  register(key: string, el: HTMLElement): () => void;
  /** Zuletzt gemessenes Rect oder null (kein Anker). */
  rect(key: string): DOMRect | null;
};

export function createAnchorRegistry(): AnchorRegistry {
  const anchorEls = new Map<string, HTMLElement>();
  let rects = $state<Map<string, DOMRect | null>>(new Map());
  let rafId: number | null = null;

  function ensureTicker(): void {
    if (rafId !== null || typeof requestAnimationFrame === 'undefined') return;
    const tick = (): void => {
      let next: Map<string, DOMRect | null> | null = null;
      for (const [k, el] of anchorEls) {
        const rect = el.getBoundingClientRect();
        if (!rectsEqual(rects.get(k) ?? null, rect)) {
          next ??= new Map(rects);
          next.set(k, rect);
        }
      }
      if (next) rects = next;
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  function stopTicker(): void {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  return {
    register(key, el) {
      anchorEls.set(key, el);
      // Measure immediately so the docked overlay has a rect before the first
      // rAF frame (no flash); the ticker keeps it in sync afterwards.
      const rect = el.getBoundingClientRect();
      if (!rectsEqual(rects.get(key) ?? null, rect)) {
        const next = new Map(rects);
        next.set(key, rect);
        rects = next;
      }
      ensureTicker();
      return () => {
        anchorEls.delete(key);
        if (rects.has(key)) {
          const next = new Map(rects);
          next.delete(key);
          rects = next;
        }
        if (anchorEls.size === 0) stopTicker();
      };
    },
    rect(key) {
      return rects.get(key) ?? null;
    }
  };
}
