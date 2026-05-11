import type { Message } from '$lib/api/types';

class MessageStore {
  // Newest at the end. We dedupe on `id` and merge `nonce` echoes.
  byChannel = $state<Record<string, Message[]>>({});
  loadedChannels = $state<Record<string, boolean>>({});

  for(channelId: string): Message[] {
    return this.byChannel[channelId] ?? [];
  }

  private static readonly CAP = 500;

  setInitial(channelId: string, msgs: Message[]): void {
    // Backend returns descending; flip for chat-bottom display.
    let sorted = [...msgs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (sorted.length > MessageStore.CAP) sorted = sorted.slice(-MessageStore.CAP);
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
    if (next.length > MessageStore.CAP) next = next.slice(-MessageStore.CAP);
    this.byChannel = { ...this.byChannel, [msg.channel_id]: next };
  }

  /** Add an optimistic outgoing message — replaced by upsert on echo. */
  addOptimistic(msg: Message): void {
    this.upsert(msg);
  }

  /** Remove an optimistic message by id (rollback on WS-disconnect). */
  removeOptimistic(channelId: string, tmpId: string): void {
    const list = this.byChannel[channelId];
    if (!list) return;
    const next = list.filter((m) => m.id !== tmpId);
    if (next.length !== list.length) {
      this.byChannel = { ...this.byChannel, [channelId]: next };
    }
  }

  /** Mark a channel as not loaded so the next visit re-fetches messages. */
  invalidateLoaded(channelId: string): void {
    delete this.loadedChannels[channelId];
  }

  /** Returns true if a message with the given nonce has been confirmed by the server (id not tmp-). */
  isConfirmed(nonce: string): boolean {
    for (const list of Object.values(this.byChannel)) {
      for (const m of list) {
        if (m.nonce === nonce && !m.id.startsWith('tmp-')) return true;
      }
    }
    return false;
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
