/**
 * Watch-Party presence store — mirrors `streamPresence.svelte.ts`.
 *
 * One active watch party per voice channel, max. State is owned end-to-end by
 * chat-gateway (`watchkeys.py`), fed into the store from three sources:
 *  - the `ready` payload's `watch_states: [{channel_id, state}, ...]` →
 *    {@link seed} (replaces the map; runs on every (re)connect so it doubles
 *    as the reconnect re-sync);
 *  - the `{op:"watch_state", channel_id, state}` WS push → {@link apply}
 *    (full state snapshot, or `state: null` when the party ended);
 *  - the `GET /api/chat/guilds/{guildId}/watch-state` REST endpoint (same
 *    shape) for explicit re-sync after a guild switch.
 */

export type WatchSourceYouTube = {
  type: 'youtube';
  embed_id: string;
  start_seconds?: number;
};
export type WatchSourceTwitch = { type: 'twitch'; embed_id: string };
/** Twitch live channel embed. No seek/position — the watch-party tile
 * treats this as a passive shared embed (no heartbeat, no drift sync). */
export type WatchSourceTwitchLive = { type: 'twitch_live'; channel: string };
export type WatchSourceNative = { type: 'native'; url: string };
export type WatchSource =
  | WatchSourceYouTube
  | WatchSourceTwitch
  | WatchSourceTwitchLive
  | WatchSourceNative;

/** True for sources whose state can't be drift-corrected (live streams).
 * The tile uses this to gate heartbeat + applySoft/applyHard. */
export function isPassiveSource(s: WatchSource): boolean {
  return s.type === 'twitch_live';
}

export type WatchPartyState = {
  source: WatchSource;
  /** Snowflake of the user controlling playback. */
  host_user_id: string;
  /** Last reported position in seconds. */
  position: number;
  is_playing: boolean;
  /** Unix epoch ms — viewers extrapolate `position + (now - updated_at)/1000` while playing. */
  updated_at: number;
  started_at: number;
};

/** Wire shape for the `ready.watch_states` / REST list. `state: null` is only
 * used in WS pushes to signal "party ended" — it never appears in `byChannel`. */
export type WatchChannelEntry = {
  channel_id: string;
  state: WatchPartyState | null;
};

class WatchPartyPresenceStore {
  /** Maps channel_id → current watch-party state. Channels without a party are absent. */
  byChannel = $state<Record<string, WatchPartyState>>({});

  /** Seed from `ready` payload or a REST re-sync. Replaces all state. */
  seed(entries: WatchChannelEntry[]): void {
    const next: Record<string, WatchPartyState> = {};
    for (const e of entries) {
      if (e.state) next[e.channel_id] = e.state;
    }
    this.byChannel = next;
  }

  /** Apply a single `watch_state` push. `state === null` ends the party. */
  apply(channelId: string, state: WatchPartyState | null): void {
    if (state === null) {
      if (this.byChannel[channelId] === undefined) return;
      const { [channelId]: _drop, ...rest } = this.byChannel;
      this.byChannel = rest;
      return;
    }
    this.byChannel = { ...this.byChannel, [channelId]: state };
  }

  /** The active watch-party state for a channel, or `undefined`. */
  partyIn(channelId: string): WatchPartyState | undefined {
    return this.byChannel[channelId];
  }

  /** Whether the given user controls the party in this channel. */
  isHost(channelId: string, userId: string | undefined): boolean {
    const p = this.byChannel[channelId];
    return !!p && !!userId && p.host_user_id === userId;
  }

  clear(): void {
    this.byChannel = {};
  }
}

export const watchPartyPresence = new WatchPartyPresenceStore();
