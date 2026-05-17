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
import { watchPartyPresence } from '$lib/stores/watchPartyPresence.svelte';
import { RemoteAudioElements } from './audioElements';
import { settings } from '$lib/stores/settings.svelte';
import { AudioDevices } from './audioDevices.svelte';
import { createSendProcessor, type SendProcessorMode } from './noiseFilter';
import { LocalMicAnalyser } from './localMicAnalyser';
import { ScreenShareTracks, type ScreenShareTrack } from './screenTracks.svelte';
import { nameFor, userIdFromIdentity } from './identity';
import { auth } from '$lib/stores/auth.svelte';
import { gateway } from '$lib/ws/connection';
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
  /** Whether the local user is currently speaking (RMS-based, not server). */
  localSpeaking = $state(false);
  /** 0..1 instantaneous level AFTER the noise filter + makeup gain — what's
   *  actually going into the encoder, i.e. what other listeners hear. */
  localSendLevel = $state(0);
  /** 0..1 peak-hold position of the send signal — same dBFS scaling as level,
   *  but follows transient peaks (instant attack, ~800 ms decay). Sprache hat
   *  hohen Crest-Faktor — der Peak liegt deutlich oberhalb der RMS-Anzeige
   *  und ist das was das Clip-Lämpchen tatsächlich triggert. */
  localSendPeak = $state(0);
  /** True while the post-gain send signal is clipping (~ -1 dBFS peak). */
  localSendClip = $state(false);

  #screenShare = new ScreenShareTracks();
  #room: Room | null = null;
  #audioEls = new RemoteAudioElements();
  #devices = new AudioDevices(this.#audioEls, () => this.applyNoiseFilter());
  #localMic = new LocalMicAnalyser(
    (n) => {
      this.localMicLevel = n;
      // No send-side processor installed = raw mic IS the published track.
      // Mirror the input level/peak into the send meters so the settings panel
      // still shows sensible values and the clip lamp works in that mode too.
      if (this.#sendProcessorMode === 'off') this.localSendLevel = n;
    },
    (s) => { this.#setLocalSpeaking(s); },
    (c) => {
      if (this.#sendProcessorMode === 'off') this.localSendClip = c;
    },
    (p) => {
      if (this.#sendProcessorMode === 'off') this.localSendPeak = p;
    }
  );
  /** Display-level state for the send meter (peak-meter ballistics, identical
   *  shape to what LocalMicAnalyser does for raw mic but driven by the
   *  in-processor tap callback so we stay in the processor's AudioContext). */
  #sendDisplayLevel = 0;
  #sendDisplayPeak = 0;
  #sendClipping = false;
  #sendClipUntilMs = 0;
  #levelTimer: ReturnType<typeof setInterval> | null = null;
  /** Mic state captured at deafen-on so un-deafen can restore it. */
  #micEnabledBeforeDeafen = false;
  #teardownDone = false;
  /** Effective send-processor state. Drives applyNoiseFilter's swap decisions —
   *  re-evaluated against (noiseSuppression, inputMakeupGain≠1) on every call. */
  #sendProcessorMode: 'off' | SendProcessorMode = 'off';
  /** Live-tune handle for the post-RNNoise hard gate (null when filter is off
   *  or the gain-only processor is the active one). */
  #noiseGateSetter: ((openDb: number) => void) | null = null;
  /** Live-tune handle for the post-gate makeup gain (null when no processor). */
  #makeupSetter: ((v: number) => void) | null = null;

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
      // Switching channels = user-driven leave of the old one. End any
      // hosted watch party there.
      await this.disconnect({ reason: 'user' });
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
    // Make sure the gateway has our state even if neither setMicEnabled nor
    // setDeafened ran (PTT mode + not deafened = both false → no setter fired,
    // but we still want to clear any stale state from a previous session).
    this.#publishSelfState();
  }

  /**
   * Tear down the LiveKit room. Pass `reason: 'user'` for an *explicit*
   * leave (PhoneOff click, channel switch) — this is the only path that
   * also ends any watch party the local user is hosting in the channel.
   * Page-unload / sign-out / guild-deleted callers omit the reason so a
   * brief page refresh doesn't kill the host's party.
   */
  async disconnect(opts: { reason?: 'user' } = {}): Promise<void> {
    const room = this.#room;
    if (!room) return;
    if (opts.reason === 'user') {
      const cid = this.channelId;
      if (cid && auth.user) {
        const party = watchPartyPresence.partyIn(cid);
        if (party && party.host_user_id === auth.user.id) {
          gateway.stopWatchParty(cid);
        }
      }
    }
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
      if (on) {
        await this.applyNoiseFilter();
        this.#attachLocalAnalyser();
      } else {
        this.#localMic.detach();
        this.#resetSendLevel();
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Mikrofon-Zugriff fehlgeschlagen';
    }
    this.#refreshParticipants();
    this.#publishSelfState();
  }

  toggleMic(): void {
    // Explicit user toggle while deafened cancels the auto-restore on
    // un-deafen — they've taken ownership of the mic state.
    if (this.deafened) this.#micEnabledBeforeDeafen = false;
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
    if (on === this.deafened) return;
    // Discord-style: deafen also mutes the mic (no point talking if you can't
    // hear reactions), un-deafen restores the prior mic state. PTT users
    // never get auto-unmuted — their default mic state is "off until held."
    if (on) {
      this.#micEnabledBeforeDeafen = this.micEnabled;
      if (this.micEnabled) void this.setMicEnabled(false);
    } else {
      if (this.#micEnabledBeforeDeafen && !this.pttMode) {
        void this.setMicEnabled(true);
      }
      this.#micEnabledBeforeDeafen = false;
    }
    this.deafened = on;
    this.#audioEls.setDeafened(on);
    this.#publishSelfState();
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
   * (Re)apply the send-side processor to the local mic track based on the
   * current `noiseSuppression` and `inputMakeupGain` settings:
   *   NS = 'rnnoise_gated'                → RnnoiseGatedTrackProcessor (gain inside)
   *   NS = 'off', inputMakeupGain ≠ 1.0   → GainOnlyTrackProcessor
   *   NS = 'off', inputMakeupGain = 1.0   → no processor (raw mic published)
   * No-op when not connected / no mic track. Cheap when the target mode
   * matches the current one — just live-tunes the makeup gain.
   */
  async applyNoiseFilter(): Promise<void> {
    const room = this.#room;
    if (!room) return;
    const ns = settings.audio.noiseSuppression;
    const gain = settings.audio.inputMakeupGain;
    const target: 'off' | SendProcessorMode =
      ns === 'rnnoise_gated' ? 'rnnoise_gated' : gain !== 1 ? 'gain_only' : 'off';
    const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    const audioTrack = pub?.audioTrack;
    if (!audioTrack) return;
    if (target === this.#sendProcessorMode) {
      // Same mode — just live-tune the makeup. Cheap, no track swap.
      this.#makeupSetter?.(gain);
      return;
    }
    try {
      if (target === 'off') {
        await audioTrack.stopProcessor();
        this.#noiseGateSetter = null;
        this.#makeupSetter = null;
        this.#resetSendLevel();
      } else {
        const handle = createSendProcessor(target, settings.audio.noiseGateThresholdDb, gain);
        await audioTrack.setProcessor(handle.processor);
        this.#noiseGateSetter = handle.setGateThreshold;
        this.#makeupSetter = handle.setMakeupGain;
        handle.setLevelTap(this.#onSendLevel);
      }
      this.#sendProcessorMode = target;
      // Processor swap replaces the published mediaStreamTrack — rebind raw meter.
      this.#attachLocalAnalyser();
    } catch (e) {
      this.#sendProcessorMode = 'off';
      this.#noiseGateSetter = null;
      this.#makeupSetter = null;
      this.#resetSendLevel();
      toast.error('Audio-Pfad konnte nicht aktualisiert werden', {
        description: e instanceof Error ? e.message : undefined
      });
    }
  }

  /** Live-update the post-RNNoise hard-gate open threshold (dB). No-op when
   *  the filter is off. Persisting is the caller's job. */
  setNoiseGateThresholdDb(openDb: number): void {
    this.#noiseGateSetter?.(openDb);
  }

  /** Live-update the sender-side makeup gain on whatever processor is currently
   *  installed. If no processor is installed (NS off + previous gain was 1.0),
   *  the change won't be audible until applyNoiseFilter() reruns — typically
   *  via the slider's onchange handler. Persisting is the caller's job. */
  setInputMakeupGain(v: number): void {
    this.#makeupSetter?.(v);
  }

  // --- internals -----------------------------------------------------

  #roomOptions(): RoomOptions {
    const a = settings.audio;
    const customProcessor = a.noiseSuppression !== 'off';
    return {
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: this.#audioCaptureDefaults(),
      publishDefaults: {
        audioPreset: { maxBitrate: a.voiceBitrateKbps * 1000 },
        forceStereo: a.stereo && !customProcessor,
        // DTX off: keep a constant Opus stream even in speech gaps so the
        // listener gets real room tone (and any noise-suppressor-fed near-
        // silent signal still flows through). Costs ~+50 % audio bandwidth
        // per user; acceptable for small Pulse channels. RED stays on for
        // packet-loss resilience.
        dtx: false,
        red: true
      }
    };
  }

  #audioCaptureDefaults(): AudioCaptureOptions {
    const a = settings.audio;
    const customProcessor = a.noiseSuppression !== 'off';
    const opts: AudioCaptureOptions = {
      autoGainControl: customProcessor ? false : a.autoGainControl,
      echoCancellation: a.echoCancellation,
      // RNNoise+Gate handles noise — no browser-side NS layered on top.
      noiseSuppression: false,
      // Custom processor is mono — stereo capture yields nothing.
      channelCount: a.stereo && !customProcessor ? 2 : 1
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
        if (pub.source === Track.Source.Microphone) {
          void this.applyNoiseFilter();
          this.#attachLocalAnalyser();
        }
        this.#refreshParticipants();
      })
      .on(RoomEvent.LocalTrackUnpublished, (pub) => {
        if (pub.source === Track.Source.ScreenShare) {
          this.isScreenSharing = false;
        }
        if (pub.source === Track.Source.Microphone) {
          this.#sendProcessorMode = 'off';
          this.#noiseGateSetter = null;
          this.#makeupSetter = null;
          this.#localMic.detach();
          this.#resetSendLevel();
        }
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
      // Local: RMS-driven (server's active-speaker detection is unreliable
      // when AGC is off, which is the default with RNNoise).
      isSpeaking: isLocal ? this.localSpeaking : p.isSpeaking,
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
      // Local isSpeaking is owned by LocalMicAnalyser — don't let the
      // server-driven value (which often stays false with AGC off) clobber it.
      const newSpeaking = vp.isLocal ? vp.isSpeaking : p.isSpeaking;
      if (vp.audioLevel !== newLevel || vp.isSpeaking !== newSpeaking) {
        vp.audioLevel = newLevel;
        vp.isSpeaking = newSpeaking;
        changed = true;
      }
    }
    if (changed) this.participants = [...this.participants];
    // localMicLevel is driven by LocalMicAnalyser (Web Audio RMS), not by
    // LiveKit's server-side speaker detection — that one only updates when
    // the server has decided you're an active speaker, which is useless as
    // a real-time input meter.
  }

  #stopLevelPolling(): void {
    if (this.#levelTimer) {
      clearInterval(this.#levelTimer);
      this.#levelTimer = null;
    }
  }

  #attachLocalAnalyser(): void {
    const room = this.#room;
    if (!room) return;
    const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    const audioTrack = pub?.audioTrack;
    // Prefer the raw source MediaStreamTrack over the public getter, which
    // returns the post-processor (RNNoise) track — that attenuates the signal
    // noticeably and makes the meter look dead even at normal speech.
    // `_mediaStreamTrack` is protected in livekit-client; accessed via cast.
    const raw = (audioTrack as { _mediaStreamTrack?: MediaStreamTrack } | undefined)?._mediaStreamTrack;
    this.#localMic.attach(raw ?? audioTrack?.mediaStreamTrack ?? null);
  }

  /** RAF-callback from the processor's internal post-gain AnalyserNode tap.
   *  Same ballistics + dBFS scaling as LocalMicAnalyser so both meters look
   *  consistent. Clip flag is driven by raw peak amplitude > ~-1 dBFS with a
   *  300 ms hold so a single crackle stays visible. */
  #onSendLevel = (rms: number, peak: number): void => {
    // RMS bar (smooth, peak-meter ballistics).
    let level = 0;
    if (rms > 0.0005) {
      const db = 20 * Math.log10(rms);
      level = Math.max(0, Math.min(1, (db + 50) / 45));
    }
    if (level > this.#sendDisplayLevel) this.#sendDisplayLevel = level;
    else this.#sendDisplayLevel = this.#sendDisplayLevel * 0.85 + level * 0.15;
    this.localSendLevel = this.#sendDisplayLevel;
    // Peak-hold (same scale; slow decay so the peak line is readable).
    let peakLevel = 0;
    if (peak > 0.0005) {
      const pdb = 20 * Math.log10(peak);
      peakLevel = Math.max(0, Math.min(1, (pdb + 50) / 45));
    }
    if (peakLevel > this.#sendDisplayPeak) this.#sendDisplayPeak = peakLevel;
    else this.#sendDisplayPeak = this.#sendDisplayPeak * 0.97 + peakLevel * 0.03;
    this.localSendPeak = this.#sendDisplayPeak;
    // Clip on raw peak amplitude > ~-1 dBFS.
    const now = performance.now();
    if (peak >= 0.891) {
      this.#sendClipUntilMs = now + 300;
      if (!this.#sendClipping) {
        this.#sendClipping = true;
        this.localSendClip = true;
      }
    } else if (this.#sendClipping && now >= this.#sendClipUntilMs) {
      this.#sendClipping = false;
      this.localSendClip = false;
    }
  };

  #resetSendLevel(): void {
    this.#sendDisplayLevel = 0;
    this.#sendDisplayPeak = 0;
    this.#sendClipping = false;
    this.#sendClipUntilMs = 0;
    this.localSendLevel = 0;
    this.localSendPeak = 0;
    this.localSendClip = false;
  }

  #setLocalSpeaking(s: boolean): void {
    if (this.localSpeaking === s) return;
    this.localSpeaking = s;
    const idx = this.participants.findIndex((p) => p.isLocal);
    if (idx >= 0 && this.participants[idx].isSpeaking !== s) {
      const copy = [...this.participants];
      copy[idx] = { ...copy[idx], isSpeaking: s };
      this.participants = copy;
    }
  }

  #teardown(): void {
    if (this.#teardownDone) return;
    this.#teardownDone = true;
    this.#stopLevelPolling();
    this.#localMic.detach();
    this.#resetSendLevel();
    this.#audioEls.clear();
    this.#room = null;
    this.#sendProcessorMode = 'off';
    this.#noiseGateSetter = null;
    this.#makeupSetter = null;
    this.state = ConnectionState.Disconnected;
    if (this.channelId) {
      const myUserId = auth.user?.id;
      if (myUserId) voicePresence.removeUser(this.channelId, myUserId);
      // Tell the gateway we're no longer in a voice channel so it drops our
      // mute/deafen state and republishes the channel snapshot to peers.
      try {
        gateway.sendVoiceSelfState(null, false, false);
      } catch {
        // The gateway connection might be down — state will time-out via the
        // server-side TTL.
      }
    }
    this.channelId = null;
    this.channelName = null;
    this.participants = [];
    this.micEnabled = false;
    this.deafened = false;
    this.#micEnabledBeforeDeafen = false;
    this.isScreenSharing = false;
    this.#screenShare.clear();
    this.audioBlocked = false;
    voiceState.channelId = null;
    voiceState.connected = false;
  }

  /** Push the local mute/deafen state to the chat-gateway so peers see it.
   * No-op when we are not currently connected to a voice channel — the
   * gateway only accepts state for a valid voice channel id. */
  #publishSelfState(): void {
    if (!this.channelId) return;
    try {
      gateway.sendVoiceSelfState(this.channelId, !this.micEnabled, this.deafened);
    } catch {
      // Best effort — drop the update if the WS is not open. The next state
      // change (or a manual re-emit on reconnect) will catch up.
    }
  }
}

export const voice = new VoiceRoom();
