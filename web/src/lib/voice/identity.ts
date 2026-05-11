import type { Participant } from 'livekit-client';

/** Parse our app user id out of a LiveKit identity like `user-<snowflake>`. */
export function userIdFromIdentity(identity: string): string | null {
  const m = identity.match(/^user-(\d+)$/);
  return m ? m[1] : null;
}

/** Display name for a participant, falling back to the raw identity. */
export function nameFor(p: Participant): string {
  return p.name && p.name.trim() ? p.name : p.identity;
}
