export type VoiceChannelState = {
  channel_id: string;
  user_ids: string[];
  streaming_user_ids?: string[];
};

class VoicePresenceStore {
  /** Maps channel_id → user_ids (always full snapshot from server). */
  byChannel = $state<Record<string, string[]>>({});
  /** Maps channel_id → streaming_user_ids. */
  streamingByChannel = $state<Record<string, string[]>>({});

  /** Seed from ready payload or REST re-sync. Replaces all existing state. */
  seed(states: VoiceChannelState[]): void {
    const next: Record<string, string[]> = {};
    const nextStreaming: Record<string, string[]> = {};
    for (const s of states) {
      if (s.user_ids.length > 0) next[s.channel_id] = s.user_ids;
      if (s.streaming_user_ids && s.streaming_user_ids.length > 0) {
        nextStreaming[s.channel_id] = s.streaming_user_ids;
      }
    }
    this.byChannel = next;
    this.streamingByChannel = nextStreaming;
  }

  /** Apply a single voice_state push (full snapshot for one channel). */
  apply(channelId: string, userIds: string[], streamingUserIds?: string[]): void {
    if (userIds.length === 0) {
      if (this.byChannel[channelId] === undefined) return;
      const { [channelId]: _, ...rest } = this.byChannel;
      this.byChannel = rest;
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
  }

  usersIn(channelId: string): string[] {
    return this.byChannel[channelId] ?? [];
  }

  streamingIn(channelId: string): string[] {
    return this.streamingByChannel[channelId] ?? [];
  }

  clear(): void {
    this.byChannel = {};
    this.streamingByChannel = {};
  }
}

export const voicePresence = new VoicePresenceStore();
