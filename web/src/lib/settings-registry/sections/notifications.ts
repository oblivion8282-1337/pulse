/**
 * `notifications` section — browser push intent + per-source toggles.
 *
 * `browserPushEnabled` is user-scoped: the underlying Push-Manager
 * subscription is bound to a specific user_id, so on sign-out the next user
 * shouldn't see "on" inherited from the previous account. Other toggles
 * (onMention, onDM) are device-defaults and stay.
 */
import type { SectionConfig } from '../types';

export type NotificationSettings = {
  browserPushEnabled: boolean;
  onMention: boolean;
  onDM: boolean;
};

export const DEFAULTS_NOTIFICATIONS: NotificationSettings = {
  // Explicit opt-in: requesting permission requires a user gesture and we
  // don't want to fire it ambiently. Sub-toggles default ON so once the
  // user opts in, mentions + DMs both alert by default.
  browserPushEnabled: false,
  onMention: true,
  onDM: true
};

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

export const NOTIFICATIONS_SECTION: SectionConfig<NotificationSettings> = {
  defaults: DEFAULTS_NOTIFICATIONS,
  // Only the push-permission flag is user-scoped — partial-merge on sign-out
  // so the per-source toggles persist.
  onSignOut: { browserPushEnabled: false },
  parse(raw) {
    const p = (raw && typeof raw === 'object' ? raw : {}) as Partial<NotificationSettings>;
    const d = DEFAULTS_NOTIFICATIONS;
    return {
      browserPushEnabled: bool(p.browserPushEnabled, d.browserPushEnabled),
      onMention: bool(p.onMention, d.onMention),
      onDM: bool(p.onDM, d.onDM)
    };
  }
};
