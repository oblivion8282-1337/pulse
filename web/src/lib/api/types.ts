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
  disabled: boolean;
  created_at: string;
};

export type Guild = {
  id: string;
  name: string;
  icon_url: string | null;
  owner_id: string;
  created_at: string;
};

export type Channel = {
  id: string;
  guild_id: string;
  name: string;
  type: number; // 0 = text, 1 = voice
  position: number;
  topic: string | null;
  created_at: string;
};

export type ReactionAggregate = {
  emoji: string;
  count: number;
  me: boolean;
};

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
