<script lang="ts">
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import { userCache } from '$lib/stores/users.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { settings } from '$lib/stores/settings.svelte';
  import { safeAvatarUrl } from '$lib/avatar';
  import MicOffIcon from '@lucide/svelte/icons/mic-off';
  import HeadphoneOffIcon from '@lucide/svelte/icons/headphone-off';
  import type { UserVoiceState } from '$lib/stores/voicePresence.svelte';
  import UserProfilePopover from './UserProfilePopover.svelte';
  import VoiceUserVolumeControl from './VoiceUserVolumeControl.svelte';

  let {
    userIds,
    streamingUserIds = [],
    speakingUserIds = [],
    watchPartyHostUserId = null,
    userStates = {},
    onStreamClick
  }: {
    userIds: string[];
    streamingUserIds?: string[];
    /** Subset of userIds currently emitting audio above the speaking
     * threshold. Only the channel the local user is connected to has live
     * data; everything else is an empty list and renders no rings. */
    speakingUserIds?: string[];
    /** The user hosting an active watch party in this channel (or null). */
    watchPartyHostUserId?: string | null;
    /** Per-user self-reported mute/deafen flags. Missing entries == default off. */
    userStates?: Record<string, UserVoiceState>;
    /** Click handler for the LIVE / PARTY badge — opens the relevant stream
     *  view in the channel. Without it both badges stay passive labels. */
    onStreamClick?: (userId: string) => void;
  } = $props();

  const streamingSet = $derived(new Set(streamingUserIds));
  const speakingSet = $derived(new Set(speakingUserIds));
  const selfId = $derived(auth.user?.id ?? null);

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
  {@const isMicMuted = state?.mic_muted === true}
  {@const isDeafened = state?.deafened === true}
  <UserProfilePopover
    userId={uid}
    displayName={name}
    avatarUrl={avatarSrc}
  >
    {#snippet children({ props })}
        <button
          {...props}
          type="button"
          class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm text-text-muted hover:bg-bg-hover hover:text-text-base data-[state=open]:bg-bg-hover"
          data-testid="voice-presence-member"
          data-user-id={uid}
          title={name}
        >
          <span class="relative size-7 shrink-0" data-speaking={isSpeaking}>
            {#if isSpeaking}
              <!-- Two staggered rings build the sonar "ping" — mirrors the logo. -->
              <span
                class="pointer-events-none absolute inset-0 rounded-full border-2 border-primary animate-speaking-ping"
                aria-hidden="true"
                data-testid="voice-presence-speaking-ring"
              ></span>
              <span
                class="pointer-events-none absolute inset-0 rounded-full border-2 border-primary animate-speaking-ping [animation-delay:0.7s]"
                aria-hidden="true"
              ></span>
            {/if}
            <Avatar.Root class="relative size-7">
              {#if avatarSrc}
                <Avatar.Image src={avatarSrc} alt={name} />
              {/if}
              <Avatar.Fallback class="bg-primary text-primary-foreground text-[11px]">
                {initial}
              </Avatar.Fallback>
            </Avatar.Root>
          </span>
          <span
            class="truncate transition-[color,font-weight] duration-200 ease-out {isSpeaking
              ? 'font-semibold text-text-bright'
              : ''}"
          >{name}</span>
          {#if !isSelf && volumePct !== 100}
            <span
              class="text-text-muted ml-1 shrink-0 font-mono text-[10px]"
              data-testid="voice-presence-volume-badge"
            >{volumePct}%</span>
          {/if}
          <span class="ml-auto flex shrink-0 items-center gap-1">
            {#if isMicMuted}
              <MicOffIcon
                class="size-3.5 text-red-400"
                aria-label="Mikrofon stumm"
                data-testid="voice-presence-mic-muted"
              />
            {/if}
            {#if isDeafened}
              <HeadphoneOffIcon
                class="size-3.5 text-red-400"
                aria-label="Stummschaltung"
                data-testid="voice-presence-deafened"
              />
            {/if}
            {#if watchPartyHostUserId === uid}
              {#if onStreamClick}
                <span
                  role="button"
                  tabindex="0"
                  class="rounded bg-primary px-1.5 py-0.5 text-[10px] font-bold leading-none text-primary-foreground hover:bg-primary/90"
                  data-testid="user-watch-party-badge"
                  title="Watch Party öffnen"
                  aria-label="{name}s Watch Party öffnen"
                  onclick={(e) => { e.stopPropagation(); onStreamClick(uid); }}
                  onkeydown={(e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
                    e.stopPropagation();
                    onStreamClick(uid);
                  }}
                >PARTY</span>
              {:else}
                <span
                  class="rounded bg-primary px-1.5 py-0.5 text-[10px] font-bold leading-none text-primary-foreground"
                  data-testid="user-watch-party-badge"
                  title="hostet eine Watch Party"
                >PARTY</span>
              {/if}
            {/if}
            {#if streamingSet.has(uid)}
              {#if onStreamClick}
                <!-- role=button (not <button>) — `<button>` inside the outer
                     context-menu trigger button would be invalid HTML. -->
                <span
                  role="button"
                  tabindex="0"
                  class="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white hover:bg-red-500"
                  data-testid="user-streaming-badge"
                  title="Stream öffnen"
                  aria-label="{name}s Stream öffnen"
                  onclick={(e) => { e.stopPropagation(); onStreamClick(uid); }}
                  onkeydown={(e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
                    e.stopPropagation();
                    onStreamClick(uid);
                  }}
                >LIVE</span>
              {:else}
                <span
                  class="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white"
                  data-testid="user-streaming-badge"
                  title="teilt seinen Bildschirm"
                >LIVE</span>
              {/if}
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
