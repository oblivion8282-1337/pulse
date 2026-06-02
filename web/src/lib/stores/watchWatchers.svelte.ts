/**
 * Watch-party watcher lists, per channel — who currently has the party tile
 * mounted. Fed by the `watch_watchers` WS push (view-channel-filtered server
 * side). Used by the host's "hand off control" picker and a "X watching"
 * count. Ephemeral: cleared when the party ends or on channel/server switch.
 */
class WatchWatchersStore {
  byChannel = $state<Record<string, string[]>>({});

  apply(channelId: string, userIds: string[]): void {
    this.byChannel = { ...this.byChannel, [channelId]: userIds };
  }

  watchersIn(channelId: string): string[] {
    return this.byChannel[channelId] ?? [];
  }

  clearChannel(channelId: string): void {
    if (this.byChannel[channelId] === undefined) return;
    const { [channelId]: _drop, ...rest } = this.byChannel;
    this.byChannel = rest;
  }

  clear(): void {
    this.byChannel = {};
  }
}

export const watchWatchers = new WatchWatchersStore();
