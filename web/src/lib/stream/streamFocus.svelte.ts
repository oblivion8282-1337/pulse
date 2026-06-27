/**
 * Shared focus state for HQ / cam / screen tiles.
 *
 * Previously `focusedKey` lived as a `$state` directly inside `StreamGrid`, so
 * the focus button on a tile only worked while the tile was mounted in
 * StreamGrid (i.e. while you were viewing the voice channel). Now the tiles
 * live in `HqStreamBackgroundHost` / `LiveKitBackgroundHost` in the app
 * layout (over a docked StreamGrid anchor or as a corner window), so the
 * state has to live outside of StreamGrid — otherwise clicking focus on a
 * docked tile does nothing.
 *
 * Scoped per voice channel (key = `${kind}:${id}`): when the channel
 * changes, `StreamGrid` calls `resetForChannel()` from its cleanup so the
 * focus doesn't bleed across channels.
 *
 * Multiple StreamGrid instances are fine in theory (the state is app-wide
 * unique); in practice only one is active at a time because the channel
 * router shows exactly one voice channel at a time.
 */

export type StreamFocusKind = 'hq' | 'screen' | 'cam';

class StreamFocusStore {
  #focused = $state<{ channelId: string; key: string } | null>(null);

  get channelId(): string | null {
    return this.#focused?.channelId ?? null;
  }

  get key(): string | null {
    return this.#focused?.key ?? null;
  }

  toggle(channelId: string, kind: StreamFocusKind, id: string): void {
    const k = `${kind}:${id}`;
    if (this.#focused?.channelId === channelId && this.#focused.key === k) {
      this.#focused = null;
    } else {
      this.#focused = { channelId, key: k };
    }
  }

  isFocused(channelId: string, kind: StreamFocusKind, id: string): boolean {
    return this.#focused?.channelId === channelId && this.#focused?.key === `${kind}:${id}`;
  }

  /** Clear focus if it belongs to `channelId` — called from the StreamGrid
   *  cleanup so a channel switch doesn't leave a stale focus flag. */
  resetForChannel(channelId: string): void {
    if (this.#focused?.channelId === channelId) this.#focused = null;
  }
}

export const streamFocus = new StreamFocusStore();