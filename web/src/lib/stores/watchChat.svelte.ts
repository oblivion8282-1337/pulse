/**
 * Ephemeral watch-party chat store — one message list per channel.
 * Mirrors streamChat.svelte.ts but keyed only by channelId (one party per channel).
 *
 * Fed from:
 *  - REST backfill on WatchChatPanel mount → {@link seed}
 *  - WS push `{op:"watch_chat_message", channel_id, message}` → {@link apply}
 *  - WS push `{op:"watch_chat_reaction", data}` → {@link applyReaction}
 *  - WatchPartyPresence clearing when party ends → {@link clear}
 */

import { currentServerUserId } from '$lib/stores/currentServerUser';
import type { ReactionAggregate } from '$lib/api/types';

export type WatchChatMessage = {
  id: string;
  author_id: string;
  content: string;
  created_at: string;
  reactions?: ReactionAggregate[];
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

  /** Fold a per-user reaction delta into a message's aggregate. `me` is
   *  derived from our own server-local user id (mirrors messages store). */
  applyReaction(evt: {
    message_id: string;
    channel_id: string;
    user_id: string;
    emoji: string;
    added: boolean;
  }): void {
    const list = this.byChannel[evt.channel_id];
    if (!list) return;
    const idx = list.findIndex((m) => m.id === evt.message_id);
    if (idx < 0) return;
    const msg = list[idx];
    const reactions: ReactionAggregate[] = msg.reactions
      ? msg.reactions.map((r) => ({ ...r }))
      : [];
    const isMe = evt.user_id === currentServerUserId();
    const rIdx = reactions.findIndex((r) => r.emoji === evt.emoji);
    if (evt.added) {
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
