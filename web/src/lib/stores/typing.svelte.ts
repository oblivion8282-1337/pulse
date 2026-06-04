/**
 * Ephemeral "user is typing" tracker for the chat composer.
 *
 * The server broadcasts a `typing` event per channel (see chat-gateway
 * `handle_typing`); we keep each (channel, user) "typing" for a short TTL and
 * drop it via a per-entry timer — no polling, so the indicator clears reactively
 * once the timer fires. A fresh `mark()` (the sender re-fires every few seconds
 * while actively typing) resets the timer, keeping the entry alive.
 *
 * Bounded by design: entries live at most `TTL_MS`, and stop being refreshed the
 * moment the other side stops typing or sends — no "typing_stop" op needed.
 */

const TTL_MS = 6000;

class TypingTracker {
  // channelId → Set of userIds currently typing there.
  #byChannel = $state<Record<string, Set<string>>>({});
  // (channelId:userId) → expiry timer handle.
  #timers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Record that `userId` is typing in `channelId` (or refresh their TTL). */
  mark(channelId: string, userId: string): void {
    const key = `${channelId}:${userId}`;
    const existing = this.#timers.get(key);
    if (existing) clearTimeout(existing);
    this.#timers.set(
      key,
      setTimeout(() => this.#clear(channelId, userId), TTL_MS)
    );

    const set = this.#byChannel[channelId];
    if (set?.has(userId)) return; // already shown — timer refresh above is enough
    const next = new Set(set);
    next.add(userId);
    this.#byChannel = { ...this.#byChannel, [channelId]: next };
  }

  /** Drop a user's typing entry *now* — called when their message arrives so
   *  "X schreibt …" vanishes the instant the message lands instead of
   *  lingering until the TTL fires. Cancels the pending expiry timer too. */
  clear(channelId: string, userId: string): void {
    const t = this.#timers.get(`${channelId}:${userId}`);
    if (t) clearTimeout(t);
    this.#clear(channelId, userId);
  }

  #clear(channelId: string, userId: string): void {
    this.#timers.delete(`${channelId}:${userId}`);
    const set = this.#byChannel[channelId];
    if (!set?.has(userId)) return;
    const next = new Set(set);
    next.delete(userId);
    const copy = { ...this.#byChannel };
    if (next.size === 0) delete copy[channelId];
    else copy[channelId] = next;
    this.#byChannel = copy;
  }

  /** Reactive: user ids typing in `channelId`, excluding `self` (you never
   *  show your own typing). Returns a stable-ish array for the template. */
  others(channelId: string | null | undefined, self: string | null | undefined): string[] {
    if (!channelId) return [];
    const set = this.#byChannel[channelId];
    if (!set) return [];
    return [...set].filter((id) => id !== self);
  }
}

export const typing = new TypingTracker();
