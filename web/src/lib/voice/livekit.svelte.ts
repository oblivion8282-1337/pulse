
import {
  ConnectionState,
  ConnectionQuality,
  LocalParticipant,
  Participant,
  RemoteAudioTrack,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  RemoteVideoTrack,
  Room,
  RoomEvent,
  Track
} from 'livekit-client';
import type { ScreenShareCaptureOptions, TrackPublishOptions, VideoResolution } from 'livekit-client';
import { getVoiceToken } from '$lib/api/voice';
import { voiceState } from './state.svelte';
import { screenShareSettings } from '$lib/stores/screenShareSettings.svelte';
import { toast } from 'svelte-sonner';

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

/** A remote screen-share track from one participant. */
export type ScreenShareTrack = {
  /** LiveKit participant identity. */
  identity: string;
  /** Display name for the sharer. */
  name: string;
  track: RemoteVideoTrack;
  /** Accompanying screen-share audio track, if published. */
  audioTrack?: RemoteAudioTrack;
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

  /** Whether the local participant is currently sharing their screen. */
  isScreenSharing = $state(false);
  /** Remote screen-share tracks currently active in the room. */
  screenTracks = $state<ScreenShareTrack[]>([]);

  /** True when the browser blocked audio playback (autoplay policy). */
  audioBlocked = $state(false);

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

    // We're still inside the user gesture that triggered connect() — resume the
    // AudioContext now so attached <audio> elements can play (autoplay policy).
    try {
      await room.startAudio();
    } catch {
      // startAudio rejects if already started — harmless.
    }

    this.state = room.state;
    this.audioBlocked = !room.canPlaybackAudio;
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

  /** Call from a synchronous click handler to unblock the browser AudioContext. */
  async unblockAudio(): Promise<void> {
    const room = this.#room;
    if (!room) return;
    try {
      await room.startAudio();
    } catch {
      // startAudio can throw if already started — harmless.
    }
    // Nudge our detached <audio> elements; screen-share audio is handled at the
    // track level by startAudio() above.
    for (const el of this.#audioEls.values()) {
      void el.play().catch(() => undefined);
    }
    this.audioBlocked = !room.canPlaybackAudio;
  }

  async setScreenShare(on: boolean): Promise<void> {
    const room = this.#room;
    if (!room) return;
    try {
      if (on) {
        const s = screenShareSettings;
        const captureOptions: ScreenShareCaptureOptions = {
          audio: true,
          contentHint: s.contentHint
        };
        if (s.resolution !== 'native') {
          const resMap: Record<string, VideoResolution> = {
            '1080p': { width: 1920, height: 1080, frameRate: s.fps },
            '720p': { width: 1280, height: 720, frameRate: s.fps },
            '480p': { width: 854, height: 480, frameRate: s.fps }
          };
          captureOptions.resolution = resMap[s.resolution];
        }
        const publishOptions: TrackPublishOptions = {
          videoCodec: s.codec,
          screenShareEncoding: {
            maxBitrate: s.bitrateMbps * 1_000_000,
            maxFramerate: s.fps
          }
        };
        await room.localParticipant.setScreenShareEnabled(true, captureOptions, publishOptions);
        this.isScreenSharing = true;
      } else {
        await room.localParticipant.setScreenShareEnabled(false);
        this.isScreenSharing = false;
      }
    } catch (e) {
      this.isScreenSharing = false;
      if (e instanceof Error) {
        const msg = e.message.toLowerCase();
        if (msg.includes('codec') || msg.includes('not supported') || msg.includes('encodingparameters')) {
          toast.error(`Codec "${screenShareSettings.codec.toUpperCase()}" wird von deinem Browser nicht unterstützt — versuch VP9 oder H.264`);
        } else if (!msg.includes('cancel') && !msg.includes('abort') && !msg.includes('permission')) {
          // User cancelled the browser picker — no toast needed.
          // Only show error for unexpected failures.
          toast.error('Bildschirm teilen fehlgeschlagen', { description: e.message });
        }
      }
    }
  }

  toggleScreenShare(): void {
    void this.setScreenShare(!this.isScreenSharing);
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
      .on(RoomEvent.LocalTrackUnpublished, (pub) => {
        if (pub.source === Track.Source.ScreenShare) {
          this.isScreenSharing = false;
        }
        this.#refreshParticipants();
      })
      .on(RoomEvent.ConnectionQualityChanged, () => this.#refreshParticipants())
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) => {
        if (track.kind === Track.Kind.Audio) {
          if (pub.source === Track.Source.ScreenShareAudio) {
            this.#attachScreenAudio(track as RemoteAudioTrack, p);
          } else {
            this.#attachAudio(track as RemoteAudioTrack);
          }
        } else if (track.kind === Track.Kind.Video && pub.source === Track.Source.ScreenShare) {
          this.#addScreenTrack(track as RemoteVideoTrack, p);
        }
        this.#refreshParticipants();
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        if (track.source === Track.Source.ScreenShareAudio) {
          this.#detachScreenAudio(track as RemoteAudioTrack);
        } else {
          this.#detachAudio(track.sid ?? '');
        }
        if (track.kind === Track.Kind.Video && track.source === Track.Source.ScreenShare) {
          this.#removeScreenTrack(track.sid ?? '');
        }
        this.#refreshParticipants();
      })
      .on(RoomEvent.MediaDevicesChanged, () => {
        void this.#refreshOutputDevices();
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => {
        this.audioBlocked = !this.#room?.canPlaybackAudio;
      });
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
    void el.play().catch(() => {
      // Autoplay blocked — surface the overlay so the user can unblock.
      this.audioBlocked = true;
    });
  }

  #detachAudio(sid: string): void {
    const el = this.#audioEls.get(sid);
    if (el) {
      el.remove();
      this.#audioEls.delete(sid);
    }
  }

  #attachScreenAudio(track: RemoteAudioTrack, p: RemoteParticipant): void {
    this.screenTracks = this.screenTracks.map((st) =>
      st.identity === p.identity ? { ...st, audioTrack: track } : st
    );
  }

  #detachScreenAudio(track: RemoteAudioTrack): void {
    this.screenTracks = this.screenTracks.map((st) =>
      st.audioTrack?.sid === track.sid ? { ...st, audioTrack: undefined } : st
    );
  }

  #addScreenTrack(track: RemoteVideoTrack, p: RemoteParticipant): void {
    const existing = this.screenTracks.find((s) => s.identity === p.identity);
    if (existing) return; // already tracked
    this.screenTracks = [
      ...this.screenTracks,
      { identity: p.identity, name: nameFor(p), track }
    ];
  }

  #removeScreenTrack(sid: string): void {
    this.screenTracks = this.screenTracks.filter((s) => s.track.sid !== sid);
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
    out.sort((a, b) => (a.isLocal === b.isLocal ? a.name.localeCompare(b.name) : a.isLocal ? -1 : 1));
    this.participants = out;
  }

  #startLevelPolling(): void {
    this.#stopLevelPolling();
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
    this.isScreenSharing = false;
    this.screenTracks = [];
    this.audioBlocked = false;
    voiceState.channelId = null;
    voiceState.connected = false;
  }
}

export const voice = new VoiceRoom();
