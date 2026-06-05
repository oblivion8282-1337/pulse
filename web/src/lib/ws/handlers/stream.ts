/**
 * Stream presence handler: `stream_state`.
 *
 * When a stream goes away the matching per-streamer chat slice is
 * purged locally (ephemeral by design — server retains the list 6h via
 * TTL self-heal, but the UX wants the chat to disappear with the
 * stream). The start/stop diff is forwarded to `fireStreamDiff` for
 * the user_start / user_stop / self_start sound effects.
 *
 * The ready-frame `seed()` path deliberately does NOT call the diff —
 * a fresh connect must not trigger a "all current streamers just
 * joined" orchestra.
 */
import { streamPresence } from '$lib/stores/streamPresence.svelte';
import { streamChat } from '$lib/stores/streamChat.svelte';
import { fireStreamDiff } from '../streamDiff';
import { registerWsHandler } from '../handler-registry';

export function register(): void {
  registerWsHandler('stream_state', (evt) => {
    const oldIds = streamPresence.streamersIn(evt.channel_id);
    streamPresence.apply(evt.channel_id, evt.user_ids ?? []);
    streamChat.pruneAbsent(evt.channel_id, evt.user_ids ?? []);
    fireStreamDiff(evt.channel_id, oldIds, evt.user_ids ?? []);
  });
}
