<script lang="ts">
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import { userCache } from '$lib/stores/users.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { settings } from '$lib/stores/settings.svelte';
  import { voicePresence } from '$lib/stores/voicePresence.svelte';
  import { safeAvatarUrl } from '$lib/avatar';
  import { nameColor, nameStyle, idealTextColor } from '$lib/utils/nameColor';
  import VoiceMuteIcon from './VoiceMuteIcon.svelte';
  import type { UserVoiceState } from '$lib/stores/voicePresence.svelte';
  import UserProfilePopover from './UserProfilePopover.svelte';
  import { startUserDrag } from '$lib/voice/userDrag';
  import VoiceUserVolumeControl from './VoiceUserVolumeControl.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let {
    userIds,
    channelId,
    guildId,
    streamingUserIds = [],
    camUserIds = [],
    speakingUserIds = [],
    watchPartyHostUserIds = [],
    userStates = {},
    onLiveOpen,
    onPartyOpen,
    onCamOpen
  }: {
    userIds: string[];
    /** Voice channel the listed users belong to. Required for force-mute
     *  lookups + threading into the popover's guild-scoped actions. */
    channelId: string;
    /** Guild the channel belongs to. Threaded into UserProfilePopover so
     *  guild actions (nickname / kick / mute) show up on left-click. */
    guildId: string;
    /** Users with HQ-stream or screen-share active (server-tracked). */
    streamingUserIds?: string[];
    /** Users with cam active. Only populated for the channel the local user
     *  is connected to (LiveKit track info is client-only). */
    camUserIds?: string[];
    /** Subset of userIds currently emitting audio above the speaking
     * threshold. Only the channel the local user is connected to has live
     * data; everything else is an empty list and renders no rings. */
    speakingUserIds?: string[];
    /** Users hosting an active watch party in this channel (several parties may
     *  run at once). A user gets a PARTY badge if they're in this list. */
    watchPartyHostUserIds?: string[];
    /** Per-user self-reported mute/deafen flags. Missing entries == default off. */
    userStates?: Record<string, UserVoiceState>;
    /** Click on a user's LIVE badge (HQ + screen-share union). Caller resolves
     *  which kinds are active and opens the matching tiles. */
    onLiveOpen?: (userId: string) => void;
    /** Click on a user's PARTY badge — caller opens the party/parties that
     *  this user hosts in the channel. */
    onPartyOpen?: (userId: string) => void;
    /** Click on a user's CAM badge. Caller maps userId → LiveKit identity. */
    onCamOpen?: (userId: string) => void;
  } = $props();

  const streamingSet = $derived(new Set(streamingUserIds));
  const camSet = $derived(new Set(camUserIds));
  const speakingSet = $derived(new Set(speakingUserIds));
  const partyHostSet = $derived(new Set(watchPartyHostUserIds));
  const selfId = $derived(currentServerUserId());

  $effect(() => {
    for (const id of userIds) userCache.queue(id);
  });
</script>

{#each userIds as uid (uid)}
  {@const user = userCache.get(uid)}
  {@const name = user?.display_name ?? user?.username ?? '…'}
  {@const initial = (name.trim()[0] ?? '?').toUpperCase()}
  {@const isSelf = uid === selfId}
  {@const isSpeaking = speakingSet.has(uid)}
  {@const volumePct = Math.round(settings.getUserVolume(uid) * 100)}
  {@const avatarSrc = safeAvatarUrl(user?.avatar_url)}
  {@const state = userStates[uid]}
  {@const isForceMuted = voicePresence.isForceMuted(channelId, uid)}
  {@const isForceDeafened = voicePresence.isForceDeafened(channelId, uid)}
  {@const isMicMuted = state?.mic_muted === true || isForceMuted}
  {@const isDeafened = state?.deafened === true || isForceDeafened}
  {@const colour = nameColor(uid, guildId)}
  <UserProfilePopover
    userId={uid}
    displayName={name}
    avatarUrl={avatarSrc}
    {guildId}
  >
    {#snippet children({ props })}
        <button
          {...props}
          type="button"
          class="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm text-text-muted hover:bg-bg-hover hover:text-text-base data-[state=open]:bg-bg-hover"
          data-testid="voice-presence-member"
          data-user-id={uid}
          title={name}
          draggable={true}
          ondragstart={(e) => startUserDrag(e, uid)}
        >
          <span class="relative size-7 shrink-0" data-speaking={isSpeaking}>
            {#if isSpeaking}
              <!-- Two staggered rings build the sonar "ping" — mirrors the logo. -->
              <span
                class="pointer-events-none absolute inset-0 rounded-full border-2 border-primary animate-speaking-ping"
                style={settings.appearance.speakingRingNameColor && colour
                  ? `border-color: ${colour}`
                  : ''}
                aria-hidden="true"
                data-testid="voice-presence-speaking-ring"
              ></span>
              <span
                class="pointer-events-none absolute inset-0 rounded-full border-2 border-primary animate-speaking-ping [animation-delay:0.7s]"
                style={settings.appearance.speakingRingNameColor && colour
                  ? `border-color: ${colour}`
                  : ''}
                aria-hidden="true"
              ></span>
            {/if}
            <Avatar.Root class="relative size-7">
              {#if avatarSrc}
                <Avatar.Image src={avatarSrc} alt={name} />
              {/if}
              <Avatar.Fallback
                class="bg-primary text-primary-foreground text-2xs"
                style={colour ? `background: ${colour}; color: ${idealTextColor(colour)}` : ''}
              >
                {initial}
              </Avatar.Fallback>
            </Avatar.Root>
          </span>
          <span
            class="truncate transition-[color,font-weight] duration-200 ease-out {isSpeaking
              ? 'font-semibold text-text-bright'
              : ''}"
            style={nameStyle(uid, guildId)}
          >{name}</span>
          {#if !isSelf && volumePct !== 100}
            <span
              class="text-text-muted ml-1 shrink-0 font-mono text-2xs"
              data-testid="voice-presence-volume-badge"
            >{volumePct}%</span>
          {/if}
          <span class="ml-auto flex shrink-0 items-center gap-1">
            {#if isMicMuted}
              <VoiceMuteIcon
                kind="mic"
                forced={isForceMuted}
                size="size-3.5"
                label={isForceMuted ? m.voice_channel_members_force_muted() : m.voice_channel_members_mic_muted()}
                testid={isForceMuted ? 'voice-presence-force-muted' : 'voice-presence-mic-muted'}
              />
            {/if}
            {#if isDeafened}
              <VoiceMuteIcon
                kind="headphone"
                forced={isForceDeafened}
                size="size-3.5"
                label={isForceDeafened ? m.voice_channel_members_force_deafened() : m.voice_channel_members_deafened()}
                testid={isForceDeafened ? 'voice-presence-force-deafened' : 'voice-presence-deafened'}
              />
            {/if}
            <!-- Alle drei Badges (PARTY/LIVE/CAM) sind weiche Pillen mit Rand
                 und Punkt, Stil der Freundesliste (FriendList.svelte): solide
                 Füllungen bleiben dem Video-Tile vorbehalten, wo sie gegen das
                 Bild halten müssen. items-center zentriert Schrift + Punkt. -->
            {#if partyHostSet.has(uid)}
              {#if onPartyOpen}
                <span
                  role="button"
                  tabindex="0"
                  class="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-2xs font-bold uppercase text-amber-400 hover:bg-amber-500/20"
                  data-testid="user-watch-party-badge"
                  title={m.voice_channel_members_watch_party_open()}
                  aria-label={m.voice_channel_members_watch_party_open_label({ name })}
                  onclick={(e) => { e.stopPropagation(); onPartyOpen(uid); }}
                  onkeydown={(e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
                    e.stopPropagation();
                    onPartyOpen(uid);
                  }}
                ><span class="size-1.5 rounded-full bg-amber-400"></span>PARTY</span>
              {:else}
                <span
                  class="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-2xs font-bold uppercase text-amber-400"
                  data-testid="user-watch-party-badge"
                  title={m.voice_channel_members_watch_party_hosting()}
                ><span class="size-1.5 rounded-full bg-amber-400"></span>PARTY</span>
              {/if}
            {/if}
            {#if streamingSet.has(uid)}
              {#if onLiveOpen}
                <!-- role=button (not <button>) — `<button>` inside the outer
                     context-menu trigger button would be invalid HTML. -->
                <span
                  role="button"
                  tabindex="0"
                  class="inline-flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-2xs font-bold uppercase text-red-400 hover:bg-red-500/20"
                  data-testid="user-streaming-badge"
                  title={m.voice_channel_members_stream_open()}
                  aria-label={m.voice_channel_members_stream_open_label({ name })}
                  onclick={(e) => { e.stopPropagation(); onLiveOpen(uid); }}
                  onkeydown={(e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
                    e.stopPropagation();
                    onLiveOpen(uid);
                  }}
                ><span class="size-1.5 rounded-full bg-red-400"></span>LIVE</span>
              {:else}
                <span
                  class="inline-flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-2xs font-bold uppercase text-red-400"
                  data-testid="user-streaming-badge"
                  title={m.voice_channel_members_stream_sharing_screen()}
                ><span class="size-1.5 rounded-full bg-red-400"></span>LIVE</span>
              {/if}
            {/if}
            {#if camSet.has(uid) && onCamOpen}
              <span
                role="button"
                tabindex="0"
                class="inline-flex items-center gap-1 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 text-2xs font-bold uppercase text-cyan-400 hover:bg-cyan-500/20"
                data-testid="user-cam-badge"
                title={m.voice_channel_members_cam_open()}
                aria-label={m.voice_channel_members_cam_open_label({ name })}
                onclick={(e) => { e.stopPropagation(); onCamOpen(uid); }}
                onkeydown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return;
                  e.preventDefault();
                  e.stopPropagation();
                  onCamOpen(uid);
                }}
              ><span class="size-1.5 rounded-full bg-cyan-400"></span>CAM</span>
            {/if}
          </span>
        </button>
      {/snippet}
    {#snippet extra()}
      {#if !isSelf}
        <VoiceUserVolumeControl userId={uid} {name} />
      {/if}
    {/snippet}
  </UserProfilePopover>
{/each}
