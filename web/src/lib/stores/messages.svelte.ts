import type { Message } from '$lib/api/types';

class MessageStore {
  // Newest at the end. We dedupe on `id` and merge `nonce` echoes.
  byChannel = $state<Record<string, Message[]>>({});
  loadedChannels = $state<Record<string, boolean>>({});

  for(channelId: string): Message[] {
    return this.byChannel[channelId] ?? [];
  }

  setInitial(channelId: string, msgs: Message[]): void {
    // Backend returns descending; flip for chat-bottom display.
    const sorted = [...msgs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.byChannel = { ...this.byChannel, [channelId]: sorted };
    this.loadedChannels = { ...this.loadedChannels, [channelId]: true };
  }

  upsert(msg: Message): void {
    const list = this.byChannel[msg.channel_id] ?? [];
    // If the message has a nonce, try to replace a pending optimistic copy.
    let next = list;
    if (msg.nonce) {
      const idxNonce = list.findIndex((m) => m.nonce === msg.nonce && m.id !== msg.id);
      if (idxNonce >= 0) {
        next = list.slice();
        next[idxNonce] = msg;
        this.byChannel = { ...this.byChannel, [msg.channel_id]: next };
        return;
      }
    }
    // Dedupe by id.
    if (list.some((m) => m.id === msg.id)) return;
    // Append in id-order to keep the list monotonic.
    if (list.length === 0 || list[list.length - 1].id < msg.id) {
      next = [...list, msg];
    } else {
      next = [...list, msg].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }
    this.byChannel = { ...this.byChannel, [msg.channel_id]: next };
  }

  /** Add an optimistic outgoing message — replaced by upsert on echo. */
  addOptimistic(msg: Message): void {
    this.upsert(msg);
  }

  clearChannel(channelId: string): void {
    const { [channelId]: _, ...rest } = this.byChannel;
    this.byChannel = rest;
    const { [channelId]: __, ...restLoaded } = this.loadedChannels;
    this.loadedChannels = restLoaded;
  }

  clear(): void {
    this.byChannel = {};
    this.loadedChannels = {};
  }
}

export const messages = new MessageStore();
