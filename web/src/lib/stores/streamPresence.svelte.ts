/**
 * HQ-stream presence store — mirrors `voicePresence.svelte.ts`.
 *
 * Tracks, per channel, *which users* currently have an HQ stream (GSR → MediaMTX)
 * running into it — several people can stream into the same voice channel at
 * once (each gets their own MediaMTX path / WHEP URL). Fed from two sources,
 * exactly like voice presence is fed from `voice:room:*`:
 *  - the `ready` payload's `stream_states: [{channel_id, user_ids}, ...]` →
 *    {@link seed} (replaces the whole map; happens on every (re)connect, so it
 *    doubles as the reconnect re-sync);
 *  - the `{op:"stream_state", channel_id, user_ids}` WS push → {@link apply}
 *    (the *full* current set after the change).
 *
 * Distinct from `voicePresence.streamingByChannel`, which tracks LiveKit
 * *screen-share* tracks (the in-call browser screen share), not the per-channel
 * HQ GSR/WHEP stream this store is about.
 */

/** One live HQ stream: a `(user_id, slot)` pair. `slot` (0, 1, …) is the stable
 *  per-user stream index, so one user can run several streams at once (e.g. two
 *  monitors as separate tiles). */
export type StreamDescriptor = {
  user_id: string;
  slot: number;
};

export type StreamChannelState = {
  channel_id: string;
  /** Snowflakes of everyone currently HQ-streaming into the channel. */
  user_ids: string[];
  /** Per-slot descriptors — only present when a user runs slot ≥ 1; otherwise
   *  the channel is one-stream-per-user and `streamsIn()` derives slot-0
   *  descriptors from `user_ids`. */
  streams?: StreamDescriptor[];
};

/** Normalise a wire `streams` array to `{user_id: string, slot: number}[]`,
 *  dropping malformed entries. */
function normalizeStreams(streams: StreamDescriptor[] | undefined): StreamDescriptor[] {
  if (!Array.isArray(streams)) return [];
  const out: StreamDescriptor[] = [];
  for (const s of streams) {
    if (!s?.user_id) continue;
    out.push({ user_id: String(s.user_id), slot: Number(s.slot ?? 0) || 0 });
  }
  return out;
}

/** A copy of `record` without `key`. Returns the same reference when the key is
 *  absent, so assigning it back to a `$state` field is a no-op (no spurious
 *  reactivity). */
function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (record[key] === undefined) return record;
  const { [key]: _drop, ...rest } = record;
  return rest;
}

class StreamPresenceStore {
  /** Maps channel_id → list of streamer user-ids. Channels with no streamer are absent. */
  byChannel = $state<Record<string, string[]>>({});
  /** Maps channel_id → per-slot descriptors. Only set when a channel has a
   *  multi-slot streamer; single-stream channels are absent here (the tile
   *  layer falls back to slot-0 descriptors derived from `byChannel`). */
  streamsByChannel = $state<Record<string, StreamDescriptor[]>>({});

  /** Seed from the `ready` payload or a REST re-sync. Replaces all state. */
  seed(states: StreamChannelState[]): void {
    const next: Record<string, string[]> = {};
    const nextStreams: Record<string, StreamDescriptor[]> = {};
    for (const s of states) {
      const ids = (s.user_ids ?? []).filter(Boolean);
      if (ids.length) next[s.channel_id] = ids;
      const streams = normalizeStreams(s.streams);
      if (streams.length) nextStreams[s.channel_id] = streams;
    }
    this.byChannel = next;
    this.streamsByChannel = nextStreams;
  }

  /** Apply a single `stream_state` push — the new full set for that channel. */
  apply(channelId: string, userIds: string[], streams?: StreamDescriptor[]): void {
    const ids = (userIds ?? []).filter(Boolean);
    if (ids.length === 0) {
      this.#dropChannel(channelId);
      return;
    }
    this.byChannel = { ...this.byChannel, [channelId]: ids };
    const descs = normalizeStreams(streams);
    if (descs.length) {
      this.streamsByChannel = { ...this.streamsByChannel, [channelId]: descs };
    } else {
      // Back to one-stream-per-user → drop any stale multi-slot entry.
      this.streamsByChannel = without(this.streamsByChannel, channelId);
    }
  }

  #dropChannel(channelId: string): void {
    this.byChannel = without(this.byChannel, channelId);
    this.streamsByChannel = without(this.streamsByChannel, channelId);
  }

  /** Everyone HQ-streaming into a channel (empty array if none). One entry per
   *  user regardless of how many streams they run. */
  streamersIn(channelId: string): string[] {
    return this.byChannel[channelId] ?? [];
  }

  /** Every live stream in a channel as `(user_id, slot)` descriptors — one per
   *  tile. Falls back to slot-0-per-user when no multi-slot info is present. */
  streamsIn(channelId: string): StreamDescriptor[] {
    const explicit = this.streamsByChannel[channelId];
    if (explicit) return explicit;
    return (this.byChannel[channelId] ?? []).map((u) => ({ user_id: u, slot: 0 }));
  }

  /** Whether a channel currently has at least one HQ stream. */
  isStreaming(channelId: string): boolean {
    return (this.byChannel[channelId]?.length ?? 0) > 0;
  }

  clear(): void {
    this.byChannel = {};
    this.streamsByChannel = {};
  }
}

export const streamPresence = new StreamPresenceStore();
