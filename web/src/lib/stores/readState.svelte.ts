/**
 * Per-channel unread tracking.
 *
 * Two pieces of state:
 *  - `lastReadByChannel` — the latest message id the user has acknowledged
 *    for each channel. Persisted to localStorage per-user (`pulse.readState.<uid>`).
 *  - `latestByChannel` — the latest message id we've observed for each channel
 *    in this session, in memory only.
 *
 * A channel is unread when `latest > lastRead`. Snowflake IDs are lexicographic-
 * sortable strings (same length, time-prefixed), so plain string comparison
 * works without parsing to BigInt.
 *
 * Limitation (v1): unread state seeds from activity DURING the session. If a
 * message was posted while the client was offline and never sync-loaded, the
 * channel will not show as unread on next launch. Proper offline catch-up
 * would need a server-side read-state sync — out of scope for now.
 */

const STORAGE_PREFIX = 'pulse.readState.';

class ReadState {
  lastReadByChannel = $state<Record<string, string>>({});
  latestByChannel = $state<Record<string, string>>({});

  private storageKey = '';

  hydrateForUser(userId: string): void {
    this.storageKey = `${STORAGE_PREFIX}${userId}`;
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(this.storageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          this.lastReadByChannel = parsed as Record<string, string>;
        }
      }
    } catch {
      // Corrupt localStorage — start fresh.
    }
  }

  clear(): void {
    this.storageKey = '';
    this.lastReadByChannel = {};
    this.latestByChannel = {};
  }

  /** Record that we've observed a message in this channel (from any source —
   *  WS message frame, channel_bump envelope, or an initial-load fetch). */
  recordSeen(channelId: string, messageId: string): void {
    const prev = this.latestByChannel[channelId];
    if (!prev || messageId > prev) {
      this.latestByChannel = { ...this.latestByChannel, [channelId]: messageId };
    }
  }

  /** Acknowledge the channel up to (and including) `messageId`. Falls back
   *  to the latest-seen id if none is provided. Persists immediately. */
  markRead(channelId: string, messageId?: string): void {
    const target = messageId ?? this.latestByChannel[channelId];
    if (!target) return;
    const prev = this.lastReadByChannel[channelId];
    if (!prev || target > prev) {
      this.lastReadByChannel = { ...this.lastReadByChannel, [channelId]: target };
      this.persist();
    }
  }

  isUnread(channelId: string): boolean {
    const latest = this.latestByChannel[channelId];
    if (!latest) return false;
    const lastRead = this.lastReadByChannel[channelId];
    return !lastRead || latest > lastRead;
  }

  private persist(): void {
    if (!this.storageKey || typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(this.storageKey, JSON.stringify(this.lastReadByChannel));
    } catch {
      // Quota exceeded / disabled — silently drop; in-memory state remains correct.
    }
  }
}

export const readState = new ReadState();
