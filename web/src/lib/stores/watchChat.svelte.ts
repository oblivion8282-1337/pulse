/**
 * Ephemeral watch-party chat store — one message list per party. Several
 * parties can run in one channel, so message lists are keyed by
 * `(channelId, partyId)`.
 *
 * Fed from:
 *  - REST backfill on WatchChatPanel mount → {@link seed}
 *  - WS push `{op:"watch_chat_message", channel_id, party_id, message}` → {@link apply}
 *  - WS push `{op:"watch_chat_reaction", data}` → {@link applyReaction}
 *  - WatchPartyPresence clearing when a party ends → {@link clear}
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

function key(channelId: string, partyId: string): string {
  return `${channelId} ${partyId}`;
}

class WatchChatStore {
  byParty = $state<Record<string, WatchChatMessage[]>>({});

  seed(channelId: string, partyId: string, messages: WatchChatMessage[]): void {
    this.byParty = {
      ...this.byParty,
      [key(channelId, partyId)]: messages.slice(-MAX_CLIENT_HISTORY)
    };
  }

  apply(channelId: string, partyId: string, message: WatchChatMessage): void {
    const k = key(channelId, partyId);
    const existing = this.byParty[k] ?? [];
    if (existing.some((m) => m.id === message.id)) return;
    const next =
      existing.length >= MAX_CLIENT_HISTORY
        ? [...existing.slice(-(MAX_CLIENT_HISTORY - 1)), message]
        : [...existing, message];
    this.byParty = { ...this.byParty, [k]: next };
  }

  /** Fold a per-user reaction delta into a message's aggregate. `me` is
   *  derived from our own server-local user id (mirrors messages store). */
  applyReaction(evt: {
    message_id: string;
    channel_id: string;
    party_id: string;
    user_id: string;
    emoji: string;
    added: boolean;
  }): void {
    const k = key(evt.channel_id, evt.party_id);
    const list = this.byParty[k];
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
    this.byParty = { ...this.byParty, [k]: next };
  }

  clear(channelId: string, partyId: string): void {
    const k = key(channelId, partyId);
    if (this.byParty[k] === undefined) return;
    const { [k]: _drop, ...rest } = this.byParty;
    this.byParty = rest;
  }

  /** Alles verwerfen (Server-Wechsel / Sign-Out). Pendant zu
   *  ``streamChat.clearAll()``: ohne das bliebe die Nachrichten-Historie einer
   *  Watch-Party im Speicher, wenn der User den Server wechselt, bevor das
   *  party-end-Event (auf der verlassenen Connection) den Eintrag räumt. */
  clearAll(): void {
    this.byParty = {};
  }

  for(channelId: string, partyId: string): WatchChatMessage[] {
    return this.byParty[key(channelId, partyId)] ?? [];
  }
}

export const watchChat = new WatchChatStore();
