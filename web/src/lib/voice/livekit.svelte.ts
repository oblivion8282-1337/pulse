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
import type {
  AudioCaptureOptions,
  RoomOptions,
  ScreenShareCaptureOptions,
  TrackPublishOptions,
  VideoResolution
} from 'livekit-client';
import { getVoiceToken } from '$lib/api/voice';
import { voiceState } from './state.svelte';
import { voicePresence } from '$lib/stores/voicePresence.svelte';
import { RemoteAudioElements } from './audioElements';
import { settings } from '$lib/stores/settings.svelte';
import { AudioDevices } from './audioDevices.svelte';
import { createNoiseProcessor } from './noiseFilter';
import { ScreenShareTracks, type ScreenShareTrack } from './screenTracks.svelte';
import { nameFor, userIdFromIdentity } from './identity';
import { auth } from '$lib/stores/auth.svelte';
import { toast } from 'svelte-sonner';

export type { ScreenShareTrack };

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

  /** Whether the local participant is currently sharing their screen. */
  isScreenSharing = $state(false);

  /** True when the browser blocked audio playback (autoplay policy). */
  audioBlocked = $state(false);

  /** 0..1 instantaneous level of the local microphone (for the meter). */
  localMicLevel = $state(0);

  #screenShare = new ScreenShareTracks();
  #room: Room | null = null;
  #audioEls = new RemoteAudioElements();
  #devices = new AudioDevices(this.#audioEls, () => this.applyNoiseFilter());
  #levelTimer: ReturnType<typeof setInterval> | null = null;
  #teardownDone = false;
  /** Active noise-suppression processor mode, so we don't re-apply unnecessarily. */
  #noiseProcessorMode: string = 'off';

  /** Remote screen-share tracks currently active in the room. */
  get screenTracks(): ScreenShareTrack[] {
    return this.#screenShare.list;
  }

  /** Available audio input/output devices + current selections (for the pickers). */
  get inputDevices(): MediaDeviceInfo[] {
    return this.#devices.inputs;
  }
  get outputDevices(): MediaDeviceInfo[] {
    return this.#devices.outputs;
  }
  get selectedInputDeviceId(): string {
    return this.#devices.selectedInputId;
  }
  get selectedOutputDeviceId(): string {
    return this.#devices.selectedOutputId;
  }

  /** Push-to-talk active when settings.voice.pttMode is true. Mirrors the store. */
  get pttMode(): boolean {
    return settings.voice.pttMode;
  }

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

    this.#teardownDone = false;
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

    const room = new Room(this.#roomOptions());
    this.#room = room;
    this.#audioEls.deafened = this.deafened;
    this.#audioEls.outputDeviceId = this.#devices.selectedOutputId;
    this.#audioEls.setUserVolumes(settings.voice.userVolumes);
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
    await this.#devices.refresh(room);

    // Live on join (Discord-style), unless PTT mode keeps the mic muted.
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
      await room.localParticipant.setMicrophoneEnabled(on, this.#audioCaptureDefaults());
      this.micEnabled = on;
      if (on) await this.applyNoiseFilter();
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
    settings.setPttMode(on);
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
    this.#audioEls.setDeafened(on);
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
    this.#audioEls.replayAll();
    this.audioBlocked = !room.canPlaybackAudio;
  }

  async setScreenShare(on: boolean): Promise<void> {
    const room = this.#room;
    if (!room) return;
    try {
      if (on) {
        const s = settings.screenShare;
        const captureOptions: ScreenShareCaptureOptions = { audio: true, contentHint: s.contentHint };
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
          screenShareEncoding: { maxBitrate: s.bitrateMbps * 1_000_000, maxFramerate: s.fps }
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
        if (msg.includes('codec') || msg.includes('encodingparameters') || msg.includes('unsupportederror')) {
          // A real codec/encoding rejection from the publish step — e.g. H.264 or
          // AV1 in the desktop client (Electron's Chromium can't encode those for
          // WebRTC). VP8/VP9 always work.
          toast.error(
            `Codec ${settings.screenShare.codec.toUpperCase()} wird hier nicht unterstützt — stell ihn in den Einstellungen auf VP9 um.`
          );
        } else if (msg.includes('not supported') || msg.includes('failed to start')) {
          // getDisplayMedia couldn't acquire a source.
          toast.error('Bildschirm teilen ist hier nicht verfügbar.', { description: e.message });
        } else if (
          !msg.includes('cancel') &&
          !msg.includes('abort') &&
          !msg.includes('permission') &&
          !msg.includes('denied')
        ) {
          toast.error('Bildschirm teilen fehlgeschlagen', { description: e.message });
        }
      }
    }
  }

  toggleScreenShare(): void {
    void this.setScreenShare(!this.isScreenSharing);
  }

  async setInputDevice(deviceId: string): Promise<void> {
    await this.#devices.setInput(this.#room, deviceId);
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    await this.#devices.setOutput(this.#room, deviceId);
  }

  /** Live-apply a per-user gain change to any currently-subscribed track for
   *  that user. Persisting happens in `settings.setUserVolume` — call both. */
  setUserVolume(userId: string, volume: number): void {
    this.#audioEls.setUserVolume(userId, volume);
  }

  /**
   * (Re)apply the noise-suppression processor to the local mic track based on
   * `settings.audio.noiseSuppression`. No-op when not connected / no mic track.
   */
  async applyNoiseFilter(): Promise<void> {
    const room = this.#room;
    if (!room) return;
    const mode = settings.audio.noiseSuppression;
    const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    const audioTrack = pub?.audioTrack;
    if (!audioTrack) return;
    if (mode === this.#noiseProcessorMode) return;
    try {
      if (mode === 'rnnoise' || mode === 'deepfilternet') {
        await audioTrack.setProcessor(createNoiseProcessor(mode));
      } else {
        await audioTrack.stopProcessor();
      }
      this.#noiseProcessorMode = mode;
    } catch (e) {
      this.#noiseProcessorMode = 'off';
      toast.error('Rauschunterdrückung konnte nicht aktiviert werden', {
        description: e instanceof Error ? e.message : undefined
      });
    }
  }

  // --- internals -----------------------------------------------------

  #roomOptions(): RoomOptions {
    const a = settings.audio;
    return {
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: this.#audioCaptureDefaults(),
      publishDefaults: {
        audioPreset: { maxBitrate: a.voiceBitrateKbps * 1000 },
        forceStereo: a.stereo,
        dtx: true,
        red: true
      }
    };
  }

  #audioCaptureDefaults(): AudioCaptureOptions {
    const a = settings.audio;
    const opts: AudioCaptureOptions = {
      autoGainControl: a.autoGainControl,
      echoCancellation: a.echoCancellation,
      // Browser NS only when explicitly selected — otherwise our own processor
      // (rnnoise/deepfilternet) handles it, or nothing ('off').
      noiseSuppression: a.noiseSuppression === 'browser',
      // forceStereo only signals stereo in the SDP — the capture needs 2 real
      // channels for stereo audio to actually be transmitted.
      channelCount: a.stereo ? 2 : 1
    };
    if (a.inputDeviceId) opts.deviceId = a.inputDeviceId;
    return opts;
  }

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
      .on(RoomEvent.LocalTrackPublished, (pub) => {
        if (pub.source === Track.Source.Microphone) void this.applyNoiseFilter();
        this.#refreshParticipants();
      })
      .on(RoomEvent.LocalTrackUnpublished, (pub) => {
        if (pub.source === Track.Source.ScreenShare) {
          this.isScreenSharing = false;
        }
        if (pub.source === Track.Source.Microphone) this.#noiseProcessorMode = 'off';
        this.#refreshParticipants();
      })
      .on(RoomEvent.ConnectionQualityChanged, () => this.#refreshParticipants())
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) => {
        if (track.kind === Track.Kind.Audio) {
          if (pub.source === Track.Source.ScreenShareAudio) {
            this.#screenShare.addAudio(track as RemoteAudioTrack, p);
          } else {
            this.#audioEls.attach(
              track as RemoteAudioTrack,
              userIdFromIdentity(p.identity) ?? p.identity,
              () => {
                this.audioBlocked = true;
              }
            );
          }
        } else if (track.kind === Track.Kind.Video && pub.source === Track.Source.ScreenShare) {
          this.#screenShare.addVideo(track as RemoteVideoTrack, p);
        }
        this.#refreshParticipants();
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        if (track.source === Track.Source.ScreenShareAudio) {
          this.#screenShare.removeAudio(track as RemoteAudioTrack);
        } else {
          this.#audioEls.detach(track.sid ?? '');
        }
        if (track.kind === Track.Kind.Video && track.source === Track.Source.ScreenShare) {
          this.#screenShare.removeVideo(track.sid ?? '');
        }
        this.#refreshParticipants();
      })
      .on(RoomEvent.MediaDevicesChanged, () => {
        void this.#devices.refresh(this.#room);
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => {
        this.audioBlocked = !this.#room?.canPlaybackAudio;
      });
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
    this.#levelTimer = setInterval(() => this.#patchAudioLevels(), 200);
  }

  #patchAudioLevels(): void {
    const room = this.#room;
    if (!room) return;
    let changed = false;
    const allParticipants: Participant[] = [
      room.localParticipant as LocalParticipant,
      ...room.remoteParticipants.values()
    ];
    const participantMap = new Map<string, Participant>(allParticipants.map((p) => [p.identity, p]));
    for (const vp of this.participants) {
      const p = participantMap.get(vp.identity);
      if (!p) continue;
      const newLevel = p.audioLevel ?? 0;
      const newSpeaking = p.isSpeaking;
      if (vp.audioLevel !== newLevel || vp.isSpeaking !== newSpeaking) {
        vp.audioLevel = newLevel;
        vp.isSpeaking = newSpeaking;
        changed = true;
      }
    }
    if (changed) this.participants = [...this.participants];
    const localLevel = room.localParticipant.audioLevel ?? 0;
    if (Math.abs(localLevel - this.localMicLevel) > 0.005) this.localMicLevel = localLevel;
  }

  #stopLevelPolling(): void {
    if (this.#levelTimer) {
      clearInterval(this.#levelTimer);
      this.#levelTimer = null;
    }
    this.localMicLevel = 0;
  }

  #teardown(): void {
    if (this.#teardownDone) return;
    this.#teardownDone = true;
    this.#stopLevelPolling();
    this.#audioEls.clear();
    this.#room = null;
    this.#noiseProcessorMode = 'off';
    this.state = ConnectionState.Disconnected;
    if (this.channelId) {
      const myUserId = auth.user?.id;
      if (myUserId) voicePresence.removeUser(this.channelId, myUserId);
    }
    this.channelId = null;
    this.channelName = null;
    this.participants = [];
    this.micEnabled = false;
    this.deafened = false;
    this.isScreenSharing = false;
    this.#screenShare.clear();
    this.audioBlocked = false;
    voiceState.channelId = null;
    voiceState.connected = false;
  }
}

export const voice = new VoiceRoom();
