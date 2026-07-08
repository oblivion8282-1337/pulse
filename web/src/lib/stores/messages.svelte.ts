import type { Message, ReactionAggregate } from '$lib/api/types';
import { dispatchingUserId } from './currentServerUser';
import { compareSnowflakeId } from '$lib/utils/snowflake';

class MessageStore {
  // Newest at the end. We dedupe on `id` and merge `nonce` echoes.
  byChannel = $state<Record<string, Message[]>>({});
  loadedChannels = $state<Record<string, boolean>>({});
  // Track confirmed (server-persisted, non-tmp) nonces for O(1) lookup.
  private confirmedNonces = new Set<string>();
  // Track message IDs in the current channel for O(1) dedup during upsert.
  private messageIds = $state<Record<string, Set<string>>>({});
  // LRU order of cached channels (least-recently-used first). Plain bookkeeping
  // — not rendered, so no $state. Keeps the in-memory cache from growing for
  // every channel ever visited in a session: beyond MAX_CACHED_CHANNELS the
  // least-recently-active channel is evicted (re-fetched cleanly on return via
  // the existing !loadedChannels path).
  private accessOrder: string[] = [];

  for(channelId: string): Message[] {
    return this.byChannel[channelId] ?? [];
  }

  // Mit VList-Virtualisierung ist die DOM-Größe vom Store entkoppelt — das CAP
  // schützt nur den Arbeitsspeicher. 5000 deckt selbst sehr tiefe Historie ab,
  // die via Infinite-Scroll-Up nachgeladen wird; älteste werden geprunt.
  private static readonly CAP = 5000;
  /** Max number of channels kept in the message cache at once. */
  private static readonly MAX_CACHED_CHANNELS = 15;

  /** Move a channel to the most-recently-used end of the LRU order. */
  private bumpAccess(channelId: string): void {
    const i = this.accessOrder.indexOf(channelId);
    if (i !== -1) this.accessOrder.splice(i, 1);
    this.accessOrder.push(channelId);
  }

  /** Evict least-recently-used channels until the cache is within the cap.
   *  The just-bumped (active) channel sits at the tail and is never reached. */
  private enforceChannelCap(): void {
    for (const cid of [...this.accessOrder]) {
      if (Object.keys(this.byChannel).length <= MessageStore.MAX_CACHED_CHANNELS) break;
      if (cid in this.byChannel) this.clearChannel(cid);
    }
  }

  /** Mark a channel as the most-recently-active (called when the user opens
   *  it, even if no new messages loaded) and enforce the cache cap. */
  touch(channelId: string): void {
    if (!channelId) return;
    this.bumpAccess(channelId);
    this.enforceChannelCap();
  }

  /** Trim a sorted channel list to the CAP (keeping the newest), dropping the
   *  pruned messages' confirmed nonces so the dedup set can't grow without
   *  bound over a long-lived session. Returns the (possibly unchanged) list. */
  private pruneToCap(list: Message[]): Message[] {
    if (list.length <= MessageStore.CAP) return list;
    for (const m of list.slice(0, list.length - MessageStore.CAP)) {
      if (m.nonce) this.confirmedNonces.delete(m.nonce);
    }
    return list.slice(-MessageStore.CAP);
  }

  setInitial(channelId: string, msgs: Message[]): void {
    // Backend returns descending; flip for chat-bottom display.
    let sorted = [...msgs].sort((a, b) => compareSnowflakeId(a.id, b.id));
    if (sorted.length > MessageStore.CAP) sorted = sorted.slice(-MessageStore.CAP);
    this.byChannel = { ...this.byChannel, [channelId]: sorted };
    this.loadedChannels = { ...this.loadedChannels, [channelId]: true };
    // Populate the ID set for O(1) dedup during upsert.
    this.messageIds = { ...this.messageIds, [channelId]: new Set(sorted.map((m) => m.id)) };
    this.touch(channelId);
  }

  /** Prepend older history (Infinite-Scroll-Up). `msgs` sind älter als der
   *  aktuelle älteste Eintrag. Dedupes by id, fügt id-sortiert vorne ein,
   *  prunt auf CAP. Gibt true zurück falls etwas dazukam (Aufrufer nutzt
   *  <limit um das Historie-Ende zu erkennen). */
  prepend(channelId: string, msgs: Message[]): boolean {
    if (!msgs.length) return false;
    const list = this.byChannel[channelId] ?? [];
    const ids = this.messageIds[channelId] ?? new Set(list.map((m) => m.id));
    // id-sortiert + deduped in einem Durchgang.
    const fresh = [...msgs]
      .sort((a, b) => compareSnowflakeId(a.id, b.id))
      .filter((m) => !ids.has(m.id));
    if (!fresh.length) return false;
    const trimmed = this.pruneToCap([...fresh, ...list]);
    this.byChannel = { ...this.byChannel, [channelId]: trimmed };
    for (const m of fresh) ids.add(m.id);
    if (ids.size > trimmed.length) {
      ids.clear();
      for (const m of trimmed) ids.add(m.id);
    }
    this.messageIds = { ...this.messageIds, [channelId]: ids };
    for (const m of fresh) {
      if (!m.id.startsWith('tmp-') && m.nonce) this.confirmedNonces.add(m.nonce);
    }
    return true;
  }

  upsert(msg: Message): void {
    const list = this.byChannel[msg.channel_id] ?? [];
    const ids = this.messageIds[msg.channel_id] ?? new Set();
    // If the message has a nonce, try to replace a pending optimistic copy.
    let next = list;
    if (msg.nonce) {
      const idxNonce = list.findIndex((m) => m.nonce === msg.nonce && m.id !== msg.id);
      if (idxNonce >= 0) {
        next = list.slice();
        next[idxNonce] = msg;
        this.byChannel = { ...this.byChannel, [msg.channel_id]: next };
        // Update the ID set.
        ids.delete(list[idxNonce].id);
        ids.add(msg.id);
        this.messageIds = { ...this.messageIds, [msg.channel_id]: ids };
        // Track this nonce as confirmed if not tmp.
        if (!msg.id.startsWith('tmp-') && msg.nonce) {
          this.confirmedNonces.add(msg.nonce);
        }
        return;
      }
    }
    // Dedupe by id using O(1) set lookup.
    if (ids.has(msg.id)) return;
    // Append in id-order to keep the list monotonic.
    if (list.length === 0 || compareSnowflakeId(list[list.length - 1].id, msg.id) < 0) {
      next = [...list, msg];
    } else {
      next = [...list, msg].sort((a, b) => compareSnowflakeId(a.id, b.id));
    }
    next = this.pruneToCap(next);
    this.byChannel = { ...this.byChannel, [msg.channel_id]: next };
    // Update the ID set with the new message and remove any pruned messages.
    ids.add(msg.id);
    if (ids.size > next.length) {
      // Messages were pruned (ids already has the new id, but next was sliced
      // back to CAP), rebuild the set to evict the stale ids.
      ids.clear();
      next.forEach((m) => ids.add(m.id));
    }
    this.messageIds = { ...this.messageIds, [msg.channel_id]: ids };
    // Track this nonce as confirmed if not tmp.
    if (!msg.id.startsWith('tmp-') && msg.nonce) {
      this.confirmedNonces.add(msg.nonce);
    }
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
      const ids = this.messageIds[channelId];
      if (ids) {
        ids.delete(tmpId);
        this.messageIds = { ...this.messageIds, [channelId]: ids };
      }
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
      const ids = this.messageIds[channelId];
      if (ids) {
        ids.delete(id);
        this.messageIds = { ...this.messageIds, [channelId]: ids };
      }
    }
  }

  /** Apply a delta to a message's reactions list. `delta` is +1 for add, -1
   *  for remove. `me` is set when this account is the reactor (see the
   *  ``dispatchingUserId`` note below). */
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
    // dispatchingUserId (not currentServerUserId): reaction_add/remove for a
    // DM arrive over the Cloud-background connection while a self-host may be
    // the active server — currentServerUserId() would return the self-host
    // pairwise id and never match the event's Cloud user_id, so the actor's
    // own reaction never flipped to "me". applyReaction runs synchronously in
    // the WS handler, so the dispatching connection is still in flight here.
    const isMe = evt.user_id === dispatchingUserId();
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
    const haveIds = this.messageIds[channelId] ?? new Set(list.map((m) => m.id));
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
        if (m.nonce && !m.id.startsWith('tmp-')) this.confirmedNonces.add(m.nonce);
      } else {
        append.push(m);
      }
    }
    if (!mutated && !append.length) return;
    next = [...next, ...append].sort((a, b) => compareSnowflakeId(a.id, b.id));
    next = this.pruneToCap(next);
    this.byChannel = { ...this.byChannel, [channelId]: next };
    // Rebuild the ID set after merge.
    this.messageIds = { ...this.messageIds, [channelId]: new Set(next.map((m) => m.id)) };
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
        this.reactionsEqual(merged.reactions ?? [], cur.reactions ?? [])
      ) {
        return cur;
      }
      changed = true;
      return merged;
    });
    if (changed) this.byChannel = { ...this.byChannel, [channelId]: next };
  }

  /** Compare two reaction arrays structurally without serialization. */
  private reactionsEqual(a: ReactionAggregate[], b: ReactionAggregate[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const ra = a[i];
      const rb = b[i];
      if (ra.emoji !== rb.emoji || ra.count !== rb.count || ra.me !== rb.me) return false;
    }
    return true;
  }

  /** Mark a channel as not loaded so the next visit re-fetches messages. */
  invalidateLoaded(channelId: string): void {
    delete this.loadedChannels[channelId];
  }

  /** Returns true if a message with the given nonce has been confirmed by the server (id not tmp-). */
  isConfirmed(nonce: string): boolean {
    return this.confirmedNonces.has(nonce);
  }

  clearChannel(channelId: string): void {
    const i = this.accessOrder.indexOf(channelId);
    if (i !== -1) this.accessOrder.splice(i, 1);
    const { [channelId]: list, ...rest } = this.byChannel;
    this.byChannel = rest;
    const { [channelId]: _loaded, ...restLoaded } = this.loadedChannels;
    this.loadedChannels = restLoaded;
    const { [channelId]: _ids, ...restIds } = this.messageIds;
    this.messageIds = restIds;
    // Clear stale nonces from this channel.
    if (list) {
      for (const m of list) {
        if (m.nonce) this.confirmedNonces.delete(m.nonce);
      }
    }
  }

  clear(): void {
    this.byChannel = {};
    this.loadedChannels = {};
    this.messageIds = {};
    this.confirmedNonces.clear();
    this.accessOrder = [];
  }
}

export const messages = new MessageStore();
