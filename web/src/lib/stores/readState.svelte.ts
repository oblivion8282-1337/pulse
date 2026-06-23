/**
 * Per-channel unread tracking.
 *
 * Two pieces of state:
 *  - `lastReadByChannel` — the latest message id the user has acknowledged
 *    for each channel. Persisted to localStorage per-user (`pulse.readState.<uid>`).
 *  - `latestByChannel` — the latest message id we've observed for each channel
 *    in this session, in memory only.
 *
 * A channel is unread when `latest > lastRead`. Snowflake-IDs werden über
 * `compareSnowflakeId` verglichen (längen- dann lexikografisch) — ein reiner
 * String-Vergleich bricht an der Stellen-Grenze (17→18 Ziffern, ~Okt 2026).
 *
 * Limitation (v1): unread state seeds from activity DURING the session. If a
 * message was posted while the client was offline and never sync-loaded, the
 * channel will not show as unread on next launch. Proper offline catch-up
 * would need a server-side read-state sync — out of scope for now.
 */

import { compareSnowflakeId } from '$lib/utils/snowflake';

const STORAGE_PREFIX = 'pulse.readState.';
const MENTIONS_PREFIX = 'pulse.mentions.';
const UNREAD_PREFIX = 'pulse.unread.';

class ReadState {
  lastReadByChannel = $state<Record<string, string>>({});
  latestByChannel = $state<Record<string, string>>({});
  /** Per-channel unread @-mention counter — bumped by the WS handler
   *  when a `mention_added` event (or an inline `message` whose mentions
   *  include the current user) lands for a channel the user isn't
   *  actively viewing. Cleared by `markRead` and `clearMentions`. */
  mentionCountByChannel = $state<Record<string, number>>({});
  /** Per-channel unread MESSAGE counter — bumped by the WS handler for every
   *  message (channel_bump / dm_bump) that lands for a channel the user isn't
   *  actively viewing. Superset of `mentionCountByChannel` (a mention also
   *  bumps this). Drives the red count pill everywhere. Cleared by `markRead`. */
  unreadCountByChannel = $state<Record<string, number>>({});

  private storageKey = '';
  private mentionsKey = '';
  private unreadKey = '';
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistMentionsTimer: ReturnType<typeof setTimeout> | null = null;
  private persistUnreadTimer: ReturnType<typeof setTimeout> | null = null;

  hydrateForUser(userId: string): void {
    this.storageKey = `${STORAGE_PREFIX}${userId}`;
    this.mentionsKey = `${MENTIONS_PREFIX}${userId}`;
    this.unreadKey = `${UNREAD_PREFIX}${userId}`;
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
    try {
      const raw = window.localStorage.getItem(this.unreadKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          this.unreadCountByChannel = parsed as Record<string, number>;
        }
      }
    } catch {
      // Corrupt → fresh counters; non-fatal.
    }
  }

  clear(): void {
    this.storageKey = '';
    this.mentionsKey = '';
    this.unreadKey = '';
    this.lastReadByChannel = {};
    this.latestByChannel = {};
    this.mentionCountByChannel = {};
    this.unreadCountByChannel = {};
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
    this.unreadCountByChannel = {};
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
    this.clearUnread(channelId);
  }

  /** Record that we've observed a message in this channel (from any source —
   *  WS message frame, channel_bump envelope, or an initial-load fetch). */
  recordSeen(channelId: string, messageId: string): void {
    const prev = this.latestByChannel[channelId];
    if (!prev || compareSnowflakeId(messageId, prev) > 0) {
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
      // No new message id but we still want the badges to clear on focus
      // (e.g. when the user clicks an empty channel).
      this.clearMentions(channelId);
      this.clearUnread(channelId);
      return;
    }
    const prev = this.lastReadByChannel[channelId];
    if (!prev || compareSnowflakeId(target, prev) > 0) {
      this.lastReadByChannel = { ...this.lastReadByChannel, [channelId]: target };
      this.persist();
    }
    this.clearMentions(channelId);
    this.clearUnread(channelId);
  }

  isUnread(channelId: string): boolean {
    const latest = this.latestByChannel[channelId];
    if (!latest) return false;
    const lastRead = this.lastReadByChannel[channelId];
    return !lastRead || compareSnowflakeId(latest, lastRead) > 0;
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

  /** Bump the per-channel unread-message counter by one. */
  incUnread(channelId: string): void {
    const prev = this.unreadCountByChannel[channelId] ?? 0;
    this.unreadCountByChannel = {
      ...this.unreadCountByChannel,
      [channelId]: prev + 1
    };
    this.persistUnread();
  }

  /** Zero the unread-message counter for a channel — called from `markRead`. */
  clearUnread(channelId: string): void {
    if (!this.unreadCountByChannel[channelId]) return;
    const next = { ...this.unreadCountByChannel };
    delete next[channelId];
    this.unreadCountByChannel = next;
    this.persistUnread();
  }

  /** Synchronous lookup; 0 when nothing unread. */
  getUnreadCount(channelId: string): number {
    return this.unreadCountByChannel[channelId] ?? 0;
  }

  /** Sum of unread-message counts across the given channels. Drives the
   *  guild-rail / home count pills. O(n) per call — fine for these sizes. */
  sumUnread(channelIds: readonly string[]): number {
    let total = 0;
    for (const cid of channelIds) total += this.unreadCountByChannel[cid] ?? 0;
    return total;
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

  private persistUnread(): void {
    if (!this.unreadKey || typeof window === 'undefined') return;
    if (this.persistUnreadTimer) clearTimeout(this.persistUnreadTimer);
    this.persistUnreadTimer = setTimeout(() => {
      try {
        window.localStorage.setItem(this.unreadKey, JSON.stringify(this.unreadCountByChannel));
      } catch {
        // Same forgiveness as the others — counter survives in memory.
      }
      this.persistUnreadTimer = null;
    }, 200);
  }
}

export const readState = new ReadState();
