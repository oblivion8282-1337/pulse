import {
  ConnectionState,
  ConnectionQuality,
  LocalParticipant,
  LocalVideoTrack,
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
import { setVoiceMediaSession, clearVoiceMediaSession } from './mediaSession';
import { settings } from '$lib/stores/settings.svelte';
import { capabilities } from '$lib/stores/capabilities.svelte';
import { clampNsResolution } from '$lib/settings-registry/sections/screenShare';
import { AudioDevices } from './audioDevices.svelte';
import { createSendProcessor, type SendProcessorMode } from './noiseFilter';
import { LocalMicAnalyser } from './localMicAnalyser';
import { SpeakingDetector } from './speakingDetector';
import { RemoteSpeakingTracker } from './remoteSpeakingTracker';
import { ScreenShareTracks, type ScreenShareTrack } from './screenTracks.svelte';
import { CameraTracks, type CameraTrack } from './cameraTracks.svelte';
import {
  acquireWindowAudioStream,
  canUseWindowAudioCapture
} from './windowAudioCapture';
import { installH264HwHint } from './h264HwHint';
import { nameFor, userIdFromIdentity } from './identity';
import { auth } from '$lib/stores/auth.svelte';
import { guilds } from '$lib/stores/guilds.svelte';
import { gateway } from '$lib/ws/connection';
import { sounds } from '$lib/sounds/engine';
import { toast } from 'svelte-sonner';
import { m } from '$lib/paraglide/messages.js';

export type { ScreenShareTrack, CameraTrack };

// Einmalig vor dem ersten Room-Aufbau: H.264-`42e01f`-Profile in den
// Codec-Preferences ans Ende, damit Chrome auf Windows MediaFoundation (NVENC/
// QSV/AMF) statt OpenH264 nimmt. Details siehe `h264HwHint.ts`.
installH264HwHint();

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
  /** Whether this participant is publishing an unmuted camera track. */
  cameraOn: boolean;
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
  /** Whether the local participant is currently publishing a camera track. */
  isCameraOn = $state(false);
  /** The local user's own published camera track — drives the self-preview
   *  tile. `null` while the camera is off. Without this the user never sees
   *  their own webcam (only remote cams are rendered). */
  localCameraTrack = $state<LocalVideoTrack | null>(null);
  /** Which physical camera the local cam uses. Toggled by flipCamera() —
   *  matters on phones (front 'user' vs back 'environment'). */
  cameraFacing = $state<'user' | 'environment'>('user');

  /** True when the browser blocked audio playback (autoplay policy). */
  audioBlocked = $state(false);

  /** 0..1 instantaneous level of the local microphone (for the meter). */
  localMicLevel = $state(0);
  /** 0..1 peak-hold position of the raw mic — instant attack, ~800 ms decay.
   *  Rendered as a thin line over the RMS fill in the input-device meter. */
  localMicPeak = $state(0);
  /** True while raw-mic peaks exceed ~-1 dBFS (300 ms hold). Indicates an OS-
   *  level mic-gain problem — RNNoise and the makeup slider can't recover from
   *  pre-capture clipping, so this gets its own lamp distinct from sendClip. */
  localMicClip = $state(false);
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
  #cameras = new CameraTracks();
  /** Tracks owned by the Win11 per-window-audio bypass path. `null` while the
   *  regular LiveKit `setScreenShareEnabled` path is in use (or no share is
   *  active). We keep raw MediaStreamTracks here so we can `.stop()` them on
   *  teardown — LiveKit's own lifecycle covers only its managed tracks. */
  #bypassVideoTrack: MediaStreamTrack | null = null;
  #bypassAudioTrack: MediaStreamTrack | null = null;
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
    (s) => {
      // Raw mic only drives the speaking ring when there is no send-processor.
      // With a processor installed, the post-gain tap (#onSendLevel →
      // #sendSpeakingDetector) is the source of truth — what listeners
      // actually hear, not what hit the mic.
      if (this.#sendProcessorMode === 'off') this.#setLocalSpeaking(s);
    },
    (c) => {
      this.localMicClip = c;
      if (this.#sendProcessorMode === 'off') this.localSendClip = c;
    },
    (p) => {
      this.localMicPeak = p;
      if (this.#sendProcessorMode === 'off') this.localSendPeak = p;
    }
  );
  /** Drives `localSpeaking` from the post-processor send-tap RMS. Only fed
   *  while a send-processor (RNNoise+Gate or gain-only) is installed; raw-mic
   *  mode uses LocalMicAnalyser's own detector instead. */
  #sendSpeakingDetector = new SpeakingDetector((s) => this.#setLocalSpeaking(s));
  /** Per-remote-participant speaking state, computed client-side from the
   *  subscribed audio track. */
  #remoteSpeaking = new RemoteSpeakingTracker((identity, speaking) =>
    this.#onRemoteSpeakingChange(identity, speaking)
  );
  /** Display-level state for the send meter (peak-meter ballistics, identical
   *  shape to what LocalMicAnalyser does for raw mic but driven by the
   *  in-processor tap callback so we stay in the processor's AudioContext). */
  #sendDisplayLevel = 0;
  #sendDisplayPeak = 0;
  #sendClipping = false;
  #sendClipUntilMs = 0;

  /** Mic state captured at deafen-on so un-deafen can restore it. */
  #micEnabledBeforeDeafen = false;
  #teardownDone = false;
  /** Monotonic connect counter. Each `connect()` captures its value; an
   *  await that returns to find `#connectGen` moved on knows a newer
   *  connect (or a disconnect) superseded it and bails — without this a
   *  fast double-click builds two `Room`s and orphans the first. */
  #connectGen = 0;
  /** Effective send-processor state. Drives applyNoiseFilter's swap decisions —
   *  re-evaluated against (noiseSuppression, inputMakeupGain≠1) on every call. */
  #sendProcessorMode: 'off' | SendProcessorMode = 'off';
  /** Live-tune handle for the post-RNNoise hard gate (null when filter is off
   *  or the gain-only processor is the active one). */
  #noiseGateSetter: ((openDb: number) => void) | null = null;
  /** Live-tune handle for the post-gate makeup gain (null when no processor). */
  #makeupSetter: ((v: number) => void) | null = null;
  /** True while a queueMicrotask-deferred #refreshParticipants is pending.
   *  Coalesces bursts of LiveKit events (e.g. ParticipantConnected +
   *  TrackSubscribed×N) into a single rebuild so Svelte re-renders once. */
  #refreshScheduled = false;

  /** Remote screen-share tracks currently active in the room. */
  get screenTracks(): ScreenShareTrack[] {
    return this.#screenShare.list;
  }

  /** Local screen-share video track (whatever path published it: regular
   *  LiveKit setScreenShareEnabled or the Win11 windowAudio-bypass) — both
   *  end up as a publication with source === ScreenShare on the local
   *  participant. Returns null when not sharing. Used by the streamer-side
   *  stats overlay to read outbound-rtp + encoderImplementation. */
  get localScreenShareTrack(): LocalVideoTrack | null {
    const room = this.#room;
    if (!room || !this.isScreenSharing) return null;
    const pub = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    return (pub?.videoTrack as LocalVideoTrack | undefined) ?? null;
  }

  /** Remote camera (webcam) tracks currently active in the room. */
  get cameraTracks(): CameraTrack[] {
    return this.#cameras.list;
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
    // Claim this connect. Any earlier connect still in flight (its `#room`
    // not yet assigned, so the guard above couldn't see it) will notice the
    // bump after its next await and abort instead of building a second Room.
    const gen = ++this.#connectGen;
    this.error = null;
    this.channelId = channelId;
    this.channelName = channelName;
    this.state = ConnectionState.Connecting;

    this.#teardownDone = false;
    let resp;
    try {
      resp = await getVoiceToken(channelId, 'voice');
    } catch (e) {
      // Only roll back shared state if we're still the current connect —
      // otherwise a newer connect already owns `this.*`.
      if (gen === this.#connectGen) {
        this.state = ConnectionState.Disconnected;
        this.channelId = null;
        this.channelName = null;
        this.error = e instanceof Error ? e.message : m.livekit_token_request_failed();
      }
      throw e;
    }
    // Superseded during the token fetch — drop out silently before building
    // a Room. The newer connect owns the UI state from here.
    if (gen !== this.#connectGen) return;

    const room = new Room(this.#roomOptions());
    this.#room = room;
    this.#audioEls.deafened = this.deafened;
    this.#audioEls.outputDeviceId = this.#devices.selectedOutputId;
    this.#audioEls.setUserVolumes(settings.voice.userVolumes);
    this.#audioEls.setLimiterEnabled(settings.audio.limiterEnabled);
    this.#wireEvents(room);

    try {
      await room.connect(resp.ws_url, resp.token);
    } catch (e) {
      this.error = e instanceof Error ? e.message : m.livekit_connection_failed();
      this.#teardown();
      throw e;
    }

    // Superseded while the LiveKit handshake ran — tear down the room we just
    // built so it doesn't linger connected + mic-publishing as an orphan.
    if (gen !== this.#connectGen) {
      await room.disconnect().catch(() => undefined);
      return;
    }

    // We're still inside the user gesture that triggered connect() — resume the
    // AudioContext now so attached <audio> elements can play (autoplay policy).
    try {
      await room.startAudio();
    } catch {
      // startAudio rejects if already started — harmless.
    }

    // Re-check generation: a channel switch may have started while startAudio
    // was awaiting. If so, the new connect already owns this.#room and the
    // shared state — bail without clobbering it.
    if (gen !== this.#connectGen) {
      await room.disconnect().catch(() => undefined);
      return;
    }

    this.state = room.state;
    this.audioBlocked = !room.canPlaybackAudio;
    voiceState.channelId = channelId;
    voiceState.connected = room.state === ConnectionState.Connected;
    this.#refreshParticipants();
    this.#startLevelPolling();
    await this.#devices.refresh(room);

    // Re-check again after devices.refresh() — same risk of a concurrent
    // connect that replaced this.#room during the await.
    if (gen !== this.#connectGen) return;

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
    // Register an OS media session so mobile keeps the call audio alive while
    // backgrounded / screen-locked (paired with the unmuted <audio> path in
    // RemoteAudioElements). No-op off mobile.
    setVoiceMediaSession(this.channelName);
    sounds.play('voice.self_join', { guildId: guilds.guildIdForChannel(channelId) });
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
    sounds.play('voice.self_leave', { guildId: guilds.guildIdForChannel(this.channelId ?? '') });
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
      this.error = e instanceof Error ? e.message : m.livekit_microphone_access_failed();
    }
    this.#refreshParticipants();
    this.#publishSelfState();
  }

  /** Admin force-mute / force-deafen for the local user in the current
   *  channel. The UI disables the mic/deafen buttons on this, but the
   *  keyboard shortcuts call toggleMic/toggleDeafen directly — so the gate
   *  lives at those entry points, reading the same store the buttons do. */
  #selfOverride(): { muted: boolean; deafened: boolean } {
    const cid = this.channelId;
    const uid = auth.user?.id;
    if (!cid || !uid) return { muted: false, deafened: false };
    return {
      muted: voicePresence.isForceMuted(cid, uid),
      deafened: voicePresence.isForceDeafened(cid, uid)
    };
  }

  toggleMic(): void {
    // Force-muted by an admin → the mic toggle is inert (button is disabled;
    // this also blocks the keyboard-shortcut path). Mirrors toggleDeafen.
    if (this.#selfOverride().muted) return;
    // Explicit user toggle while deafened cancels the auto-restore on
    // un-deafen — they've taken ownership of the mic state.
    if (this.deafened) this.#micEnabledBeforeDeafen = false;
    const target = !this.micEnabled;
    sounds.play(target ? 'voice.self_unmute' : 'voice.self_mute', {
      guildId: guilds.guildIdForChannel(this.channelId ?? '')
    });
    void this.setMicEnabled(target);
  }

  /** Enable/disable push-to-talk mode. Entering PTT mode mutes the mic. */
  async setPttMode(on: boolean): Promise<void> {
    settings.setPttMode(on);
    if (on) {
      await this.setMicEnabled(false);
    } else {
      // Respect admin force-mute: don't enable the mic if an admin has muted us.
      if (this.#selfOverride().muted) return;
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
    sounds.play(on ? 'voice.self_deafen' : 'voice.self_undeafen', {
      guildId: guilds.guildIdForChannel(this.channelId ?? '')
    });
    this.#publishSelfState();
  }
  toggleDeafen(): void {
    // Force-deafened by an admin → refuse to un-deafen until the override is
    // cleared. The deafen button is disabled in the UI; this closes the
    // keyboard-shortcut bypass (voice.toggleDeafen → here, ungated before).
    if (this.#selfOverride().deafened) return;
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
        // Enforce the admin-set normal-stream limits (best-effort, client-side
        // — LiveKit/the SFU don't gate these). Clamp fps/bitrate into the band
        // and cap the resolution to the ceiling before building the options.
        const fps = Math.min(capabilities.nsFpsMax, Math.max(capabilities.nsFpsMin, s.fps));
        const bitrateMbps = Math.min(
          capabilities.nsBitrateMaxKbps / 1000,
          Math.max(capabilities.nsBitrateMinKbps / 1000, s.bitrateMbps)
        );
        const resolution = clampNsResolution(s.resolution, capabilities.nsResolutionMax);
        const resMap: Record<string, VideoResolution> = {
          '1080p': { width: 1920, height: 1080, frameRate: fps },
          '720p': { width: 1280, height: 720, frameRate: fps },
          '480p': { width: 854, height: 480, frameRate: fps }
        };
        const publishOptions: TrackPublishOptions = {
          videoCodec: s.codec,
          screenShareEncoding: { maxBitrate: bitrateMbps * 1_000_000, maxFramerate: fps }
        };
        // Win11 + Chrome/Edge 141+: bypass LiveKit's setScreenShareEnabled to
        // pass `windowAudio:"window"` (not exposed in ScreenShareCaptureOptions
        // and dropped by LiveKit's constraint whitelist). On other platforms
        // / older Chromium the bypass would silently strip audio entirely
        // (systemAudio:"exclude" with no per-window-audio fallback) — keep the
        // regular LiveKit path there.
        if (await canUseWindowAudioCapture()) {
          const stream = await acquireWindowAudioStream({
            resolution: resolution !== 'native' ? resMap[resolution] : undefined
          });
          // Mirror what LiveKit does internally for ScreenShareCaptureOptions
          // — contentHint goes on the track, not in getDisplayMedia constraints.
          const v = stream.getVideoTracks()[0];
          if (v) v.contentHint = s.contentHint;
          await this.#publishBypassStream(room.localParticipant, stream, publishOptions);
          this.isScreenSharing = true;
        } else {
          const captureOptions: ScreenShareCaptureOptions = {
            audio: true,
            contentHint: s.contentHint
          };
          if (resolution !== 'native') captureOptions.resolution = resMap[resolution];
          await room.localParticipant.setScreenShareEnabled(
            true,
            captureOptions,
            publishOptions
          );
          this.isScreenSharing = true;
        }
      } else {
        if (this.#bypassVideoTrack) {
          await this.#unpublishBypass(room.localParticipant);
        } else {
          await room.localParticipant.setScreenShareEnabled(false);
        }
        this.isScreenSharing = false;
      }
    } catch (e) {
      this.isScreenSharing = false;
      if (e instanceof Error) {
        const msg = e.message.toLowerCase();
        if (msg.includes('codec') || msg.includes('encodingparameters') || msg.includes('unsupportederror')) {
          // A real codec/encoding rejection from the publish step. AV1 is the
          // more likely culprit (no HW encode on older GPUs + Chromium's WebRTC
          // AV1-encode path is gated). H.264 is the safe fallback we point at.
          const current = settings.screenShare.codec.toUpperCase();
          const fallback = settings.screenShare.codec === 'av1' ? 'H.264' : 'AV1';
          toast.error(m.livekit_codec_unsupported({ current, fallback }));
        } else if (msg.includes('not supported') || msg.includes('failed to start')) {
          // getDisplayMedia couldn't acquire a source.
          toast.error(m.livekit_screenshare_unavailable(), { description: e.message });
        } else if (
          !msg.includes('cancel') &&
          !msg.includes('abort') &&
          !msg.includes('permission') &&
          !msg.includes('denied')
        ) {
          toast.error(m.livekit_screenshare_failed(), { description: e.message });
        }
      }
    }
  }

  toggleScreenShare(): void {
    void this.setScreenShare(!this.isScreenSharing);
  }

  /** Webcam capture resolution + fps, derived from the admin-configured
   *  instance ceiling (capabilities.camResolutionMax / camFpsMax). The
   *  defaults (720p/30) mirror the formerly hard-coded values, so nothing
   *  changes until an admin raises the cap in /app/admin. Used for both the
   *  initial publish and flipCamera's in-place restart so a facing swap keeps
   *  the same quality. LiveKit's adaptiveStream still downscales per subscriber. */
  #camCaptureResolution(): { width: number; height: number; frameRate: number } {
    const dims: Record<string, { width: number; height: number }> = {
      '1440p': { width: 2560, height: 1440 },
      '1080p': { width: 1920, height: 1080 },
      '720p': { width: 1280, height: 720 },
      '480p': { width: 854, height: 480 }
    };
    const d = dims[capabilities.camResolutionMax] ?? dims['720p'];
    const frameRate = Math.min(Math.max(capabilities.camFpsMax || 30, 1), 60);
    return { width: d.width, height: d.height, frameRate };
  }

  /** Publish/unpublish the local camera track. Capture resolution + fps come
   *  from the admin-configured instance ceiling (#camCaptureResolution); the
   *  default 720p/30 keeps egress sane when several cams are on at once. */
  async setCamera(on: boolean): Promise<void> {
    const room = this.#room;
    if (!room) {
      // Pressed before the voice room finished connecting (mobile auto-join
      // race) — previously this was a silent no-op, which read as "nothing
      // happens" to the user.
      if (on)
        toast.error(m.livekit_camera_failed(), {
          description: 'Voice ist noch nicht verbunden.'
        });
      return;
    }
    try {
      if (on) {
        await room.localParticipant.setCameraEnabled(true, {
          resolution: this.#camCaptureResolution(),
          facingMode: this.cameraFacing
        });
        this.isCameraOn = true;
      } else {
        // Turn the cam OFF by *unpublishing*, not just muting. LiveKit's
        // setCameraEnabled(false) only mutes — the publication stays alive, so
        // (a) the server-side track_unpublished webhook never fires and
        // voice-signaling's camera-presence set keeps the CAM badge lit on every
        // client, and (b) our own RoomEvent.LocalTrackUnpublished handler never
        // runs, so localCameraTrack stays set and the self-preview tile lingers.
        // Unpublishing (stopOnUnpublish=true) tears both down — and releases the
        // camera hardware/LED, which mute does not. Mirrors screen-share stop.
        const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
        const track = (pub?.videoTrack as LocalVideoTrack | undefined) ?? this.localCameraTrack;
        if (track) {
          await room.localParticipant.unpublishTrack(track, true);
        } else {
          await room.localParticipant.setCameraEnabled(false);
        }
        this.isCameraOn = false;
        this.localCameraTrack = null;
      }
    } catch (e) {
      this.isCameraOn = false;
      // Surface the failure instead of swallowing it. On mobile a denied
      // camera permission or a busy device is the usual cause, and silently
      // eating the error left the user with no idea why the cam stayed off.
      console.error('[voice] camera enable failed', e);
      if (e instanceof Error) {
        toast.error(m.livekit_camera_failed(), { description: e.message });
      }
    }
  }

  toggleCamera(): void {
    void this.setCamera(!this.isCameraOn);
  }

  /** Switch between front ('user') and back ('environment') camera. Restarts
   *  the existing publication's track in place so the swap is seamless and
   *  remote subscribers keep the same track. No-op unless the cam is live. */
  async flipCamera(): Promise<void> {
    const track = this.localCameraTrack;
    if (!track) return;
    const next = this.cameraFacing === 'user' ? 'environment' : 'user';
    try {
      await track.restartTrack({
        resolution: this.#camCaptureResolution(),
        facingMode: next
      });
      this.cameraFacing = next;
    } catch (e) {
      console.error('[voice] camera flip failed', e);
      if (e instanceof Error) toast.error(m.livekit_camera_failed(), { description: e.message });
    }
  }

  /**
   * Publish a stream acquired by the Win11 per-window-audio bypass path
   * (`getDisplayMedia({ windowAudio:"window" })`) to LiveKit as ScreenShare +
   * ScreenShareAudio tracks. Stops the stream on publish failure so the
   * picker doesn't leak. Hooks `onended` on the video so the browser-side
   * "Stop sharing" bar triggers our own cleanup.
   */
  async #publishBypassStream(
    lp: LocalParticipant,
    stream: MediaStream,
    publishOptions: TrackPublishOptions
  ): Promise<void> {
    const videoTrack = stream.getVideoTracks()[0];
    const audioTrack = stream.getAudioTracks()[0] ?? null;
    if (!videoTrack) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('getDisplayMedia returned no video track');
    }
    let videoPublished = false;
    try {
      await lp.publishTrack(videoTrack, { source: Track.Source.ScreenShare, ...publishOptions });
      videoPublished = true;
      if (audioTrack) {
        await lp.publishTrack(audioTrack, { source: Track.Source.ScreenShareAudio });
      }
    } catch (e) {
      // Publish failed mid-way — unpublish the video track if it was already
      // published (otherwise LiveKit holds a ghost screen-share publication
      // pointing at a stopped MediaStreamTrack for the rest of the session).
      if (videoPublished) {
        await lp.unpublishTrack(videoTrack, false).catch(() => undefined);
      }
      // Stop everything we acquired so the browser's picker dialog releases
      // the source (do this after unpublish while the tracks are still alive).
      stream.getTracks().forEach((t) => t.stop());
      throw e;
    }
    this.#bypassVideoTrack = videoTrack;
    this.#bypassAudioTrack = audioTrack;
    // Browser-side "Stop sharing" bar — Chrome ends the track without telling
    // LiveKit. Translate that into our normal stop path.
    videoTrack.addEventListener('ended', () => {
      if (this.#bypassVideoTrack === videoTrack) void this.setScreenShare(false);
    });
  }

  /** Counterpart to `#publishBypassStream` — unpublish from LiveKit and stop
   *  the underlying MediaStreamTracks. Safe to call when no bypass is active
   *  (no-op). */
  async #unpublishBypass(lp: LocalParticipant): Promise<void> {
    const v = this.#bypassVideoTrack;
    const a = this.#bypassAudioTrack;
    this.#bypassVideoTrack = null;
    this.#bypassAudioTrack = null;
    if (v) {
      try {
        await lp.unpublishTrack(v, true);
      } catch {
        // LiveKit may have already lost the publication (room disconnect race) —
        // we still need to stop the raw track below.
      }
      // unpublishTrack(stopOnUnpublish=true) stops the wrapped track, but our
      // raw MediaStreamTrack reference is what we own — stop it explicitly so
      // the browser's "you are sharing" indicator goes away.
      if (v.readyState !== 'ended') v.stop();
    }
    if (a) {
      try {
        await lp.unpublishTrack(a, true);
      } catch {
        // Same as video — best-effort.
      }
      if (a.readyState !== 'ended') a.stop();
    }
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

  /** Live-toggle the playback peak limiter on all subscribed tracks.
   *  Persisting happens in `settings.setLimiterEnabled` — call both. */
  setLimiterEnabled(on: boolean): void {
    this.#audioEls.setLimiterEnabled(on);
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
      toast.error(m.livekit_audio_path_update_failed(), {
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
    // Every handler bails when `room` is no longer the active one: a
    // superseded connect() can leave an orphan Room whose late events would
    // otherwise tear down (`#teardown`) or corrupt (`#audioEls` etc.) the
    // live room's state. `_active` is the single guard for that.
    const _active = (): boolean => this.#room === room;
    room
      .on(RoomEvent.ConnectionStateChanged, (s: ConnectionState) => {
        if (!_active()) return;
        this.state = s;
        voiceState.connected = s === ConnectionState.Connected;
        if (s === ConnectionState.Disconnected) this.#teardown();
      })
      .on(RoomEvent.Disconnected, () => {
        if (!_active()) return;
        this.#teardown();
      })
      .on(RoomEvent.ParticipantConnected, () => _active() && this.#scheduleRefresh())
      .on(RoomEvent.ParticipantDisconnected, () => _active() && this.#scheduleRefresh())
      .on(RoomEvent.ActiveSpeakersChanged, () => _active() && this.#scheduleRefresh())
      .on(RoomEvent.TrackMuted, (pub, p) => {
        if (!_active()) return;
        // setCameraEnabled(false) mutes the published track instead of
        // unpublishing it — the track stays subscribed forever otherwise. Pull
        // the muted cam out of the visible-cameras list so we don't render a
        // ghost tile with no video flowing.
        if (
          pub.source === Track.Source.Camera &&
          pub.kind === Track.Kind.Video &&
          p instanceof RemoteParticipant
        ) {
          const sid = pub.trackSid ?? pub.track?.sid;
          if (sid) this.#cameras.remove(sid);
        }
        this.#scheduleRefresh();
      })
      .on(RoomEvent.TrackUnmuted, (pub, p) => {
        if (!_active()) return;
        if (
          pub.source === Track.Source.Camera &&
          pub.kind === Track.Kind.Video &&
          p instanceof RemoteParticipant &&
          pub.track
        ) {
          this.#cameras.add(pub.track as RemoteVideoTrack, p);
        }
        this.#scheduleRefresh();
      })
      .on(RoomEvent.LocalTrackPublished, (pub) => {
        if (!_active()) return;
        if (pub.source === Track.Source.Microphone) {
          // applyNoiseFilter() is called by setMicEnabled() after
          // setMicrophoneEnabled() resolves, which is what triggers this event.
          // Calling it again here would race with that ongoing await, installing
          // two processors and orphaning the first (leaked AudioContext + WASM).
          // #attachLocalAnalyser() is also covered by setMicEnabled → applyNoiseFilter.
          this.#attachLocalAnalyser();
        }
        if (pub.source === Track.Source.Camera && pub.track) {
          this.localCameraTrack = pub.track as LocalVideoTrack;
        }
        this.#scheduleRefresh();
      })
      .on(RoomEvent.LocalTrackUnpublished, (pub) => {
        if (!_active()) return;
        if (pub.source === Track.Source.ScreenShare) {
          this.isScreenSharing = false;
        }
        if (pub.source === Track.Source.Camera) {
          this.isCameraOn = false;
          this.localCameraTrack = null;
        }
        if (pub.source === Track.Source.Microphone) {
          this.#sendProcessorMode = 'off';
          this.#noiseGateSetter = null;
          this.#makeupSetter = null;
          this.#localMic.detach();
          this.#resetSendLevel();
        }
        this.#scheduleRefresh();
      })
      .on(RoomEvent.ConnectionQualityChanged, () => _active() && this.#scheduleRefresh())
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) => {
        if (!_active()) return;
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
            // Parallel speaking-detector tap on the same raw track — independent
            // of LiveKit's server-side active-speaker decision.
            const ms = (track as RemoteAudioTrack).mediaStreamTrack;
            if (ms) this.#remoteSpeaking.attach(p.identity, ms);
          }
        } else if (track.kind === Track.Kind.Video && pub.source === Track.Source.ScreenShare) {
          this.#screenShare.addVideo(track as RemoteVideoTrack, p);
        } else if (track.kind === Track.Kind.Video && pub.source === Track.Source.Camera) {
          // A subscribed camera track can still be muted (publisher turned cam
          // off after a previous on — LiveKit keeps the publication, just mutes
          // it). Wait for TrackUnmuted before showing a tile, otherwise we'd
          // render an empty video element.
          if (!(track as RemoteVideoTrack).isMuted) {
            this.#cameras.add(track as RemoteVideoTrack, p);
          }
        }
        this.#scheduleRefresh();
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _pub, p: RemoteParticipant) => {
        if (!_active()) return;
        if (track.source === Track.Source.ScreenShareAudio) {
          this.#screenShare.removeAudio(track as RemoteAudioTrack);
        } else if (track.kind === Track.Kind.Audio) {
          this.#audioEls.detach(track.sid ?? '');
          this.#remoteSpeaking.detach(p.identity);
        }
        if (track.kind === Track.Kind.Video && track.source === Track.Source.ScreenShare) {
          this.#screenShare.removeVideo(track.sid ?? '');
        }
        if (track.kind === Track.Kind.Video && track.source === Track.Source.Camera) {
          this.#cameras.remove(track.sid ?? '');
        }
        this.#scheduleRefresh();
      })
      .on(RoomEvent.MediaDevicesChanged, () => {
        if (!_active()) return;
        void this.#devices.refresh(this.#room);
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => {
        if (!_active()) return;
        this.audioBlocked = !this.#room?.canPlaybackAudio;
      });
  }

  /** Debounced wrapper: coalesces rapid bursts of LiveKit events into a single
   *  rebuild. Multiple calls before the microtask drains resolve to one
   *  `#refreshParticipants` invocation. */
  #scheduleRefresh(): void {
    if (this.#refreshScheduled) return;
    this.#refreshScheduled = true;
    queueMicrotask(() => {
      this.#refreshScheduled = false;
      this.#refreshParticipants();
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
      // Both sides RMS-driven — LiveKit's server active-speaker detection is
      // unreliable with AGC off (the default here, RNNoise replaces it).
      // Local: LocalMicAnalyser (raw) when no processor, else the
      // post-processor tap. Remote: AnalyserNode on the subscribed track.
      isSpeaking: isLocal ? this.localSpeaking : this.#remoteSpeaking.isSpeaking(p.identity),
      audioLevel: p.audioLevel ?? 0,
      micMuted: !p.isMicrophoneEnabled,
      cameraOn: p.isCameraEnabled,
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
    // No-op: audioLevel is updated by #refreshParticipants() which is already
    // triggered by ActiveSpeakersChanged. isSpeaking is updated in real time
    // via #onRemoteSpeakingChange / #setLocalSpeaking. A separate poll at 200 ms
    // was redundant and allocated a new array on every tick with N participants.
  }

  #stopLevelPolling(): void {
    // No interval to clear — polling was removed (finding 115).
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
    // Speaking ring tracks the post-processor signal — i.e. exactly what
    // other listeners receive. Above the gate's open-threshold (default
    // -45 dBFS at the gain node's input ⇒ louder at the tap after makeup)
    // means audio is genuinely flowing.
    this.#sendSpeakingDetector.feed(rms);
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
    // Send-tap stops feeding the detector when the processor goes away or the
    // mic gets disabled — without an explicit reset the detector would latch
    // on whatever state it had at the moment the feed stopped.
    this.#sendSpeakingDetector.reset();
  }

  #onRemoteSpeakingChange(identity: string, speaking: boolean): void {
    const idx = this.participants.findIndex((p) => p.identity === identity);
    if (idx < 0 || this.participants[idx].isSpeaking === speaking) return;
    // Svelte 5 $state deep-proxies the array; mutating the element in place is
    // reactive and avoids allocating a new array + object on every speaking transition.
    this.participants[idx].isSpeaking = speaking;
  }

  #setLocalSpeaking(s: boolean): void {
    if (this.localSpeaking === s) return;
    this.localSpeaking = s;
    const idx = this.participants.findIndex((p) => p.isLocal);
    if (idx >= 0 && this.participants[idx].isSpeaking !== s) {
      // Same deep-proxy mutation — no full array copy needed.
      this.participants[idx].isSpeaking = s;
    }
  }

  #teardown(): void {
    if (this.#teardownDone) return;
    this.#teardownDone = true;
    this.#stopLevelPolling();
    this.#localMic.detach();
    this.#resetSendLevel();
    this.#sendSpeakingDetector.reset();
    this.#remoteSpeaking.clear();
    this.#audioEls.clear();
    clearVoiceMediaSession();
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
    this.isCameraOn = false;
    this.localCameraTrack = null;
    this.cameraFacing = 'user';
    this.#cameras.clear();
    // Win11 bypass path: stop raw MediaStreamTracks ourselves — the LiveKit
    // room is gone so unpublishTrack would no-op, but the OS-level "you are
    // sharing" indicator only goes away when the tracks actually .stop().
    if (this.#bypassVideoTrack && this.#bypassVideoTrack.readyState !== 'ended') {
      this.#bypassVideoTrack.stop();
    }
    if (this.#bypassAudioTrack && this.#bypassAudioTrack.readyState !== 'ended') {
      this.#bypassAudioTrack.stop();
    }
    this.#bypassVideoTrack = null;
    this.#bypassAudioTrack = null;
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

  /** Re-emit the local mute/deafen state. Called after a WS reconnect — the
   * gateway clears ``voice:user_state:<uid>`` when our last socket goes away
   * (token-expiry close + reconnect race), so without this our mute/deafen
   * icons disappear for every other client until we toggle again. */
  resyncSelfState(): void {
    this.#publishSelfState();
  }
}

export const voice = new VoiceRoom();
