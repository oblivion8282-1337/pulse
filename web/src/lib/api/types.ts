export type Tokens = {
  access_token: string;
  refresh_token: string;
  token_type: string;
};

export type User = {
  id: string;
  username: string;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  is_admin: boolean;
  /** Owner-Stufe (Betreiber): darf Self-Host-/App-Host-Anträge genehmigen und
   *  ist gegen Demote/Ban geschützt. Optional (Alt-Frames ohne das Feld). */
  is_owner?: boolean;
  disabled: boolean;
  created_at: string;
  /** ISO timestamp of email verification, or null if still unverified.
   *  Backwards-compatible: legacy users seeded before the field existed
   *  may have it absent — treat undefined identical to null. */
  email_verified_at?: string | null;
  /** Server-computed: true iff SMTP is configured AND this account is still
   *  unverified — i.e. the hard email-verification gate is blocking the user.
   *  Drives the `/verify-email-required` lock screen. */
  email_verification_pending?: boolean;
  /** True iff TOTP-based 2FA is set up + confirmed for this account. */
  totp_enabled?: boolean;
  /** Hash-Pointer auf das hochgeladene Profilbild (Avatar). null wenn der
   *  Default-Avatar zeigen soll. Update läuft über POST /me/profile. */
  avatar_hash?: string | null;
  /** Hex-Farbe (#rrggbb) für die Member-Liste. null wenn kein expliziter
   *  Wert gesetzt ist; in dem Fall gewinnt eine Color-Rolle (falls vorhanden)
   *  oder die Default-Text-Farbe. Update läuft über POST /me/profile. */
  profile_color?: string | null;
  /** Optionale zweite Farbe → der Name wird als Verlauf von profile_color nach
   *  profile_color_secondary gerendert. null/fehlend = einfarbig. */
  profile_color_secondary?: string | null;
  /** Richtung des Namens-Verlaufs in Grad (0–360, CSS-Winkel). null/fehlend =
   *  Default 90° (links→rechts). Nur relevant, wenn beide Farben gesetzt sind. */
  profile_gradient_angle?: number | null;
  /** Whether the user is entitled to run a self-hosted Pulse instance. */
  self_host_enabled?: boolean;
};

export type Guild = {
  id: string;
  name: string;
  icon_url: string | null;
  /** Owner's user-id as a snowflake string. Null in back-compat / mocked
   *  ready frames that pre-date the owner_id field — treat as "unknown". */
  owner_id: string | null;
  created_at: string;
  /** Per-guild attachment limits (MANAGE_GUILD-editable). Optional for
   *  back-compat / mocked frames that pre-date the fields. */
  attachment_max_size_bytes?: number;
  attachment_max_count_per_message?: number;
};

export type Channel = {
  id: string;
  guild_id: string;
  name: string;
  type: number; // 0 = text, 1 = voice
  position: number;
  topic: string | null;
  created_at: string;
  /** @everyone is denied VIEW_CHANNEL — only explicit role/user allows can
   *  see the channel. Drives the lock indicator in the channel list. */
  restricted?: boolean;
  /** Per-channel name styling (mirrors User.profile_color*). null/absent =
   *  plain default look. Two colors → gradient; one → solid; angle default 90°. */
  name_color?: string | null;
  name_color_secondary?: string | null;
  name_gradient_angle?: number | null;
};

export type ReactionAggregate = {
  emoji: string;
  count: number;
  me: boolean;
};

/**
 * One @-mention parsed out of a message's content at write time.
 * `type` is a numeric sentinel mirroring `dcc_chat_gateway/models/messages.py`:
 *   0 = user (`<@123>`), 1 = role (`<@&456>`), 2 = everyone / here literal.
 * `id` is the snowflake target (user-id or role-id) as a string; for
 * `type === 2` the server emits the sentinel "0" — we don't render it.
 */
export interface Mention {
  type: 0 | 1 | 2;
  id: string;
}

export type Attachment = {
  id: string;
  filename: string | null;
  mime: string | null;
  size: number;
  width?: number | null;
  height?: number | null;
  thumb_width?: number | null;
  thumb_height?: number | null;
  /** Presigned MinIO GET URL — ~30 min TTL, auto-refresh on 403 via
   *  `chatApi.refreshAttachmentDownloadUrl`. */
  url: string;
  thumb_url?: string | null;
};

export type Message = {
  id: string;
  channel_id: string;
  author_id: string;
  content: string;
  nonce: string | null;
  reply_to_id?: string | null;
  created_at: string;
  edited_at?: string | null;
  deleted_at?: string | null;
  reactions?: ReactionAggregate[];
  attachments?: Attachment[];
  /** Server-parsed mention list. Empty/absent when the message has none. */
  mentions?: Mention[];
};

/**
 * A 1:1 direct-message channel. Wire shape mirrors `DMChannelOut` on the
 * server: `other_user_id` is the *other* member relative to the caller.
 * `last_message_id` is null until the first message is sent — used to
 * sort the DM list by recency (snowflake IDs are time-ordered).
 */
export type DMChannel = {
  id: string;
  other_user_id: string;
  last_message_id: string | null;
  created_at: string;
  /**
   * Server-resolved gate: true iff a friendship exists AND no block sits
   * between the two users in either direction. Drives the hard-cut DM
   * composer disable (Etappe 4). Refreshed on every WS ``ready`` frame
   * and after friendship / block lifecycle events via DM-list re-hydrate.
   * Optional in the type to stay backwards-compat with older test payloads
   * (treat undefined as ``true`` to avoid false-positive disables).
   */
  can_send?: boolean;
};

export type Member = {
  guild_id: string;
  user_id: string;
  nickname: string | null;
  joined_at: string;
};

export type Ban = {
  guild_id: string;
  user_id: string;
  reason: string | null;
  banned_at: string;
  banned_by_id: string;
};

export type GuildSummary = {
  id: string;
  name: string;
  icon_url: string | null;
};

export type Invite = {
  code: string;
  guild_id: string;
  channel_id: string | null;
  max_uses: number | null;
  uses: number;
  expires_at: string | null;
  created_at: string;
};

export type InvitePreview = {
  guild: GuildSummary;
  channel_id: string | null;
  member_count: number;
};

export type AcceptInviteResult = {
  guild: GuildSummary;
  channel_id: string | null;
};

export type ApiError = {
  detail: string;
  status: number;
};

/**
 * One refresh-token "session" — a long-lived login on a single device/browser.
 * Mirrors `SessionOut` from the auth service: `is_current` is a server-side
 * heuristic (matches the current request's UA + IP-hash prefix), so the
 * frontend treats it as advisory only.
 *
 * `ip_hash_prefix` is the first 8 chars of SHA-256(ip + server-pepper) —
 * stable for a given network location, but not reversible. Two sessions
 * sharing the same prefix are *probably* from the same network (home wifi vs
 * mobile vs office), useful as a "is this me?" sanity-check signal.
 */
export interface Session {
  id: string;
  user_agent: string | null;
  created_at: string;
  last_used_at: string | null;
  is_current: boolean;
  ip_hash_prefix: string | null;
}
