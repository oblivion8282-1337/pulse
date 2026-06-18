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
const MENTIONS_PREFIX = 'pulse.mentions.';

class ReadState {
  lastReadByChannel = $state<Record<string, string>>({});
  latestByChannel = $state<Record<string, string>>({});
  /** Per-channel unread @-mention counter — bumped by the WS handler
   *  when a `mention_added` event (or an inline `message` whose mentions
   *  include the current user) lands for a channel the user isn't
   *  actively viewing. Cleared by `markRead` and `clearMentions`. */
  mentionCountByChannel = $state<Record<string, number>>({});

  private storageKey = '';
  private mentionsKey = '';
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistMentionsTimer: ReturnType<typeof setTimeout> | null = null;

  hydrateForUser(userId: string): void {
    this.storageKey = `${STORAGE_PREFIX}${userId}`;
    this.mentionsKey = `${MENTIONS_PREFIX}${userId}`;
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
    try {
      const raw = window.localStorage.getItem(this.mentionsKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          this.mentionCountByChannel = parsed as Record<string, number>;
        }
      }
    } catch {
      // Corrupt → fresh counters; non-fatal.
    }
  }

  clear(): void {
    this.storageKey = '';
    this.mentionsKey = '';
    this.lastReadByChannel = {};
    this.latestByChannel = {};
    this.mentionCountByChannel = {};
  }

  /**
   * Phase 4.5: Reset-on-Server-Switch.
   *
   * Im Gegensatz zu `clear()` bleibt der localStorage-Inhalt erhalten —
   * die Persistenz ist `pulse.readState.<userId>`-keyed, **nicht**
   * server-keyed. Wir leeren nur den In-Memory-Snapshot, sodass der
   * neue Server-Connection-ready-Frame mit den eigenen Channels seeden
   * kann. `storageKey`/`mentionsKey` bleiben gesetzt, damit `markRead`
   * weiterhin in den User-Key persistiert. Der nächste Hydrate beim
   * Re-Login bzw. ein manueller `hydrateForUser(userId)` repopuliert.
   */
  resetCacheOnly(): void {
    this.lastReadByChannel = {};
    this.latestByChannel = {};
    this.mentionCountByChannel = {};
  }

  /** Drop all read-state for a deleted channel so its keys don't linger in
   *  memory or in the persisted localStorage blobs. */
  forgetChannel(channelId: string): void {
    if (channelId in this.lastReadByChannel) {
      const next = { ...this.lastReadByChannel };
      delete next[channelId];
      this.lastReadByChannel = next;
      this.persist();
    }
    if (channelId in this.latestByChannel) {
      const next = { ...this.latestByChannel };
      delete next[channelId];
      this.latestByChannel = next;
    }
    this.clearMentions(channelId);
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
   *  to the latest-seen id if none is provided. Persists immediately.
   *  Also clears any pending mention count for the channel — opening a
   *  channel mark-reads it, so the @-badge goes away in lockstep. */
  markRead(channelId: string, messageId?: string): void {
    const target = messageId ?? this.latestByChannel[channelId];
    if (!target) {
      // No new message id but we still want the mention badge to clear
      // on focus (e.g. when the user clicks an empty channel).
      this.clearMentions(channelId);
      return;
    }
    const prev = this.lastReadByChannel[channelId];
    if (!prev || target > prev) {
      this.lastReadByChannel = { ...this.lastReadByChannel, [channelId]: target };
      this.persist();
    }
    this.clearMentions(channelId);
  }

  isUnread(channelId: string): boolean {
    const latest = this.latestByChannel[channelId];
    if (!latest) return false;
    const lastRead = this.lastReadByChannel[channelId];
    return !lastRead || latest > lastRead;
  }

  /** Bump the per-channel @-mention counter by one. */
  incMention(channelId: string): void {
    const prev = this.mentionCountByChannel[channelId] ?? 0;
    this.mentionCountByChannel = {
      ...this.mentionCountByChannel,
      [channelId]: prev + 1
    };
    this.persistMentions();
  }

  /** Zero the counter for a channel — called from `markRead` and on
   *  explicit "I've read this" actions. */
  clearMentions(channelId: string): void {
    if (!this.mentionCountByChannel[channelId]) return;
    const next = { ...this.mentionCountByChannel };
    delete next[channelId];
    this.mentionCountByChannel = next;
    this.persistMentions();
  }

  /** Synchronous lookup; 0 when no mentions are pending. */
  getMentionCount(channelId: string): number {
    return this.mentionCountByChannel[channelId] ?? 0;
  }

  /** Does any channel in this guild have a pending mention? Drives the
   *  guild-rail red dot — O(n) over the channel list per call, which is
   *  fine for typical guild sizes. */
  hasGuildMentions(channelIds: readonly string[]): boolean {
    for (const cid of channelIds) {
      if ((this.mentionCountByChannel[cid] ?? 0) > 0) return true;
    }
    return false;
  }

  private persist(): void {
    if (!this.storageKey || typeof window === 'undefined') return;
    // Debounce: cancel any pending timer and schedule a new flush.
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      try {
        window.localStorage.setItem(this.storageKey, JSON.stringify(this.lastReadByChannel));
      } catch {
        // Quota exceeded / disabled — silently drop; in-memory state remains correct.
      }
      this.persistTimer = null;
    }, 200);
  }

  private persistMentions(): void {
    if (!this.mentionsKey || typeof window === 'undefined') return;
    // Debounce: cancel any pending timer and schedule a new flush.
    if (this.persistMentionsTimer) clearTimeout(this.persistMentionsTimer);
    this.persistMentionsTimer = setTimeout(() => {
      try {
        window.localStorage.setItem(this.mentionsKey, JSON.stringify(this.mentionCountByChannel));
      } catch {
        // Same forgiveness as `persist` — counter survives in memory.
      }
      this.persistMentionsTimer = null;
    }, 200);
  }
}

export const readState = new ReadState();
