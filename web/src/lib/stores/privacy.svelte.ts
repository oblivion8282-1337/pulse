/**
 * Per-user privacy preferences (DM-policy, friend-request policy,
 * discoverability).
 *
 * Backend values are integer enums (mirror ``friend_privacy.py``):
 *   DM:               0 EVERYONE · 1 SERVER_MEMBERS · 2 FRIENDS_ONLY · 3 NOBODY
 *   Friend-requests:  0 EVERYONE · 1 SERVER_MEMBERS · 2 NOBODY
 *
 * Seeded from ``ready.privacy``; mutated locally by ``update()`` (the
 * REST call is the caller's responsibility — the store reflects intent).
 */

export const DM_POLICY = {
  EVERYONE: 0,
  SERVER_MEMBERS: 1,
  FRIENDS_ONLY: 2,
  NOBODY: 3
} as const;

export const FRIEND_REQ_POLICY = {
  EVERYONE: 0,
  SERVER_MEMBERS: 1,
  NOBODY: 2
} as const;

export type PrivacySettings = {
  dm_policy: number;
  friend_request_policy: number;
  show_in_search: boolean;
};

const DEFAULTS: PrivacySettings = {
  dm_policy: DM_POLICY.EVERYONE,
  friend_request_policy: FRIEND_REQ_POLICY.EVERYONE,
  show_in_search: true
};

class PrivacyStore {
  current = $state<PrivacySettings>({ ...DEFAULTS });
  loaded = $state(false);

  seed(initial: PrivacySettings): void {
    this.current = { ...initial };
    this.loaded = true;
  }

  /** Patch the local state — REST is the caller's job; keep the helper
   *  optimistic so settings UI doesn't flash. The server echo via the
   *  next reconnect will re-seed if anything diverges. */
  update(patch: Partial<PrivacySettings>): void {
    this.current = { ...this.current, ...patch };
  }

  clear(): void {
    this.current = { ...DEFAULTS };
    this.loaded = false;
  }
}

export const privacy = new PrivacyStore();
