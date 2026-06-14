/**
 * Watch-party watcher lists, per party — who currently has a given party's tile
 * mounted. Several parties can run in one channel, so entries are keyed by
 * `(channelId, partyId)`. Fed by the `watch_watchers` WS push (view-channel-
 * filtered server side). Used by the host's "hand off control" picker and a
 * "X watching" count. Ephemeral: cleared when the party ends or on server switch.
 */
function key(channelId: string, partyId: string): string {
  return `${channelId} ${partyId}`;
}

class WatchWatchersStore {
  byParty = $state<Record<string, string[]>>({});

  apply(channelId: string, partyId: string, userIds: string[]): void {
    this.byParty = { ...this.byParty, [key(channelId, partyId)]: userIds };
  }

  watchersIn(channelId: string, partyId: string): string[] {
    return this.byParty[key(channelId, partyId)] ?? [];
  }

  clearParty(channelId: string, partyId: string): void {
    const k = key(channelId, partyId);
    if (this.byParty[k] === undefined) return;
    const { [k]: _drop, ...rest } = this.byParty;
    this.byParty = rest;
  }

  clear(): void {
    this.byParty = {};
  }
}

export const watchWatchers = new WatchWatchersStore();
