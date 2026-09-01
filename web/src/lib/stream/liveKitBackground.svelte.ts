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

import { createAnchorRegistry } from './anchorRegistry.svelte';

const registry = createAnchorRegistry();

export const liveKitBackground = {
  registerAnchor(channelId: string, identity: string, el: HTMLElement): () => void {
    return registry.register(`${channelId}::${identity}`, el);
  },
  anchorRect(channelId: string, identity: string): DOMRect | null {
    return registry.rect(`${channelId}::${identity}`);
  }
};
