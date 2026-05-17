/**
 * Per-viewer local "hide" for remote camera tiles. The publisher's track
 * keeps flowing — only the local UI suppresses the tile, so the viewer can
 * dismiss cams they don't want to watch (without affecting anyone else).
 *
 * Keyed by `<channelId>::<identity>`. Hidden state is in-memory only and
 * gets cleared on `reset()` (called from voice teardown / channel switch).
 */
class HiddenCameras {
  #set = $state<Set<string>>(new Set());

  #key(channelId: string, identity: string): string {
    return `${channelId}::${identity}`;
  }

  has(channelId: string, identity: string): boolean {
    return this.#set.has(this.#key(channelId, identity));
  }

  hide(channelId: string, identity: string): void {
    const k = this.#key(channelId, identity);
    if (this.#set.has(k)) return;
    this.#set = new Set(this.#set).add(k);
  }

  unhide(channelId: string, identity: string): void {
    const k = this.#key(channelId, identity);
    if (!this.#set.has(k)) return;
    const next = new Set(this.#set);
    next.delete(k);
    this.#set = next;
  }

  /** Drop all hides for a channel — used on voice disconnect / channel change. */
  resetChannel(channelId: string): void {
    const prefix = `${channelId}::`;
    let changed = false;
    const next = new Set(this.#set);
    for (const k of this.#set) {
      if (k.startsWith(prefix)) {
        next.delete(k);
        changed = true;
      }
    }
    if (changed) this.#set = next;
  }
}

export const hiddenCameras = new HiddenCameras();
