/**
 * Per-viewer local "hide" for stream-grid tiles. The publisher's track / WHEP
 * push / watch-party state keeps flowing — only the local UI suppresses the
 * tile so the viewer can dismiss what they don't want to watch (without
 * affecting anyone else).
 *
 * Keyed by `<kind>::<channelId>::<id>`. Hidden state is in-memory only and
 * gets cleared on channel switch via `resetChannel`.
 *
 *   kind="cam"    → id = LiveKit participant identity
 *   kind="screen" → id = LiveKit participant identity
 *   kind="hq"     → id = user id (snowflake)
 *   kind="party"  → id = "_" (one party per channel)
 */
export type TileKind = 'cam' | 'screen' | 'hq' | 'party';

class HiddenTiles {
  #set = $state<Set<string>>(new Set());

  #key(kind: TileKind, channelId: string, id: string): string {
    return `${kind}::${channelId}::${id}`;
  }

  has(kind: TileKind, channelId: string, id: string): boolean {
    return this.#set.has(this.#key(kind, channelId, id));
  }

  hide(kind: TileKind, channelId: string, id: string): void {
    const k = this.#key(kind, channelId, id);
    if (this.#set.has(k)) return;
    this.#set = new Set(this.#set).add(k);
  }

  unhide(kind: TileKind, channelId: string, id: string): void {
    const k = this.#key(kind, channelId, id);
    if (!this.#set.has(k)) return;
    const next = new Set(this.#set);
    next.delete(k);
    this.#set = next;
  }

  /** Drop all hides for a channel — used on channel switch. */
  resetChannel(channelId: string): void {
    const marker = `::${channelId}::`;
    let changed = false;
    const next = new Set(this.#set);
    for (const k of this.#set) {
      if (k.includes(marker)) {
        next.delete(k);
        changed = true;
      }
    }
    if (changed) this.#set = next;
  }
}

export const hiddenTiles = new HiddenTiles();
