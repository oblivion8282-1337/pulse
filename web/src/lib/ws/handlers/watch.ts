/**
 * Watch-party state handler: `watch_state`. The corresponding
 * `watch_chat_message` lives in `chat.ts` (chat-shaped fan-out, so it
 * sits with the other chat handlers).
 */
import { watchPartyPresence } from '$lib/stores/watchPartyPresence.svelte';
import { watchChat } from '$lib/stores/watchChat.svelte';
import { registerWsHandler } from '../handler-registry';

export function register(): void {
  registerWsHandler('watch_state', (evt) => {
    watchPartyPresence.apply(evt.channel_id, evt.state);
    if (evt.state === null) watchChat.clear(evt.channel_id);
  });
}
