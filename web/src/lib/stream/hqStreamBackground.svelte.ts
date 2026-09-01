/**
 * Anchor registry for HQ stream tiles — thin wrapper around the shared
 * `createAnchorRegistry` (user snowflake key, no "open" set: that already
 * lives in `openedTiles`).
 *
 * `StreamGrid` registers an anchor per open HQ tile; `HqStreamBackgroundHost`
 * in the app layout overlays the `WhepPlayer` on it (docked) or renders it
 * as a corner window when no anchor exists (you navigated to a text channel
 * or DM).
 */

import { createAnchorRegistry } from './anchorRegistry.svelte';

const registry = createAnchorRegistry();

export const hqStreamBackground = {
  registerAnchor(channelId: string, userId: string, el: HTMLElement): () => void {
    return registry.register(`${channelId}::${userId}`, el);
  },
  anchorRect(channelId: string, userId: string): DOMRect | null {
    return registry.rect(`${channelId}::${userId}`);
  }
};
