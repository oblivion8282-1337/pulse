/**
 * Cross-handler sound-suppression for mention fan-out.
 *
 * When `mention_added` arrives, we record its message_id so the matching
 * `channel_bump` / `dm_bump` (which fan out separately) doesn't fire the
 * generic message/dm sound on top of the mention chime. The reverse order
 * (bump first) is best-effort — if it arrives first, both play. State is
 * module-scoped so `mention_added` (chat.ts) and the bump handlers
 * (channels.ts / chat.ts) can share it cleanly.
 *
 * The check is **consume-once**: each message gets exactly one matching bump,
 * so the first `isRecentMention(id)` that returns true clears the entry. This
 * is what makes the suppression survive a slow WS handshake: `channel_bump` is
 * buffered until the `ready` frame (`BUFFER_BEFORE_READY`) and replayed only
 * then — which can be >1500ms after the immediately-dispatched `mention_added`.
 * Tying suppression to consumption rather than a wall-clock window means the
 * replayed bump still finds it. The timeout is only a memory-leak safety net
 * for the rare case where no matching bump ever arrives.
 */

// Long enough to comfortably outlast the pre-ready buffer replay; the consume
// path normally clears entries well before this fires.
const SUPPRESSION_MS = 30_000;
const recent = new Set<string>();

export function markRecentMention(messageId: string): void {
  recent.add(messageId);
  setTimeout(() => recent.delete(messageId), SUPPRESSION_MS);
}

export function isRecentMention(messageId: string): boolean {
  return recent.delete(messageId);
}
