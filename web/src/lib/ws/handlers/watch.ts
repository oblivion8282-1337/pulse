/**
 * Watch-party state handler: `watch_state` + `watch_watchers`. The
 * corresponding `watch_chat_message` lives in `chat.ts` (chat-shaped fan-out,
 * so it sits with the other chat handlers).
 */
import { watchPartyPresence } from '$lib/stores/watchPartyPresence.svelte';
import { watchChat } from '$lib/stores/watchChat.svelte';
import { watchWatchers } from '$lib/stores/watchWatchers.svelte';
import { detachedWatchParties } from '$lib/stream/watchPartyDetach.svelte';
import { gateway } from '$lib/ws/connection';
import { registerWsHandler } from '../handler-registry';

export function register(): void {
  registerWsHandler('watch_state', (evt) => {
    watchPartyPresence.apply(evt.channel_id, evt.state);
    if (evt.state === null) {
      watchChat.clear(evt.channel_id);
      watchWatchers.clearChannel(evt.channel_id);
      // If this channel was detached into a popup, the main window held its
      // `watch_leave` back (see DetachedWatchParties.shouldSuppressLeave) and is
      // still registered as a watcher. The party just ended and the inline tile
      // won't remount to release that anchor — so release it here, else the main
      // socket lingers as a phantom watcher (would resurface in a later party's
      // handoff picker). `has` is only true in the window that detached.
      if (detachedWatchParties.has(evt.channel_id)) {
        // Clear the detached flag first so a duplicate null-state frame can't
        // re-send the leave (it's a server-side no-op anyway, but stay tidy).
        detachedWatchParties.markPartyEnded(evt.channel_id);
        gateway.sendWatchLeave(evt.channel_id);
      }
    }
  });
  registerWsHandler('watch_watchers', (evt) => {
    watchWatchers.apply(evt.channel_id, evt.user_ids);
  });
}
