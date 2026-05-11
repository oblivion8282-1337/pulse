export type VoiceChannelState = {
  channel_id: string;
  user_ids: string[];
};

class VoicePresenceStore {
  /** Maps channel_id → user_ids (always full snapshot from server). */
  byChannel = $state<Record<string, string[]>>({});

  /** Seed from ready payload or REST re-sync. Replaces all existing state. */
  seed(states: VoiceChannelState[]): void {
    const next: Record<string, string[]> = {};
    for (const s of states) {
      if (s.user_ids.length > 0) next[s.channel_id] = s.user_ids;
    }
    this.byChannel = next;
  }

  /** Apply a single voice_state push (full snapshot for one channel). */
  apply(channelId: string, userIds: string[]): void {
    if (userIds.length === 0) {
      if (this.byChannel[channelId] === undefined) return;
      const { [channelId]: _, ...rest } = this.byChannel;
      this.byChannel = rest;
    } else {
      this.byChannel = { ...this.byChannel, [channelId]: userIds };
    }
  }

  usersIn(channelId: string): string[] {
    return this.byChannel[channelId] ?? [];
  }

  clear(): void {
    this.byChannel = {};
  }
}

export const voicePresence = new VoicePresenceStore();
