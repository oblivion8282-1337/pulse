export type UserVoiceState = {
  mic_muted: boolean;
  deafened: boolean;
};

export type VoiceChannelState = {
  channel_id: string;
  user_ids: string[];
  streaming_user_ids?: string[];
  camera_user_ids?: string[];
  user_states?: Record<string, UserVoiceState>;
  /** Namen der Gäste (`gast-<id>` → getippter Name). Nur Gäste stehen darin.
   *  Muss mitreisen: für eine Gast-Kennung gibt es beim Klienten KEINE zweite
   *  Quelle — kein Profil, kein Mitgliedseintrag, nichts nachzuladen. */
  gast_namen?: Record<string, string>;
};

/** Trägt diese Präsenz-Kennung einen Gast (statt einer Nutzer-ID)?
 *  Spiegel von ``dcc_shared.gaeste.ist_gast`` — die Präsenz-Sets tragen beide
 *  Formen nebeneinander, und allein am Präfix entscheidet sich, ob die
 *  Oberfläche ein Profil nachschlagen darf. */
export function istGastKennung(id: string): boolean {
  return id.startsWith('gast-');
}

/** Setzt `karte[key]` neu oder trägt den Schlüssel bei leerem/fehlendem Wert
 *  aus — die Karten bleiben sparse (fehlende Zeile = Normalfall). Ein
 *  Austrägen, dessen Schlüssel fehlt, liefert dasselbe Objekt zurück
 *  (keine unnötige Reaktivität); Arrays zählen über ihre Länge. */
function setzenOderAus<T>(
  karte: Record<string, T>,
  key: string,
  wert: T | undefined
): Record<string, T> {
  if (!wert || Object.keys(wert).length === 0) {
    if (karte[key] === undefined) return karte;
    const { [key]: _, ...rest } = karte;
    return rest;
  }
  return { ...karte, [key]: wert };
}

class VoicePresenceStore {
  /** Maps channel_id → user_ids (always full snapshot from server). */
  byChannel = $state<Record<string, string[]>>({});
  /** Maps channel_id → streaming_user_ids. */
  streamingByChannel = $state<Record<string, string[]>>({});
  /** Maps channel_id → camera_user_ids (members with webcam published).
   * Server-tracked (LiveKit track_published webhook → voice-signaling), so it's
   * populated even for channels the local user isn't connected to — unlike the
   * client-only ``voice.cameraTracks`` which only sees subscribed remote tracks. */
  cameraByChannel = $state<Record<string, string[]>>({});
  /** Maps channel_id → { user_id → {mic_muted, deafened} }. Missing entry
   * for a user means default-off; absence is the common case so we keep the
   * map sparse. */
  userStatesByChannel = $state<Record<string, Record<string, UserVoiceState>>>({});
  /** Admin-applied voice-overrides per (channel, user). Carries both
   * ``muted`` (MUTE_MEMBERS) and ``deafened`` (DEAFEN_MEMBERS) flags;
   * fed by ``voice_override`` WS events. Survives reconnect server-side
   * (Redis) but the client only re-learns about it on the next event,
   * so a fresh page-load may briefly show stale "unmuted/undeafened" UI
   * for currently-connected targets until something toggles. */
  overrideByChannel = $state<
    Record<string, Record<string, { muted: boolean; deafened: boolean }>>
  >({});
  /** channel_id → { gast-Kennung → Name }. Siehe ``VoiceChannelState.gast_namen``. */
  gastNamenByChannel = $state<Record<string, Record<string, string>>>({});

  /** Seed from the ready payload (re-sync after WS (re)connect). Replaces all
   * existing state. */
  seed(states: VoiceChannelState[]): void {
    const next: Record<string, string[]> = {};
    const nextStreaming: Record<string, string[]> = {};
    const nextCamera: Record<string, string[]> = {};
    const nextStates: Record<string, Record<string, UserVoiceState>> = {};
    const nextGaeste: Record<string, Record<string, string>> = {};
    for (const s of states) {
      if (s.gast_namen && Object.keys(s.gast_namen).length > 0) {
        nextGaeste[s.channel_id] = s.gast_namen;
      }
      if (s.user_ids.length > 0) next[s.channel_id] = s.user_ids;
      if (s.streaming_user_ids && s.streaming_user_ids.length > 0) {
        nextStreaming[s.channel_id] = s.streaming_user_ids;
      }
      if (s.camera_user_ids && s.camera_user_ids.length > 0) {
        nextCamera[s.channel_id] = s.camera_user_ids;
      }
      if (s.user_states && Object.keys(s.user_states).length > 0) {
        nextStates[s.channel_id] = s.user_states;
      }
    }
    this.byChannel = next;
    this.streamingByChannel = nextStreaming;
    this.cameraByChannel = nextCamera;
    this.userStatesByChannel = nextStates;
    this.gastNamenByChannel = nextGaeste;
  }

  /** Hydrate the admin-override map from the ready payload.
   * Replaces the entire ``overrideByChannel`` (the server's view is
   * authoritative for the snapshot). */
  seedOverrides(
    overrides: { channel_id: string; user_id: string; muted: boolean; deafened: boolean }[]
  ): void {
    const next: Record<string, Record<string, { muted: boolean; deafened: boolean }>> = {};
    for (const o of overrides) {
      if (!o.muted && !o.deafened) continue;
      (next[o.channel_id] ||= {})[o.user_id] = {
        muted: !!o.muted,
        deafened: !!o.deafened
      };
    }
    this.overrideByChannel = next;
  }

  /** Apply a single voice_state push (full snapshot for one channel). */
  apply(
    channelId: string,
    userIds: string[],
    streamingUserIds?: string[],
    userStates?: Record<string, UserVoiceState>,
    cameraUserIds?: string[],
    gastNamen?: Record<string, string>
  ): void {
    this.gastNamenByChannel = setzenOderAus(this.gastNamenByChannel, channelId, gastNamen);
    this.byChannel = setzenOderAus(this.byChannel, channelId, userIds);
    this.streamingByChannel = setzenOderAus(this.streamingByChannel, channelId, streamingUserIds);
    this.cameraByChannel = setzenOderAus(this.cameraByChannel, channelId, cameraUserIds);
    const states = userStates ?? {};
    // Drop entries for users no longer in the channel — the server already
    // filters but this keeps client state consistent if a push arrives out of
    // order (e.g. user left, but their state still cached server-side).
    const filtered: Record<string, UserVoiceState> = {};
    for (const uid of userIds) {
      const s = states[uid];
      if (s && (s.mic_muted || s.deafened)) filtered[uid] = s;
    }
    this.userStatesByChannel = setzenOderAus(this.userStatesByChannel, channelId, filtered);
  }

  /** Optimistically remove a single user from a channel's presence list. */
  removeUser(channelId: string, userId: string): void {
    const current = this.byChannel[channelId];
    if (!current) return;
    this.byChannel = setzenOderAus(
      this.byChannel,
      channelId,
      current.filter((id) => id !== userId)
    );
    const currentStreaming = this.streamingByChannel[channelId];
    if (currentStreaming) {
      this.streamingByChannel = setzenOderAus(
        this.streamingByChannel,
        channelId,
        currentStreaming.filter((id) => id !== userId)
      );
    }
    const currentCamera = this.cameraByChannel[channelId];
    if (currentCamera) {
      this.cameraByChannel = setzenOderAus(
        this.cameraByChannel,
        channelId,
        currentCamera.filter((id) => id !== userId)
      );
    }
    const currentStates = this.userStatesByChannel[channelId];
    if (currentStates && currentStates[userId]) {
      const { [userId]: _, ...restStates } = currentStates;
      this.userStatesByChannel = setzenOderAus(this.userStatesByChannel, channelId, restStates);
    }
  }

  usersIn(channelId: string): string[] {
    return this.byChannel[channelId] ?? [];
  }

  /** Der Name eines Gastes in diesem Kanal — oder die Kennung als Rückfall.
   *  Ein fehlender Name (Redis gestört, Ticket gerade abgelaufen) ist ein
   *  Schönheitsfehler, kein Anlass, die Zeile wegzulassen: der Gast SITZT ja
   *  im Kanal, und eine Präsenzliste, die ihn verschweigt, wäre falsch. */
  gastName(channelId: string, id: string): string {
    return this.gastNamenByChannel[channelId]?.[id] ?? id;
  }

  streamingIn(channelId: string): string[] {
    return this.streamingByChannel[channelId] ?? [];
  }

  cameraIn(channelId: string): string[] {
    return this.cameraByChannel[channelId] ?? [];
  }

  userStatesIn(channelId: string): Record<string, UserVoiceState> {
    return this.userStatesByChannel[channelId] ?? {};
  }

  /** Apply a server voice-override event. When both flags are false we
   * drop the entry entirely so the map stays sparse. */
  applyOverride(
    channelId: string,
    userId: string,
    muted: boolean,
    deafened: boolean
  ): void {
    const current = this.overrideByChannel[channelId] ?? {};
    if (!muted && !deafened) {
      if (!current[userId]) return;
      const { [userId]: _, ...rest } = current;
      this.overrideByChannel = setzenOderAus(this.overrideByChannel, channelId, rest);
      return;
    }
    this.overrideByChannel = {
      ...this.overrideByChannel,
      [channelId]: { ...current, [userId]: { muted, deafened } }
    };
  }

  isForceMuted(channelId: string, userId: string): boolean {
    return !!this.overrideByChannel[channelId]?.[userId]?.muted;
  }

  isForceDeafened(channelId: string, userId: string): boolean {
    return !!this.overrideByChannel[channelId]?.[userId]?.deafened;
  }

  clear(): void {
    this.byChannel = {};
    this.streamingByChannel = {};
    this.cameraByChannel = {};
    this.userStatesByChannel = {};
    this.overrideByChannel = {};
    // Bughunt Runde 51: die sechste Karte war beim clear() vergessen
    // (Nachzügler aus dem Gast-Links-Bau) — Gastnamen des Vorgängers
    // überlebten den Kontowechsel bis zum nächsten ready.
    this.gastNamenByChannel = {};
  }
}

export const voicePresence = new VoicePresenceStore();
