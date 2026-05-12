/**
 * HQ-stream presence store — mirrors `voicePresence.svelte.ts`.
 *
 * Tracks, per channel, *which users* currently have an HQ stream (GSR → MediaMTX)
 * running into it — several people can stream into the same voice channel at
 * once (each gets their own MediaMTX path / WHEP URL). Fed from three sources,
 * exactly like voice presence is fed from `voice:room:*`:
 *  - the `ready` payload's `stream_states: [{channel_id, user_ids}, ...]` →
 *    {@link seed} (replaces the whole map; happens on every (re)connect, so it
 *    doubles as the reconnect re-sync);
 *  - the `{op:"stream_state", channel_id, user_ids}` WS push → {@link apply}
 *    (the *full* current set after the change);
 *  - the `GET /api/chat/guilds/{guildId}/stream-state` REST endpoint (same
 *    `{stream_states}` shape) for an explicit re-sync after a guild switch.
 *
 * Distinct from `voicePresence.streamingByChannel`, which tracks LiveKit
 * *screen-share* tracks (the in-call browser screen share), not the per-channel
 * HQ GSR/WHEP stream this store is about.
 */

export type StreamChannelState = {
  channel_id: string;
  /** Snowflakes of everyone currently HQ-streaming into the channel. */
  user_ids: string[];
};

class StreamPresenceStore {
  /** Maps channel_id → list of streamer user-ids. Channels with no streamer are absent. */
  byChannel = $state<Record<string, string[]>>({});

  /** Seed from the `ready` payload or a REST re-sync. Replaces all state. */
  seed(states: StreamChannelState[]): void {
    const next: Record<string, string[]> = {};
    for (const s of states) {
      const ids = (s.user_ids ?? []).filter(Boolean);
      if (ids.length) next[s.channel_id] = ids;
    }
    this.byChannel = next;
  }

  /** Apply a single `stream_state` push — the new full set for that channel. */
  apply(channelId: string, userIds: string[]): void {
    const ids = (userIds ?? []).filter(Boolean);
    if (ids.length === 0) {
      if (this.byChannel[channelId] === undefined) return;
      const { [channelId]: _drop, ...rest } = this.byChannel;
      this.byChannel = rest;
      return;
    }
    this.byChannel = { ...this.byChannel, [channelId]: ids };
  }

  /** Everyone HQ-streaming into a channel (empty array if none). */
  streamersIn(channelId: string): string[] {
    return this.byChannel[channelId] ?? [];
  }

  /** Whether a channel currently has at least one HQ stream. */
  isStreaming(channelId: string): boolean {
    return (this.byChannel[channelId]?.length ?? 0) > 0;
  }

  clear(): void {
    this.byChannel = {};
  }
}

export const streamPresence = new StreamPresenceStore();
