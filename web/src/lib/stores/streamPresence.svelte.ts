/**
 * HQ-stream presence store (T4) — mirrors `voicePresence.svelte.ts`.
 *
 * Tracks, per channel, whether an HQ stream (GSR → MediaMTX) is currently
 * active and who is publishing it. Fed from three sources, exactly like voice
 * presence is fed from `voice:room:*`:
 *  - the `ready` payload's `stream_states: [{channel_id, user_id}, ...]` →
 *    {@link seed} (replaces the whole map; happens on every (re)connect, so
 *    this doubles as the reconnect re-sync);
 *  - the `{op:"stream_state", channel_id, user_id, active}` WS push →
 *    {@link apply};
 *  - the `GET /api/chat/guilds/{guildId}/stream-state` REST endpoint (same
 *    `{stream_states}` shape) for an explicit re-sync after a guild switch —
 *    see {@link chatApi.getGuildStreamState}.
 *
 * Distinct from `voicePresence.streamingByChannel`, which tracks LiveKit
 * *screen-share* tracks (the in-call screen share), not the per-channel HQ
 * GSR/WHEP stream this store is about.
 */

export type StreamChannelState = {
  channel_id: string;
  /** Snowflake of the publisher, or null if MediaMTX hasn't matched it yet. */
  user_id: string | null;
};

class StreamPresenceStore {
  /** Maps channel_id → { active, userId }. Only active streams are present. */
  byChannel = $state<Record<string, { active: boolean; userId: string | null }>>({});

  /** Seed from the `ready` payload or a REST re-sync. Replaces all state. */
  seed(states: StreamChannelState[]): void {
    const next: Record<string, { active: boolean; userId: string | null }> = {};
    for (const s of states) {
      next[s.channel_id] = { active: true, userId: s.user_id ?? null };
    }
    this.byChannel = next;
  }

  /** Apply a single `stream_state` push. */
  apply(channelId: string, userId: string | null, active: boolean): void {
    if (!active) {
      if (this.byChannel[channelId] === undefined) return;
      const { [channelId]: _drop, ...rest } = this.byChannel;
      this.byChannel = rest;
      return;
    }
    this.byChannel = { ...this.byChannel, [channelId]: { active: true, userId: userId ?? null } };
  }

  /** The publisher's user id for a channel, or null (no active stream / unknown). */
  streamingUser(channelId: string): string | null {
    return this.byChannel[channelId]?.userId ?? null;
  }

  /** Whether a channel currently has an active HQ stream. */
  isStreaming(channelId: string): boolean {
    return this.byChannel[channelId]?.active === true;
  }

  clear(): void {
    this.byChannel = {};
  }
}

export const streamPresence = new StreamPresenceStore();
