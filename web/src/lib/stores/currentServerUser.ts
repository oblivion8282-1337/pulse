import { auth } from './auth.svelte';
import { activeServer } from './active-server.svelte';
import { serverUser } from './serverUser.svelte';

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
