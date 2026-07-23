/**
 * Watch-Party presence store — mirrors `streamPresence.svelte.ts`, but several
 * parties can run in one voice channel at once (like multiple HQ streams). Each
 * party has its own `party_id`; the store is a two-level map
 * `channelId → partyId → state`. State is owned end-to-end by chat-gateway
 * (`watchkeys.py`), fed from two sources:
 *  - the `ready` payload's `watch_states: [{channel_id, party_id, state}, ...]`
 *    → {@link seed} (replaces the map; runs on every (re)connect so it doubles
 *    as the reconnect re-sync);
 *  - the `{op:"watch_state", channel_id, party_id, state}` WS push → {@link apply}
 *    (full state snapshot, or `state: null` when that party ended).
 *
 * Per-user UI surfaces (badges on a participant/member) ask "does this user
 * host a party here?" via {@link hostIdsIn} / {@link partiesHostedBy} rather
 * than threading a party_id, since a party always has exactly one host.
 */

export type WatchSourceYouTube = {
  type: 'youtube';
  embed_id: string;
  start_seconds?: number;
};
export type WatchSourceTwitch = { type: 'twitch'; embed_id: string; start_seconds?: number };
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

/** One video lined up in the party's queue. Anyone in the channel may enqueue;
 *  the host moderates order + removal (backend: watchkeys.queue_*). */
export type WatchQueueItem = {
  id: string;
  source: WatchSource;
  submitted_by: string;
  submitted_at: number;
};

export type WatchPartyState = {
  /** Snowflake identifying this party within its channel. */
  party_id: string;
  source: WatchSource;
  /** Snowflake of the user controlling playback. */
  host_user_id: string;
  /** Last reported position in seconds. */
  position: number;
  is_playing: boolean;
  /** Unix epoch ms — viewers extrapolate `position + (now - updated_at)/1000` while playing. */
  updated_at: number;
  started_at: number;
  /** Videos lined up next. Absent on states that predate the queue feature —
   *  treat as empty. When the current video ends the host promotes queue[0]. */
  queue?: WatchQueueItem[];
};

/** Wire shape for the `ready.watch_states` / REST list. `state: null` is only
 * used in WS pushes to signal "party ended" — it never appears in `byChannel`. */
export type WatchChannelEntry = {
  channel_id: string;
  party_id: string;
  state: WatchPartyState | null;
};

class WatchPartyPresenceStore {
  /** Maps channel_id → party_id → state. Channels/parties without state absent. */
  byChannel = $state<Record<string, Record<string, WatchPartyState>>>({});

  /** Seed from `ready` payload or a REST re-sync. Replaces all state. */
  seed(entries: WatchChannelEntry[]): void {
    const next: Record<string, Record<string, WatchPartyState>> = {};
    for (const e of entries) {
      if (!e.state) continue;
      (next[e.channel_id] ??= {})[e.party_id] = e.state;
    }
    this.byChannel = next;
  }

  /** Apply a single `watch_state` push. `state === null` ends that party. */
  apply(channelId: string, partyId: string, state: WatchPartyState | null): void {
    const parties = this.byChannel[channelId];
    if (state === null) {
      if (parties?.[partyId] === undefined) return;
      const { [partyId]: _drop, ...restParties } = parties;
      if (Object.keys(restParties).length === 0) {
        const { [channelId]: _dropChan, ...restChans } = this.byChannel;
        this.byChannel = restChans;
      } else {
        this.byChannel = { ...this.byChannel, [channelId]: restParties };
      }
      return;
    }
    this.byChannel = {
      ...this.byChannel,
      [channelId]: { ...(parties ?? {}), [partyId]: state }
    };
  }

  /** All active parties in a channel (each carries its own `party_id`). */
  partiesIn(channelId: string): WatchPartyState[] {
    const parties = this.byChannel[channelId];
    return parties ? Object.values(parties) : [];
  }

  /** A specific party's state, or `undefined`. */
  partyIn(channelId: string, partyId: string): WatchPartyState | undefined {
    return this.byChannel[channelId]?.[partyId];
  }

  /** Whether the channel has at least one active party. */
  hasAnyParty(channelId: string): boolean {
    const parties = this.byChannel[channelId];
    return !!parties && Object.keys(parties).length > 0;
  }

  /** Host user-ids of all active parties in the channel — drives the per-user
   * PARTY badges (a user is "hosting" if they host any party here). */
  hostIdsIn(channelId: string): string[] {
    return this.partiesIn(channelId).map((p) => p.host_user_id);
  }

  /** Parties in the channel hosted by `userId` (usually one). Used by the
   * per-user open handlers to map a clicked participant to their party tile(s). */
  partiesHostedBy(channelId: string, userId: string): WatchPartyState[] {
    return this.partiesIn(channelId).filter((p) => p.host_user_id === userId);
  }

  /** Whether the given user controls the given party in this channel. */
  isHost(channelId: string, partyId: string, userId: string | undefined): boolean {
    const p = this.partyIn(channelId, partyId);
    return !!p && !!userId && p.host_user_id === userId;
  }

  clear(): void {
    this.byChannel = {};
  }
}

export const watchPartyPresence = new WatchPartyPresenceStore();
