export type UserVoiceState = {
  mic_muted: boolean;
  deafened: boolean;
};

export type VoiceChannelState = {
  channel_id: string;
  user_ids: string[];
  streaming_user_ids?: string[];
  user_states?: Record<string, UserVoiceState>;
};

class VoicePresenceStore {
  /** Maps channel_id → user_ids (always full snapshot from server). */
  byChannel = $state<Record<string, string[]>>({});
  /** Maps channel_id → streaming_user_ids. */
  streamingByChannel = $state<Record<string, string[]>>({});
  /** Maps channel_id → { user_id → {mic_muted, deafened} }. Missing entry
   * for a user means default-off; absence is the common case so we keep the
   * map sparse. */
  userStatesByChannel = $state<Record<string, Record<string, UserVoiceState>>>({});

  /** Seed from ready payload or REST re-sync. Replaces all existing state. */
  seed(states: VoiceChannelState[]): void {
    const next: Record<string, string[]> = {};
    const nextStreaming: Record<string, string[]> = {};
    const nextStates: Record<string, Record<string, UserVoiceState>> = {};
    for (const s of states) {
      if (s.user_ids.length > 0) next[s.channel_id] = s.user_ids;
      if (s.streaming_user_ids && s.streaming_user_ids.length > 0) {
        nextStreaming[s.channel_id] = s.streaming_user_ids;
      }
      if (s.user_states && Object.keys(s.user_states).length > 0) {
        nextStates[s.channel_id] = s.user_states;
      }
    }
    this.byChannel = next;
    this.streamingByChannel = nextStreaming;
    this.userStatesByChannel = nextStates;
  }

  /** Apply a single voice_state push (full snapshot for one channel). */
  apply(
    channelId: string,
    userIds: string[],
    streamingUserIds?: string[],
    userStates?: Record<string, UserVoiceState>
  ): void {
    if (userIds.length === 0) {
      if (this.byChannel[channelId] !== undefined) {
        const { [channelId]: _, ...rest } = this.byChannel;
        this.byChannel = rest;
      }
    } else {
      this.byChannel = { ...this.byChannel, [channelId]: userIds };
    }
    const ids = streamingUserIds ?? [];
    if (ids.length === 0) {
      if (this.streamingByChannel[channelId] !== undefined) {
        const { [channelId]: _, ...rest } = this.streamingByChannel;
        this.streamingByChannel = rest;
      }
    } else {
      this.streamingByChannel = { ...this.streamingByChannel, [channelId]: ids };
    }
    const states = userStates ?? {};
    // Drop entries for users no longer in the channel — the server already
    // filters but this keeps client state consistent if a push arrives out of
    // order (e.g. user left, but their state still cached server-side).
    const filtered: Record<string, UserVoiceState> = {};
    for (const uid of userIds) {
      const s = states[uid];
      if (s && (s.mic_muted || s.deafened)) filtered[uid] = s;
    }
    if (Object.keys(filtered).length === 0) {
      if (this.userStatesByChannel[channelId] !== undefined) {
        const { [channelId]: _, ...rest } = this.userStatesByChannel;
        this.userStatesByChannel = rest;
      }
    } else {
      this.userStatesByChannel = { ...this.userStatesByChannel, [channelId]: filtered };
    }
  }

  /** Optimistically remove a single user from a channel's presence list. */
  removeUser(channelId: string, userId: string): void {
    const current = this.byChannel[channelId];
    if (!current) return;
    const next = current.filter((id) => id !== userId);
    if (next.length === 0) {
      const { [channelId]: _, ...rest } = this.byChannel;
      this.byChannel = rest;
    } else {
      this.byChannel = { ...this.byChannel, [channelId]: next };
    }
    const currentStreaming = this.streamingByChannel[channelId];
    if (currentStreaming) {
      const nextStreaming = currentStreaming.filter((id) => id !== userId);
      if (nextStreaming.length === 0) {
        const { [channelId]: _, ...rest } = this.streamingByChannel;
        this.streamingByChannel = rest;
      } else {
        this.streamingByChannel = { ...this.streamingByChannel, [channelId]: nextStreaming };
      }
    }
    const currentStates = this.userStatesByChannel[channelId];
    if (currentStates && currentStates[userId]) {
      const { [userId]: _, ...restStates } = currentStates;
      if (Object.keys(restStates).length === 0) {
        const { [channelId]: _drop, ...rest } = this.userStatesByChannel;
        this.userStatesByChannel = rest;
      } else {
        this.userStatesByChannel = { ...this.userStatesByChannel, [channelId]: restStates };
      }
    }
  }

  usersIn(channelId: string): string[] {
    return this.byChannel[channelId] ?? [];
  }

  streamingIn(channelId: string): string[] {
    return this.streamingByChannel[channelId] ?? [];
  }

  userStatesIn(channelId: string): Record<string, UserVoiceState> {
    return this.userStatesByChannel[channelId] ?? {};
  }

  clear(): void {
    this.byChannel = {};
    this.streamingByChannel = {};
    this.userStatesByChannel = {};
  }
}

export const voicePresence = new VoicePresenceStore();
