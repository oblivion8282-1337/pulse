<script lang="ts">
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import * as ContextMenu from '$lib/components/ui/context-menu/index.js';
  import { userCache } from '$lib/stores/users.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { settings } from '$lib/stores/settings.svelte';
  import { safeAvatarUrl } from '$lib/avatar';
  import UserVolumeMenu from './UserVolumeMenu.svelte';

  let {
    userIds,
    streamingUserIds = [],
    speakingUserIds = []
  }: {
    userIds: string[];
    streamingUserIds?: string[];
    /** Subset of userIds currently emitting audio above the speaking
     * threshold. Only the channel the local user is connected to has live
     * data; everything else is an empty list and renders no rings. */
    speakingUserIds?: string[];
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
  <ContextMenu.Root>
    <ContextMenu.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm text-text-muted hover:bg-bg-hover hover:text-text-base"
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
          <span class="truncate {isSpeaking ? 'font-semibold text-text-bright' : ''}">{name}</span>
          {#if !isSelf && volumePct !== 100}
            <span
              class="text-text-muted ml-1 shrink-0 font-mono text-[10px]"
              data-testid="voice-presence-volume-badge"
            >{volumePct}%</span>
          {/if}
          {#if streamingSet.has(uid)}
            <span
              class="ml-auto shrink-0 rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white"
              data-testid="user-streaming-badge"
              title="teilt seinen Bildschirm"
            >LIVE</span>
          {/if}
        </button>
      {/snippet}
    </ContextMenu.Trigger>
    {#if !isSelf}
      <UserVolumeMenu userId={uid} {name} />
    {/if}
  </ContextMenu.Root>
{/each}
