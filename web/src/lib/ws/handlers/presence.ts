/**
 * Presence handlers: `presence_update` (online/offline) and
 * `presence_status_changed` (status incl. "invisible" for the own user).
 */
import { presence, type PresenceStatus, type OwnPresenceStatus } from '$lib/stores/presence.svelte';
import { dispatchingUserId } from '$lib/stores/currentServerUser';
import { dispatchingIsCloud } from '$lib/ws/gateway-connection';
import { registerWsHandler } from '../handler-registry';

export function register(): void {
  registerWsHandler('presence_update', (evt) => {
    presence.apply(evt.user_id, evt.online);
    // Kommt das Update von der Cloud, ist es ein FREUND → auch den
    // Cloud-Freundes-Topf pflegen (der einen Self-Host-Wechsel überlebt).
    if (dispatchingIsCloud()) presence.applyFriend(evt.user_id, evt.online);
  });

  registerWsHandler('presence_status_changed', (evt) => {
    // Own envelope: "me" must be resolved against the DISPATCHING connection.
    // A Cloud-background presence_status_changed (self-host active) carries the
    // Cloud id; comparing against the active self-host id would mis-route the
    // own/peer split.
    const me = dispatchingUserId();
    if (me && evt.data.user_id === me) {
      // Own envelope carries the REAL status (incl. "invisible").
      presence.setOwnStatus(evt.data.status as OwnPresenceStatus);
    } else {
      // Peer envelope is already masked server-side (invisible → offline).
      presence.applyStatusChange(evt.data.user_id, evt.data.status as PresenceStatus);
      // Von der Cloud = ein Freund → Freundes-Topf mitpflegen.
      if (dispatchingIsCloud()) {
        presence.applyFriendStatusChange(evt.data.user_id, evt.data.status as PresenceStatus);
      }
    }
  });
}
