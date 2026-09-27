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
import { recordNotice } from '$lib/stream/recordNotice.svelte';
import { streamRecordOsMeldung } from '$lib/stream/recordOs';

export function register(): void {
  registerWsHandler('stream_state', (evt) => {
    const oldIds = streamPresence.streamersIn(evt.channel_id);
    const userIds = evt.user_ids ?? [];
    // user_ids drive the per-user concerns (sound diff, chat prune); the
    // additive `streams` carry the per-slot tiles.
    streamPresence.apply(evt.channel_id, userIds, evt.streams);
    streamChat.pruneAbsent(evt.channel_id, userIds);
    fireStreamDiff(evt.channel_id, oldIds, userIds);
    // Endet der Stream, endet auch jeder gemeldete Aufnahme-Chip — der
    // Zustand gehoert zum laufenden Stream, nicht zum Kanal-Leben.
    if (userIds.length === 0) recordNotice.clear(evt.channel_id);
  });

  // „Ein Zuschauer nimmt deinen Stream auf" — Zustand fuer den Chip in der
  // StreamStatusBar; die OS-Benachrichtigung nur fuer Start und Clip (Stopp
  // soll kein Geroeusch machen, der Chip verschwindet ja sichtbar).
  registerWsHandler('stream_record', (evt) => {
    recordNotice.apply(evt.channel_id, evt.from_user_id, evt.recording, evt.clip);
    if (evt.recording || evt.clip) streamRecordOsMeldung(evt.from_user_id, evt.clip, evt.channel_id);
  });
}
