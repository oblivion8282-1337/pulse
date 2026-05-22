<script lang="ts">
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import MicOffIcon from '@lucide/svelte/icons/mic-off';
  import HeadphoneOffIcon from '@lucide/svelte/icons/headphone-off';
  import type { VoiceParticipant } from '$lib/voice/livekit.svelte';
  import { settings } from '$lib/stores/settings.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { safeAvatarUrl } from '$lib/avatar';
  import { streamPresence } from '$lib/stores/streamPresence.svelte';
  import { voicePresence } from '$lib/stores/voicePresence.svelte';
  import { watchPartyPresence } from '$lib/stores/watchPartyPresence.svelte';
  import { voice } from '$lib/voice/livekit.svelte';
  import { openedTiles } from '$lib/stream/openedTiles.svelte';
  import { detachedStreams } from '$lib/stream/detach.svelte';
  import { detachedWatchParties } from '$lib/stream/watchPartyDetach.svelte';
  import UserProfilePopover from './UserProfilePopover.svelte';
  import VoiceUserVolumeControl from './VoiceUserVolumeControl.svelte';

  let { p, channelId, guildId }: { p: VoiceParticipant; channelId: string; guildId: string } = $props();

  $effect(() => {
    if (p.userId) userCache.queue(p.userId);
  });

  let glow = $derived(p.isSpeaking ? Math.min(1, 0.35 + p.audioLevel * 2) : 0);
  let glowOpacity = $derived(glow > 0 ? 0.35 + glow * 0.5 : 0);
  let initial = $derived((p.name.trim()[0] ?? '?').toUpperCase());
  let avatarSrc = $derived(p.userId ? safeAvatarUrl(userCache.get(p.userId)?.avatar_url) : null);

  let volumePct = $derived(
    p.userId ? Math.round(settings.getUserVolume(p.userId) * 100) : 100
  );
  let canAdjustVolume = $derived(!p.isLocal && p.userId !== null);
  // Force-mute / force-deafen (server admin overrides MUTE_MEMBERS /
  // DEAFEN_MEMBERS). Treated as "mic muted" / "deafened" in the UI so the
  // icon shows even if LiveKit's reported ``micMuted`` is false (e.g. the
  // publish was killed entirely rather than soft-muted) and so deafen —
  // which LiveKit has no concept of — is visible at all.
  let isForceMuted = $derived(
    !!p.userId && voicePresence.isForceMuted(channelId, p.userId)
  );
  let isForceDeafened = $derived(
    !!p.userId && voicePresence.isForceDeafened(channelId, p.userId)
  );
  // Remote deafen comes from the server's per-user voice state (gateway pushes
  // ``user_states`` in each ``voice_state`` snapshot). Local user pulls from
  // ``voice.deafened`` directly so the icon flips instantly on self-toggle
  // instead of waiting for the WS echo.
  let serverState = $derived(
    p.userId ? voicePresence.userStatesIn(channelId)[p.userId] : undefined
  );
  let showMicOff = $derived(p.micMuted || isForceMuted);
  let showDeafened = $derived(
    (p.isLocal ? voice.deafened : serverState?.deafened === true) || isForceDeafened
  );

  // Activity flags — drive the LIVE/PARTY/CAM badges. HQ + screen-share are
  // both server-tracked; cam is local-only (we only know about cameras whose
  // LiveKit track we've subscribed to in the connected channel).
  let isHqStreaming = $derived(
    !!p.userId && streamPresence.streamersIn(channelId).includes(p.userId)
  );
  let isScreenSharing = $derived(
    !!p.userId && voicePresence.streamingIn(channelId).includes(p.userId)
  );
  let isLive = $derived(isHqStreaming || isScreenSharing);
  let isPartyHost = $derived(
    !!p.userId && watchPartyPresence.partyIn(channelId)?.host_user_id === p.userId
  );
  // The LiveKit cam track for this participant, if subscribed + unmuted.
  let camTrack = $derived(voice.cameraTracks.find((c) => c.identity === p.identity));
  let hasCam = $derived(!!camTrack);

  function openLive(): void {
    // Open whichever live source(s) this user actually has. HQ takes the
    // user_id as key (snowflake), screen-share takes the LiveKit identity.
    if (isHqStreaming && p.userId) {
      if (detachedStreams.has(channelId, p.userId)) {
        detachedStreams.open(channelId, p.userId); // focuses popup
      } else {
        openedTiles.open('hq', channelId, p.userId);
      }
    }
    if (isScreenSharing) {
      openedTiles.open('screen', channelId, p.identity);
    }
  }

  function openParty(): void {
    if (detachedWatchParties.has(channelId)) {
      detachedWatchParties.open(channelId); // focuses popup
    } else {
      openedTiles.openParty(channelId);
    }
  }

  function openCam(): void {
    openedTiles.open('cam', channelId, p.identity);
  }
</script>

{#if p.userId}
<UserProfilePopover
  userId={p.userId}
  displayName={p.name}
  avatarUrl={avatarSrc}
  {guildId}
>
  {#snippet children({ props })}
      <button
        {...props}
        type="button"
        class="glass-panel flex flex-col items-center gap-3 rounded-2xl px-6 py-5 text-left transition-colors data-[state=open]:ring-2 data-[state=open]:ring-primary/50"
        data-testid="voice-participant"
        data-identity={p.identity}
      >
        <div class="relative">
          <!-- Glow stays mounted; opacity fades in/out so the speaker
               transition is smooth, not a hard pop. -->
          <div
            class="accent-gradient pointer-events-none absolute -inset-1.5 rounded-full blur-[3px] transition-opacity duration-300"
            style={`opacity: ${glowOpacity};`}
            aria-hidden="true"
          ></div>
          {#if p.isSpeaking}
            <!-- Two staggered rings build the sonar "ping" — identical
                 animation to the sidebar voice-channel members list. -->
            <span
              class="pointer-events-none absolute inset-0 rounded-full border-2 border-primary animate-speaking-ping"
              aria-hidden="true"
              data-testid="voice-participant-speaking-ring"
            ></span>
            <span
              class="pointer-events-none absolute inset-0 rounded-full border-2 border-primary animate-speaking-ping [animation-delay:0.7s]"
              aria-hidden="true"
            ></span>
          {/if}
          <Avatar.Root class="relative size-20 {isLive ? 'ring-2 ring-red-500 ring-offset-2 ring-offset-background' : ''}">
            {#if avatarSrc}
              <Avatar.Image src={avatarSrc} alt={p.name} />
            {/if}
            <Avatar.Fallback class="accent-gradient text-primary-foreground text-xl font-semibold">
              {initial}
            </Avatar.Fallback>
          </Avatar.Root>
          {#if isLive}
            <span
              role="button"
              tabindex="0"
              class="absolute -bottom-2 left-1/2 z-10 -translate-x-1/2 cursor-pointer rounded bg-red-600 px-1.5 py-0.5 text-[9px] font-bold leading-none text-white hover:bg-red-500"
              data-testid="voice-participant-live-badge"
              title={isHqStreaming && isScreenSharing
                ? 'HQ-Stream + Bildschirm öffnen'
                : isHqStreaming
                  ? 'HQ-Stream öffnen'
                  : 'Bildschirm öffnen'}
              aria-label="{p.name}s Stream öffnen"
              onclick={(e) => { e.stopPropagation(); openLive(); }}
              onkeydown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                e.stopPropagation();
                openLive();
              }}
            >LIVE</span>
          {/if}
        </div>
        <div class="flex items-center gap-1 text-sm md:text-xs">
          <span
            class="text-text-bright max-w-28 truncate transition-[font-weight] duration-200 ease-out {p.isSpeaking
              ? 'font-bold'
              : 'font-semibold'}"
            title={p.name}
          >
            {p.name}{p.isLocal ? ' (du)' : ''}
          </span>
          {#if showMicOff}
            <MicOffIcon
              class="size-3 text-red-400"
              aria-label={isForceMuted ? 'Vom Mod stummgeschaltet' : 'Mikrofon stumm'}
              data-testid={isForceMuted ? 'voice-participant-force-muted' : 'voice-participant-mic-muted'}
            />
          {/if}
          {#if showDeafened}
            <HeadphoneOffIcon
              class="size-3 text-red-400"
              aria-label={isForceDeafened ? 'Vom Mod taubgeschaltet' : 'Ton stummgeschaltet'}
              data-testid={isForceDeafened ? 'voice-participant-force-deafened' : 'voice-participant-deafened'}
            />
          {/if}
          {#if canAdjustVolume && volumePct !== 100}
            <span
              class="text-text-muted ml-1 font-mono text-[10px]"
              title="Eingestellte Lautstärke"
              data-testid="voice-participant-volume-badge"
            >
              {volumePct}%
            </span>
          {/if}
        </div>
        {#if isPartyHost || hasCam}
          <div class="flex flex-wrap items-center justify-center gap-1">
            {#if isPartyHost}
              <span
                role="button"
                tabindex="0"
                class="rounded bg-primary px-1.5 py-0.5 text-[10px] font-bold leading-none text-primary-foreground hover:bg-primary/90 cursor-pointer"
                data-testid="voice-participant-party-badge"
                title="Watch Party öffnen"
                aria-label="{p.name}s Watch Party öffnen"
                onclick={(e) => { e.stopPropagation(); openParty(); }}
                onkeydown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return;
                  e.preventDefault();
                  e.stopPropagation();
                  openParty();
                }}
              >PARTY</span>
            {/if}
            {#if hasCam}
              <span
                role="button"
                tabindex="0"
                class="rounded bg-primary/80 px-1.5 py-0.5 text-[10px] font-bold leading-none text-primary-foreground hover:bg-primary cursor-pointer"
                data-testid="voice-participant-cam-badge"
                title="Webcam öffnen"
                aria-label="{p.name}s Webcam öffnen"
                onclick={(e) => { e.stopPropagation(); openCam(); }}
                onkeydown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return;
                  e.preventDefault();
                  e.stopPropagation();
                  openCam();
                }}
              >CAM</span>
            {/if}
          </div>
        {/if}
      </button>
    {/snippet}
  {#snippet extra()}
    {#if canAdjustVolume && p.userId}
      <VoiceUserVolumeControl userId={p.userId} name={p.name} />
    {/if}
  {/snippet}
</UserProfilePopover>
{:else}
  <!-- Anonymous participants (no userId — pre-LiveKit-join race window):
       no popover, no DM, no volume, no activity badges (we can't tell who they are). -->
  <button
    type="button"
    class="glass-panel flex flex-col items-center gap-3 rounded-2xl px-6 py-5 text-left transition-colors"
    data-testid="voice-participant"
    data-identity={p.identity}
  >
    <div class="relative">
      <div
        class="accent-gradient pointer-events-none absolute -inset-1.5 rounded-full blur-[3px] transition-opacity duration-300"
        style={`opacity: ${glowOpacity};`}
        aria-hidden="true"
      ></div>
      {#if p.isSpeaking}
        <span
          class="pointer-events-none absolute inset-0 rounded-full border-2 border-primary animate-speaking-ping"
          aria-hidden="true"
        ></span>
        <span
          class="pointer-events-none absolute inset-0 rounded-full border-2 border-primary animate-speaking-ping [animation-delay:0.7s]"
          aria-hidden="true"
        ></span>
      {/if}
      <Avatar.Root class="relative size-20">
        {#if avatarSrc}
          <Avatar.Image src={avatarSrc} alt={p.name} />
        {/if}
        <Avatar.Fallback class="accent-gradient text-primary-foreground text-xl font-semibold">
          {initial}
        </Avatar.Fallback>
      </Avatar.Root>
    </div>
    <div class="flex items-center gap-1 text-sm md:text-xs">
      <span
        class="text-text-bright max-w-28 truncate transition-[font-weight] duration-200 ease-out {p.isSpeaking
          ? 'font-bold'
          : 'font-semibold'}"
        title={p.name}
      >
        {p.name}{p.isLocal ? ' (du)' : ''}
      </span>
      {#if showMicOff}
        <MicOffIcon
          class="size-3 text-red-400"
          aria-label={isForceMuted ? 'Vom Mod stummgeschaltet' : 'Mikrofon stumm'}
        />
      {/if}
      {#if showDeafened}
        <HeadphoneOffIcon
          class="size-3 text-red-400"
          aria-label={isForceDeafened ? 'Vom Mod taubgeschaltet' : 'Ton stummgeschaltet'}
        />
      {/if}
    </div>
  </button>
{/if}
