/**
 * Etappe-4 friend-system handlers: `friend_request_received/accepted/
 * declined/cancelled`, `friend_removed`, `user_blocked/unblocked`.
 *
 * The accept + block paths re-hydrate the DM list because either action
 * flips `can_send` on the matching DM channel server-side; a stale list
 * would keep the composer locked / unlocked until the next reconnect.
 */
import { friends } from '$lib/stores/friends.svelte';
import { friendRequests } from '$lib/stores/friendRequests.svelte';
import { blocks } from '$lib/stores/blocks.svelte';
import { directMessages } from '$lib/stores/directMessages.svelte';
import { userCache } from '$lib/stores/users.svelte';
import { registerWsHandler } from '../handler-registry';

export function register(): void {
  registerWsHandler('friend_request_received', (evt) => {
    friendRequests.addIncoming(evt.data);
    userCache.queue(evt.data.sender_id);
  });

  registerWsHandler('friend_request_accepted', (evt) => {
    // Sent to BOTH sides. The ``friendship.user_id`` is the *other*
    // party (server flips it per receiver). Drop the request from
    // either pending bucket, add to friends, refresh the DM list so
    // ``can_send`` flips (friendship just opened the gate).
    friendRequests.removeById(evt.data.request_id);
    friends.add(evt.data.friendship.user_id, evt.data.friendship.since);
    userCache.queue(evt.data.friendship.user_id);
    void directMessages.hydrate().catch(() => undefined);
  });

  registerWsHandler('friend_request_declined', (evt) => {
    // Sender-only fan-out → the row sits in our outgoing bucket.
    friendRequests.removeOutgoing(evt.data.request_id);
  });

  registerWsHandler('friend_request_cancelled', (evt) => {
    // Receiver-only fan-out → row sits in our incoming bucket.
    friendRequests.removeIncoming(evt.data.request_id);
  });

  registerWsHandler('friend_removed', (evt) => {
    friends.remove(evt.data.user_id);
    void directMessages.hydrate().catch(() => undefined);
  });

  registerWsHandler('user_blocked', (evt) => {
    blocks.add(evt.data.user_id);
    // Block tears down friendship server-side; the matching
    // friend_removed is fanned out only to the other party. Mirror
    // the local drop here so our friend list stays consistent
    // without waiting for the next reconnect.
    friends.remove(evt.data.user_id);
    void directMessages.hydrate().catch(() => undefined);
  });

  registerWsHandler('user_unblocked', (evt) => {
    blocks.remove(evt.data.user_id);
  });
}
