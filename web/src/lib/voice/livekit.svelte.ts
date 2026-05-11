/**
 * Thin Svelte 5 runes wrapper around the LiveKit JS SDK.
 *
 * We subscribe to the raw `Room`/`Participant` events and mirror the
 * pieces of state we render into `$state` fields. This keeps the
 * reactivity boundary in one place and avoids dragging in RxJS via
 * `@livekit/components-core` (its observables are shaped for React).
 *
 * One instance lives module-global (`voice` export) — only one active
 * voice connection at a time, like Discord.
 */

import {
  ConnectionState,
  ConnectionQuality,
  LocalParticipant,
  Participant,
  RemoteAudioTrack,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  Room,
  RoomEvent,
  Track
} from 'livekit-client';
import { getVoiceToken } from '$lib/api/voice';
import { voiceState } from './state.svelte';

export type VoiceParticipant = {
  /** LiveKit identity, e.g. `user-<snowflake>`. */
  identity: string;
  /** Display name (username), falls back to identity. */
  name: string;
  /** Our app user id parsed out of the identity, if possible. */
  userId: string | null;
  isLocal: boolean;
  isSpeaking: boolean;
  /** 0..1 instantaneous audio level (only meaningful while speaking). */
  audioLevel: number;
  /** Whether the participant's microphone track is muted. */
  micMuted: boolean;
  connectionQuality: ConnectionQuality;
};

function userIdFromIdentity(identity: string): string | null {
  const m = identity.match(/^user-(\d+)$/);
  return m ? m[1] : null;
}

function nameFor(p: Participant): string {
  return p.name && p.name.trim() ? p.name : p.identity;
}

class VoiceRoom {
  /** The id of the channel we are connected to (or connecting to). */
  channelId = $state<string | null>(null);
  /** Human-readable channel name for UI; set by the caller on connect. */
  channelName = $state<string | null>(null);
  state = $state<ConnectionState>(ConnectionState.Disconnected);
  /** Last error message from a failed connect, surfaced to the UI. */
  error = $state<string | null>(null);

  participants = $state<VoiceParticipant[]>([]);

  /** Local mic on/off (publish state). */
  micEnabled = $state(false);
  /** "Deafen": locally mute all remote audio. */
  deafened = $state(false);
  /** Push-to-talk active (true = transmitting). When PTT mode is off, this stays true. */
  pttMode = $state(false);

  /** Available audio output devices for the device picker. */
  outputDevices = $state<MediaDeviceInfo[]>([]);
  selectedOutputDeviceId = $state<string>('');

  #room: Room | null = null;
  /** Detached <audio> elements for remote tracks, keyed by track sid. */
  #audioEls = new Map<string, HTMLMediaElement>();
  #levelTimer: ReturnType<typeof setInterval> | null = null;

  get connected(): boolean {
    return this.state === ConnectionState.Connected;
  }
  get connecting(): boolean {
    return this.state === ConnectionState.Connecting || this.state === ConnectionState.SignalReconnecting;
  }

  /** Connect to the LiveKit room backing the given voice channel. */
  async connect(channelId: string, channelName: string): Promise<void> {
    if (this.#room && (this.connected || this.connecting)) {
      if (this.channelId === channelId) return;
      await this.disconnect();
    }
    this.error = null;
    this.channelId = channelId;
    this.channelName = channelName;
    this.state = ConnectionState.Connecting;

    let resp;
    try {
      resp = await getVoiceToken(channelId, 'voice');
    } catch (e) {
      this.state = ConnectionState.Disconnected;
      this.channelId = null;
      this.channelName = null;
      this.error = e instanceof Error ? e.message : 'Token-Anfrage fehlgeschlagen';
      throw e;
    }

    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      // Browser AEC / NS / AGC defaults — good enough for the MVP. A
      // future polish step can layer @jitsi/rnnoise-wasm on top.
      audioCaptureDefaults: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true
      }
    });
    this.#room = room;
    this.#wireEvents(room);

    try {
      await room.connect(resp.ws_url, resp.token);
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Verbindung zu LiveKit fehlgeschlagen';
      this.#teardown();
      throw e;
    }

    this.state = room.state;
    voiceState.channelId = channelId;
    voiceState.connected = room.state === ConnectionState.Connected;
    this.#refreshParticipants();
    this.#startLevelPolling();
    await this.#refreshOutputDevices();

    // Publish the mic by default (Discord-style: you're live on join,
    // unless PTT mode is enabled — then it stays muted until you press).
    if (!this.pttMode) {
      await this.setMicEnabled(true);
    } else {
      this.micEnabled = false;
    }
  }

  async disconnect(): Promise<void> {
    const room = this.#room;
    if (!room) return;
    try {
      await room.disconnect();
    } finally {
      this.#teardown();
    }
  }

  async setMicEnabled(on: boolean): Promise<void> {
    const room = this.#room;
    if (!room) return;
    try {
      await room.localParticipant.setMicrophoneEnabled(on);
      this.micEnabled = on;
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Mikrofon-Zugriff fehlgeschlagen';
    }
    this.#refreshParticipants();
  }

  toggleMic(): void {
    void this.setMicEnabled(!this.micEnabled);
  }

  /** Enable/disable push-to-talk mode. Entering PTT mode mutes the mic. */
  async setPttMode(on: boolean): Promise<void> {
    this.pttMode = on;
    if (on) {
      await this.setMicEnabled(false);
    } else {
      await this.setMicEnabled(true);
    }
  }

  /** Called from the PTT key handler — opens the mic while held. */
  pttPress(): void {
    if (!this.pttMode || !this.connected) return;
    if (!this.micEnabled) void this.setMicEnabled(true);
  }
  pttRelease(): void {
    if (!this.pttMode || !this.connected) return;
    if (this.micEnabled) void this.setMicEnabled(false);
  }

  setDeafened(on: boolean): void {
    this.deafened = on;
    for (const el of this.#audioEls.values()) {
      el.muted = on;
    }
  }
  toggleDeafen(): void {
    this.setDeafened(!this.deafened);
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    const room = this.#room;
    this.selectedOutputDeviceId = deviceId;
    // Update already-attached elements + tell the room for future ones.
    if (room) {
      try {
        await room.switchActiveDevice('audiooutput', deviceId);
      } catch {
        /* setSinkId not supported in some browsers — ignore */
      }
    }
    for (const el of this.#audioEls.values()) {
      const anyEl = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
      if (typeof anyEl.setSinkId === 'function') {
        try {
          await anyEl.setSinkId(deviceId);
        } catch {
          /* ignore */
        }
      }
    }
  }

  // --- internals -----------------------------------------------------

  #wireEvents(room: Room): void {
    room
      .on(RoomEvent.ConnectionStateChanged, (s: ConnectionState) => {
        this.state = s;
        voiceState.connected = s === ConnectionState.Connected;
        if (s === ConnectionState.Disconnected) this.#teardown();
      })
      .on(RoomEvent.Disconnected, () => {
        this.#teardown();
      })
      .on(RoomEvent.ParticipantConnected, () => this.#refreshParticipants())
      .on(RoomEvent.ParticipantDisconnected, () => this.#refreshParticipants())
      .on(RoomEvent.ActiveSpeakersChanged, () => this.#refreshParticipants())
      .on(RoomEvent.TrackMuted, () => this.#refreshParticipants())
      .on(RoomEvent.TrackUnmuted, () => this.#refreshParticipants())
      .on(RoomEvent.LocalTrackPublished, () => this.#refreshParticipants())
      .on(RoomEvent.LocalTrackUnpublished, () => this.#refreshParticipants())
      .on(RoomEvent.ConnectionQualityChanged, () => this.#refreshParticipants())
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub: RemoteTrackPublication, _p: RemoteParticipant) => {
        if (track.kind === Track.Kind.Audio) {
          this.#attachAudio(track as RemoteAudioTrack);
        }
        this.#refreshParticipants();
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        this.#detachAudio(track.sid ?? '');
        this.#refreshParticipants();
      })
      .on(RoomEvent.MediaDevicesChanged, () => {
        void this.#refreshOutputDevices();
      });

    // Per-tick speaking-level updates aren't an event; LiveKit exposes
    // `audioLevel` on participants and fires ActiveSpeakersChanged, which
    // we already listen to. For smooth glow we additionally poll lightly
    // while connected.
  }

  #attachAudio(track: RemoteAudioTrack): void {
    const sid = track.sid ?? `t-${Math.random()}`;
    const el = track.attach();
    el.autoplay = true;
    el.muted = this.deafened;
    if (this.selectedOutputDeviceId) {
      const anyEl = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
      if (typeof anyEl.setSinkId === 'function') {
        void anyEl.setSinkId(this.selectedOutputDeviceId).catch(() => undefined);
      }
    }
    el.style.display = 'none';
    document.body.appendChild(el);
    this.#audioEls.set(sid, el);
  }

  #detachAudio(sid: string): void {
    const el = this.#audioEls.get(sid);
    if (el) {
      el.remove();
      this.#audioEls.delete(sid);
    }
  }

  #refreshParticipants(): void {
    const room = this.#room;
    if (!room) {
      this.participants = [];
      return;
    }
    const out: VoiceParticipant[] = [];
    const toVP = (p: Participant, isLocal: boolean): VoiceParticipant => ({
      identity: p.identity,
      name: nameFor(p),
      userId: userIdFromIdentity(p.identity),
      isLocal,
      isSpeaking: p.isSpeaking,
      audioLevel: p.audioLevel ?? 0,
      micMuted: !p.isMicrophoneEnabled,
      connectionQuality: p.connectionQuality
    });
    out.push(toVP(room.localParticipant as LocalParticipant, true));
    for (const p of room.remoteParticipants.values()) {
      out.push(toVP(p, false));
    }
    // Stable order: local first, then by name.
    out.sort((a, b) => (a.isLocal === b.isLocal ? a.name.localeCompare(b.name) : a.isLocal ? -1 : 1));
    this.participants = out;
  }

  #startLevelPolling(): void {
    this.#stopLevelPolling();
    // 400ms poll: only update audioLevel/isSpeaking in-place to avoid
    // rebuilding the full array every tick (which re-renders all tiles).
    this.#levelTimer = setInterval(() => this.#patchAudioLevels(), 400);
  }

  #patchAudioLevels(): void {
    const room = this.#room;
    if (!room) return;
    let changed = false;
    const allParticipants: Participant[] = [
      room.localParticipant as LocalParticipant,
      ...room.remoteParticipants.values()
    ];
    for (const vp of this.participants) {
      const p = allParticipants.find((x) => x.identity === vp.identity);
      if (!p) continue;
      const newLevel = p.audioLevel ?? 0;
      const newSpeaking = p.isSpeaking;
      if (vp.audioLevel !== newLevel || vp.isSpeaking !== newSpeaking) {
        vp.audioLevel = newLevel;
        vp.isSpeaking = newSpeaking;
        changed = true;
      }
    }
    // Trigger reactivity only when something actually changed.
    if (changed) this.participants = [...this.participants];
  }
  #stopLevelPolling(): void {
    if (this.#levelTimer) {
      clearInterval(this.#levelTimer);
      this.#levelTimer = null;
    }
  }

  async #refreshOutputDevices(): Promise<void> {
    try {
      const devices = await Room.getLocalDevices('audiooutput');
      this.outputDevices = devices;
      if (!this.selectedOutputDeviceId && devices[0]) {
        this.selectedOutputDeviceId = devices[0].deviceId;
      }
    } catch {
      this.outputDevices = [];
    }
  }

  #teardown(): void {
    this.#stopLevelPolling();
    for (const el of this.#audioEls.values()) el.remove();
    this.#audioEls.clear();
    this.#room = null;
    this.state = ConnectionState.Disconnected;
    this.channelId = null;
    this.channelName = null;
    this.participants = [];
    this.micEnabled = false;
    this.deafened = false;
    voiceState.channelId = null;
    voiceState.connected = false;
  }
}

export const voice = new VoiceRoom();
