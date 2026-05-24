/**
 * Cross-handler sound-suppression for mention fan-out.
 *
 * When `mention_added` arrives, we record its message_id briefly so the
 * matching `channel_bump` / `dm_bump` (which fan out separately) doesn't
 * fire the generic message/dm sound on top of the mention chime. The
 * reverse order (bump first) is best-effort — if it arrives first, both
 * play. State is module-scoped so `mention_added` (chat.ts) and the bump
 * handlers (channels.ts / chat.ts) can share it cleanly.
 */

const SUPPRESSION_MS = 1500;
const recent = new Set<string>();

export function markRecentMention(messageId: string): void {
  recent.add(messageId);
  setTimeout(() => recent.delete(messageId), SUPPRESSION_MS);
}

export function isRecentMention(messageId: string): boolean {
  return recent.has(messageId);
}
