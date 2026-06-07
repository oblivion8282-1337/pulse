import { auth } from './auth.svelte';
import { activeServer } from './active-server.svelte';
import { serverUser } from './serverUser.svelte';
import { dispatchingServerId } from '$lib/ws/gateway-connection';

/**
 * This account's user id ON THE ACTIVE SERVER.
 *
 * The Cloud and each self-host give you a *different* user id (cert-login /
 * pairwise). Every "is this mine?" check against a **server-local** id — a
 * message's ``author_id``, a guild's ``owner_id``, a WS event's ``user_id``, a
 * watch-party ``host_user_id`` — must compare against THIS, never
 * ``auth.user.id`` (which is always the Cloud id and so never matches on a
 * self-host: you couldn't edit/delete your own messages, owner-only options
 * vanished, "report" showed on your own message, etc.).
 *
 * Cloud: the ready frame's ``user_id`` == ``auth.user.id`` → unchanged.
 * Fallback to ``auth.user.id`` while the ready frame hasn't seeded ``serverUser``
 * yet (e.g. mocked E2E frames without ``user_id``).
 *
 * Safe inside WS handlers too: only the *active* connection dispatches events
 * (see ``gateway-connection._handle``), so the active server is always the
 * right context when a handler runs.
 *
 * Reads reactive store state — call it inside ``$derived`` / templates (or at
 * event time in a handler) and it stays correct across server switches.
 */
export function currentServerUserId(): string | null {
  return serverUser.idFor(activeServer.current?.id) ?? auth.user?.id ?? null;
}

/**
 * This account's user id ON THE *DISPATCHING* SERVER — use this inside WS
 * handlers that can now run for **either** the active connection (guild
 * events) **or** the Cloud-Background connection (global Friends/DMs/Presence,
 * Stufe 1). For active-only ops this equals ``currentServerUserId()`` (the
 * dispatching connection *is* the active one); for a Cloud-background DM-bump
 * while a self-host is active it resolves to the **Cloud** id, so the DM
 * member-check (``user_a_id === me``) matches instead of comparing against the
 * self-host's pairwise id and silently dropping the event.
 *
 * MUST be read synchronously at event time (before any ``await``): the gateway
 * sets the dispatching connection synchronously right before ``dispatch()``.
 * Falls back to the active-server id (then ``auth.user.id``) when no dispatch
 * is in flight (e.g. a direct/unit call outside the WS path).
 */
export function dispatchingUserId(): string | null {
  const sid = dispatchingServerId();
  if (sid) return serverUser.idFor(sid) ?? auth.user?.id ?? null;
  return currentServerUserId();
}
