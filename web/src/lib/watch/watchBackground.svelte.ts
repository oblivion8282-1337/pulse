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
 *  2. An anchor registry (shared `createAnchorRegistry`): StreamGrid registers
 *     an empty placeholder element per open party while its channel is viewed.
 *     The host overlays its fixed player onto that element's rect. No anchor =>
 *     the host shows the corner window.
 *
 * A single rAF ticker (active only while >= 1 anchor is registered) re-reads
 * every anchor's getBoundingClientRect each frame and updates state ONLY on
 * change, so the docked overlay follows size AND position shifts (resize,
 * sidebar toggle, participants joining) without reactive thrash.
 *
 * Deliberately NO drag, focus-key, or detach state here — that machinery is what
 * made the earlier PiP attempt fragile. See the design spec.
 */

import { createAnchorRegistry } from '$lib/stream/anchorRegistry.svelte';

export function partyKey(channelId: string, partyId: string): string {
  return `${channelId}::${partyId}`;
}

const anchors = createAnchorRegistry();
let open = $state<Set<string>>(new Set());

export const watchBackground = {
  openParty(channelId: string, partyId: string): void {
    const k = partyKey(channelId, partyId);
    if (open.has(k)) return;
    open = new Set(open).add(k);
  },

  closeParty(channelId: string, partyId: string): void {
    const k = partyKey(channelId, partyId);
    if (!open.has(k)) return;
    const next = new Set(open);
    next.delete(k);
    open = next;
  },

  isOpenParty(channelId: string, partyId: string): boolean {
    return open.has(partyKey(channelId, partyId));
  },

  openParties(): { channelId: string; partyId: string }[] {
    const out: { channelId: string; partyId: string }[] = [];
    for (const k of open) {
      const sep = k.indexOf('::');
      if (sep < 0) continue;
      out.push({ channelId: k.slice(0, sep), partyId: k.slice(sep + 2) });
    }
    return out;
  },

  /** Drop every open party in a channel — used when the voice connection drops. */
  resetChannel(channelId: string): void {
    const prefix = `${channelId}::`;
    let changed = false;
    const next = new Set(open);
    for (const k of open) {
      if (k.startsWith(prefix)) {
        next.delete(k);
        changed = true;
      }
    }
    if (changed) open = next;
  },

  registerAnchor(channelId: string, partyId: string, el: HTMLElement): () => void {
    return anchors.register(partyKey(channelId, partyId), el);
  },

  anchorRect(channelId: string, partyId: string): DOMRect | null {
    return anchors.rect(partyKey(channelId, partyId));
  }
};
