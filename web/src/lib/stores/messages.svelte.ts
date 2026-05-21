import type { Message, ReactionAggregate } from '$lib/api/types';
import { auth } from './auth.svelte';

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

  /** Replace an existing message in place (edit). The server's reactions
   *  list is authoritative once present; if missing on the update payload
   *  we preserve the cached one so the UI doesn't blink. */
  update(msg: Message): void {
    const list = this.byChannel[msg.channel_id];
    if (!list) return;
    const idx = list.findIndex((m) => m.id === msg.id);
    if (idx < 0) return;
    const merged: Message = { ...msg, reactions: msg.reactions ?? list[idx].reactions };
    const next = list.slice();
    next[idx] = merged;
    this.byChannel = { ...this.byChannel, [msg.channel_id]: next };
  }

  /** Hard-remove a deleted message from the local list. */
  remove(channelId: string, id: string): void {
    const list = this.byChannel[channelId];
    if (!list) return;
    const next = list.filter((m) => m.id !== id);
    if (next.length !== list.length) {
      this.byChannel = { ...this.byChannel, [channelId]: next };
    }
  }

  /** Apply a delta to a message's reactions list. `delta` is +1 for add, -1
   *  for remove. `me` is computed from auth.user.id so the optimistic and
   *  remote paths converge on the same shape. */
  applyReaction(
    evt: { message_id: string; channel_id: string; user_id: string; emoji: string },
    delta: 1 | -1
  ): void {
    const list = this.byChannel[evt.channel_id];
    if (!list) return;
    const idx = list.findIndex((m) => m.id === evt.message_id);
    if (idx < 0) return;
    const msg = list[idx];
    const reactions: ReactionAggregate[] = msg.reactions ? msg.reactions.map((r) => ({ ...r })) : [];
    const isMe = !!auth.user && evt.user_id === auth.user.id;
    const rIdx = reactions.findIndex((r) => r.emoji === evt.emoji);
    if (delta === 1) {
      if (rIdx < 0) reactions.push({ emoji: evt.emoji, count: 1, me: isMe });
      else {
        reactions[rIdx].count += 1;
        if (isMe) reactions[rIdx].me = true;
      }
    } else {
      if (rIdx < 0) return;
      reactions[rIdx].count -= 1;
      if (isMe) reactions[rIdx].me = false;
      if (reactions[rIdx].count <= 0) reactions.splice(rIdx, 1);
    }
    const next = list.slice();
    next[idx] = { ...msg, reactions };
    this.byChannel = { ...this.byChannel, [evt.channel_id]: next };
  }

  /** Newest persisted (non-optimistic) message id in the channel, or null
   *  if empty / only optimistic placeholders. Used by the WS-reconnect
   *  gap-fill to request `?after=<lastId>`. */
  lastPersistedId(channelId: string): string | null {
    const list = this.byChannel[channelId];
    if (!list) return null;
    for (let i = list.length - 1; i >= 0; i--) {
      if (!list[i].id.startsWith('tmp-')) return list[i].id;
    }
    return null;
  }

  /** Merge a gap-fill page (messages strictly newer than `lastPersistedId`)
   *  into the channel non-destructively. Dedupes by id. A message that the
   *  WS already pushed during the round-trip is skipped by id.
   *
   *  Nonce handling: if an incoming row carries the nonce of an optimistic
   *  `tmp-` copy we still hold, it IS that message's persisted version —
   *  the WS echo was lost (e.g. to a reconnect that happened in the send
   *  window). We replace the `tmp-` copy in place rather than dropping the
   *  real row, which would otherwise strand the message on a `tmp-` id
   *  forever (un-editable, un-reactable until a full channel reload). */
  mergeGap(channelId: string, msgs: Message[]): void {
    if (!msgs.length) return;
    const list = this.byChannel[channelId] ?? [];
    const haveIds = new Set(list.map((m) => m.id));
    // nonce → index of an optimistic copy still awaiting its echo.
    const tmpByNonce = new Map<string, number>();
    list.forEach((m, i) => {
      if (m.nonce && m.id.startsWith('tmp-')) tmpByNonce.set(m.nonce, i);
    });
    let next = list.slice();
    const append: Message[] = [];
    let mutated = false;
    for (const m of msgs) {
      if (haveIds.has(m.id)) continue;
      const tmpIdx = m.nonce ? tmpByNonce.get(m.nonce) : undefined;
      if (tmpIdx !== undefined) {
        next[tmpIdx] = m;
        mutated = true;
      } else {
        append.push(m);
      }
    }
    if (!mutated && !append.length) return;
    next = [...next, ...append].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    );
    if (next.length > MessageStore.CAP) next = next.slice(-MessageStore.CAP);
    this.byChannel = { ...this.byChannel, [channelId]: next };
  }

  /** Re-sync already-present messages from a freshly re-fetched page —
   *  `content`, `edited_at` and `reactions`. A `?after=<lastId>` gap-fill
   *  only ever sees brand-new messages, so reaction toggles and edits that
   *  landed on *existing* messages while the WS was disconnected would
   *  otherwise stay stale until a full channel reload. New messages in
   *  `msgs` are ignored here — `mergeGap` owns those. */
  reconcile(channelId: string, msgs: Message[]): void {
    const list = this.byChannel[channelId];
    if (!list) return;
    const byId = new Map(msgs.map((m) => [m.id, m]));
    let changed = false;
    const next = list.map((cur) => {
      const fresh = byId.get(cur.id);
      if (!fresh) return cur;
      const merged: Message = {
        ...cur,
        content: fresh.content,
        edited_at: fresh.edited_at,
        reactions: fresh.reactions ?? cur.reactions
      };
      if (
        merged.content === cur.content &&
        merged.edited_at === cur.edited_at &&
        JSON.stringify(merged.reactions ?? []) === JSON.stringify(cur.reactions ?? [])
      ) {
        return cur;
      }
      changed = true;
      return merged;
    });
    if (changed) this.byChannel = { ...this.byChannel, [channelId]: next };
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
