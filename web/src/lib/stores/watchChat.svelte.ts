/**
 * Ephemeral watch-party chat store — one message list per channel.
 * Mirrors streamChat.svelte.ts but keyed only by channelId (one party per channel).
 *
 * Fed from:
 *  - REST backfill on WatchChatPanel mount → {@link seed}
 *  - WS push `{op:"watch_chat_message", channel_id, message}` → {@link apply}
 *  - WatchPartyPresence clearing when party ends → {@link clear}
 */

export type WatchChatMessage = {
  id: string;
  author_id: string;
  content: string;
  created_at: string;
};

const MAX_CLIENT_HISTORY = 200;

class WatchChatStore {
  byChannel = $state<Record<string, WatchChatMessage[]>>({});

  seed(channelId: string, messages: WatchChatMessage[]): void {
    this.byChannel = { ...this.byChannel, [channelId]: messages.slice(-MAX_CLIENT_HISTORY) };
  }

  apply(channelId: string, message: WatchChatMessage): void {
    const existing = this.byChannel[channelId] ?? [];
    if (existing.some((m) => m.id === message.id)) return;
    const next =
      existing.length >= MAX_CLIENT_HISTORY
        ? [...existing.slice(-(MAX_CLIENT_HISTORY - 1)), message]
        : [...existing, message];
    this.byChannel = { ...this.byChannel, [channelId]: next };
  }

  clear(channelId: string): void {
    if (this.byChannel[channelId] === undefined) return;
    const { [channelId]: _drop, ...rest } = this.byChannel;
    this.byChannel = rest;
  }

  for(channelId: string): WatchChatMessage[] {
    return this.byChannel[channelId] ?? [];
  }
}

export const watchChat = new WatchChatStore();
