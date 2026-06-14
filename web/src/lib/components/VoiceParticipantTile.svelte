<script lang="ts">
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import MicOffIcon from '@lucide/svelte/icons/mic-off';
  import HeadphoneOffIcon from '@lucide/svelte/icons/headphone-off';
  import type { VoiceParticipant } from '$lib/voice/livekit.svelte';
  import { settings } from '$lib/stores/settings.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { safeAvatarUrl } from '$lib/avatar';
  import { nameColor, nameStyle, idealTextColor } from '$lib/utils/nameColor';
  import { streamPresence } from '$lib/stores/streamPresence.svelte';
  import { voicePresence } from '$lib/stores/voicePresence.svelte';
  import { watchPartyPresence } from '$lib/stores/watchPartyPresence.svelte';
  import { voice } from '$lib/voice/livekit.svelte';
  import { openedTiles } from '$lib/stream/openedTiles.svelte';
  import { detachedStreams } from '$lib/stream/detach.svelte';
  import { watchPartyPicker, openPartyTile } from '$lib/watch/openParty.svelte';
  import UserProfilePopover from './UserProfilePopover.svelte';
  import VoiceUserVolumeControl from './VoiceUserVolumeControl.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let { p, channelId, guildId }: { p: VoiceParticipant; channelId: string; guildId: string } = $props();

  $effect(() => {
    if (p.userId) userCache.queue(p.userId);
  });

  let glow = $derived(p.isSpeaking ? Math.min(1, 0.35 + p.audioLevel * 2) : 0);
  let glowOpacity = $derived(glow > 0 ? 0.35 + glow * 0.5 : 0);
  // LiveKit setzt den Teilnehmer-Namen (``p.name``) — auf Self-Hosts fällt der
  // mangels Username auf die rohe ``user-<id>``-Identity zurück. Sobald der
  // userCache den Namen aufgelöst hat (via Self-Host /users, F19), den bevorzugen.
  let resolvedName = $derived(
    p.userId && userCache.get(p.userId) ? userCache.displayName(p.userId) : p.name
  );
  let initial = $derived((resolvedName.trim()[0] ?? '?').toUpperCase());
  let avatarSrc = $derived(p.userId ? safeAvatarUrl(userCache.get(p.userId)?.avatar_url) : null);
  // Same name colour as the member list: role colour → profile colour.
  let nameColour = $derived(p.userId ? nameColor(p.userId, guildId) : null);

  let volumePct = $derived(
    p.userId ? Math.round(settings.getUserVolume(p.userId) * 100) : 100
  );
  let canAdjustVolume = $derived(!p.isLocal && p.userId !== null);
  // Force-mute / force-deafen (server admin overrides MUTE_MEMBERS /
  // DEAFEN_MEMBERS). Treated as "mic muted" / "deafened" in the UI so the
  // icon shows even if LiveKit's reported ``micMuted`` is false (e.g. the
  // publish was killed entirely rather than soft-muted) and so deafen —
  // which LiveKit has no concept of — is visible at all.
  let serverOverride = $derived(
    p.userId ? voicePresence.overrideByChannel[channelId]?.[p.userId] : undefined
  );
  let isForceMuted = $derived(!!p.userId && !!serverOverride?.muted);
  let isForceDeafened = $derived(!!p.userId && !!serverOverride?.deafened);
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
    !!p.userId && watchPartyPresence.hostIdsIn(channelId).includes(p.userId)
  );
  // The LiveKit cam track for this participant, if subscribed + unmuted.
  let hasCam = $derived(voice.cameraTracks.some((c) => c.identity === p.identity));
  const BASE_RING = 'ring-2 ring-offset-2 ring-offset-background';
  let ringClass = $derived(
    isLive
      ? `${BASE_RING} ring-red-500`
      : isPartyHost
        ? `${BASE_RING} ring-primary`
        : hasCam
          ? `${BASE_RING} ring-blue-500`
          : ''
  );

  function badgeKeydown(fn: () => void) {
    return (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      fn();
    };
  }

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
    // One party → open directly; several → chooser dialog (openParty helper).
    if (!p.userId) return;
    watchPartyPicker.choose(
      watchPartyPresence.partiesHostedBy(channelId, p.userId).map((party) => ({
        id: party.party_id,
        party,
        open: () => openPartyTile(channelId, party)
      })),
      m.watch_party_picker_title()
    );
  }

  function openCam(): void {
    openedTiles.open('cam', channelId, p.identity);
  }
</script>

{#if p.userId}
<UserProfilePopover
  userId={p.userId}
  displayName={resolvedName}
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
          <!-- Activity glows — always mounted, fade in/out. -->
          <div
            class="pointer-events-none absolute -inset-2 rounded-full bg-red-500/50 blur-[8px] transition-opacity duration-500"
            style={`opacity: ${isLive ? 1 : 0};`}
            aria-hidden="true"
          ></div>
          <div
            class="pointer-events-none absolute -inset-2 rounded-full bg-primary/50 blur-[8px] transition-opacity duration-500"
            style={`opacity: ${isPartyHost ? 1 : 0};`}
            aria-hidden="true"
          ></div>
          <div
            class="pointer-events-none absolute -inset-2 rounded-full bg-blue-500/50 blur-[8px] transition-opacity duration-500"
            style={`opacity: ${hasCam ? 1 : 0};`}
            aria-hidden="true"
          ></div>
          {#if p.isSpeaking}
            <!-- Two staggered rings build the sonar "ping" — identical
                 animation to the sidebar voice-channel members list. -->
            <span
              class="pointer-events-none absolute inset-0 rounded-full border-2 border-primary animate-speaking-ping"
              style={nameColour ? `border-color: ${nameColour}` : ''}
              aria-hidden="true"
              data-testid="voice-participant-speaking-ring"
            ></span>
            <span
              class="pointer-events-none absolute inset-0 rounded-full border-2 border-primary animate-speaking-ping [animation-delay:0.7s]"
              style={nameColour ? `border-color: ${nameColour}` : ''}
              aria-hidden="true"
            ></span>
          {/if}
          <Avatar.Root class="relative size-20 {ringClass}">
            {#if avatarSrc}
              <Avatar.Image src={avatarSrc} alt={resolvedName} />
            {/if}
            <Avatar.Fallback
              class="accent-gradient text-primary-foreground text-xl font-semibold"
              style={nameColour ? `background: ${nameColour}; color: ${idealTextColor(nameColour)}` : ''}
            >
              {initial}
            </Avatar.Fallback>
          </Avatar.Root>
          {#if isLive || isPartyHost || hasCam}
            <div class="absolute -bottom-2 left-1/2 z-10 flex -translate-x-1/2 flex-col items-center gap-1">
              {#if isLive}
                <span
                  role="button"
                  tabindex="0"
                  class="cursor-pointer rounded-md bg-red-600 px-3 py-1.5 text-sm font-bold leading-none text-white shadow-sm hover:bg-red-500 active:scale-95"
                  data-testid="voice-participant-live-badge"
                  title={isHqStreaming && isScreenSharing
                    ? m.voice_participant_tile_open_hq_and_screen()
                    : isHqStreaming
                      ? m.voice_participant_tile_open_hq_stream()
                      : m.voice_participant_tile_open_screen()}
                  aria-label={m.voice_participant_tile_open_stream_aria({ name: resolvedName })}
                  onclick={(e) => { e.stopPropagation(); openLive(); }}
                  onkeydown={badgeKeydown(openLive)}
                >LIVE</span>
              {/if}
              {#if isPartyHost}
                <span
                  role="button"
                  tabindex="0"
                  class="cursor-pointer rounded-md bg-primary px-3 py-1.5 text-sm font-bold leading-none text-primary-foreground shadow-sm hover:bg-primary/90 active:scale-95"
                  data-testid="voice-participant-party-badge"
                  title={m.voice_participant_tile_open_watch_party()}
                  aria-label={m.voice_participant_tile_open_watch_party_aria({ name: resolvedName })}
                  onclick={(e) => { e.stopPropagation(); openParty(); }}
                  onkeydown={badgeKeydown(openParty)}
                >PARTY</span>
              {/if}
              {#if hasCam}
                <span
                  role="button"
                  tabindex="0"
                  class="cursor-pointer rounded-md bg-blue-600 px-3 py-1.5 text-sm font-bold leading-none text-white shadow-sm hover:bg-blue-500 active:scale-95"
                  data-testid="voice-participant-cam-badge"
                  title={m.voice_participant_tile_open_webcam()}
                  aria-label={m.voice_participant_tile_open_webcam_aria({ name: resolvedName })}
                  onclick={(e) => { e.stopPropagation(); openCam(); }}
                  onkeydown={badgeKeydown(openCam)}
                >CAM</span>
              {/if}
            </div>
          {/if}
        </div>
        <div class="flex items-center gap-1 text-sm md:text-xs">
          <span
            class="text-text-bright max-w-28 truncate transition-[font-weight] duration-200 ease-out {p.isSpeaking
              ? 'font-bold'
              : 'font-semibold'}"
            style={p.userId ? nameStyle(p.userId, guildId) : ''}
            title={resolvedName}
          >
            {resolvedName}{p.isLocal ? m.voice_participant_tile_local_suffix() : ''}
          </span>
          {#if showMicOff}
            <MicOffIcon
              class="size-3 text-red-400"
              aria-label={isForceMuted ? m.voice_participant_tile_force_muted() : m.voice_participant_tile_mic_muted()}
              data-testid={isForceMuted ? 'voice-participant-force-muted' : 'voice-participant-mic-muted'}
            />
          {/if}
          {#if showDeafened}
            <HeadphoneOffIcon
              class="size-3 text-red-400"
              aria-label={isForceDeafened ? m.voice_participant_tile_force_deafened() : m.voice_participant_tile_deafened()}
              data-testid={isForceDeafened ? 'voice-participant-force-deafened' : 'voice-participant-deafened'}
            />
          {/if}
          {#if canAdjustVolume && volumePct !== 100}
            <span
              class="text-text-muted ml-1 font-mono text-[10px]"
              title={m.voice_participant_tile_volume_title()}
              data-testid="voice-participant-volume-badge"
            >
              {volumePct}%
            </span>
          {/if}
        </div>
      </button>
    {/snippet}
  {#snippet extra()}
    {#if canAdjustVolume && p.userId}
      <VoiceUserVolumeControl userId={p.userId} name={resolvedName} />
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
          <Avatar.Image src={avatarSrc} alt={resolvedName} />
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
        title={resolvedName}
      >
        {resolvedName}{p.isLocal ? m.voice_participant_tile_local_suffix() : ''}
      </span>
      {#if showMicOff}
        <MicOffIcon
          class="size-3 text-red-400"
          aria-label={isForceMuted ? m.voice_participant_tile_force_muted() : m.voice_participant_tile_mic_muted()}
        />
      {/if}
      {#if showDeafened}
        <HeadphoneOffIcon
          class="size-3 text-red-400"
          aria-label={isForceDeafened ? m.voice_participant_tile_force_deafened() : m.voice_participant_tile_deafened()}
        />
      {/if}
    </div>
  </button>
{/if}
