/**
 * Stream presence handler: `stream_state`.
 *
 * When a stream goes away the matching per-streamer chat slice is
 * purged locally (ephemeral by design — server retains the list 6h via
 * TTL self-heal, but the UX wants the chat to disappear with the
 * stream).
 */
import { streamPresence } from '$lib/stores/streamPresence.svelte';
import { streamChat } from '$lib/stores/streamChat.svelte';
import { registerWsHandler } from '../handler-registry';

export function register(): void {
  registerWsHandler('stream_state', (evt) => {
    streamPresence.apply(evt.channel_id, evt.user_ids ?? []);
    streamChat.pruneAbsent(evt.channel_id, evt.user_ids ?? []);
  });
}
