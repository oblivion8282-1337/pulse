import type { Participant } from 'livekit-client';

/**
 * Parse our app user id out of a LiveKit identity like `user-<snowflake>`.
 *
 * Join-Identitäten tragen seit der Mehrgerät-Freischaltung einen Sitzungs-
 * Suffix (`user-<snowflake>~<zufall>`), damit derselbe Account an zweitem
 * Gerät nicht von LiveKit ersetzt wird — der Parser muss ihn wegnehmen.
 */
export function userIdFromIdentity(identity: string): string | null {
  const m = identity.match(/^user-(\d+)(?:~[0-9a-f]+)?$/);
  return m ? m[1] : null;
}

/** Display name for a participant, falling back to the raw identity. */
export function nameFor(p: Participant): string {
  return p.name && p.name.trim() ? p.name : p.identity;
}
