/**
 * Presence handlers: `presence_update` (online/offline) and
 * `presence_status_changed` (status incl. "invisible" for the own user).
 */
import { presence, type PresenceStatus, type OwnPresenceStatus } from '$lib/stores/presence.svelte';
import { currentServerUserId } from '$lib/stores/currentServerUser';
import { registerWsHandler } from '../handler-registry';

export function register(): void {
  registerWsHandler('presence_update', (evt) => {
    presence.apply(evt.user_id, evt.online);
  });

  registerWsHandler('presence_status_changed', (evt) => {
    const me = currentServerUserId();
    if (me && evt.data.user_id === me) {
      // Own envelope carries the REAL status (incl. "invisible").
      presence.setOwnStatus(evt.data.status as OwnPresenceStatus);
    } else {
      // Peer envelope is already masked server-side (invisible → offline).
      presence.applyStatusChange(evt.data.user_id, evt.data.status as PresenceStatus);
    }
  });
}
