/**
 * WS-Handler für Community-Invite-Events (Stufe 3).
 *
 * `community_invite_received` → store.upsert
 * `community_invite_removed`  → store.remove
 *
 * Beide Ops sind PURE_SOCIAL (Cloud-Background-Connection erlaubt).
 */

import { communityInvites } from '$lib/stores/communityInvites.svelte';
import { registerWsHandler } from '../handler-registry';

export function register(): void {
  registerWsHandler('community_invite_received', (evt) => {
    communityInvites.upsert(evt.data);
  });

  registerWsHandler('community_invite_removed', (evt) => {
    communityInvites.remove(evt.data.id);
  });
}
