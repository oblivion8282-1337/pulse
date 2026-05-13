<script lang="ts">
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import * as ContextMenu from '$lib/components/ui/context-menu/index.js';
  import { userCache } from '$lib/stores/users.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { settings } from '$lib/stores/settings.svelte';
  import { safeAvatarUrl } from '$lib/avatar';
  import UserVolumeMenu from './UserVolumeMenu.svelte';

  let { userIds, streamingUserIds = [] }: { userIds: string[]; streamingUserIds?: string[] } = $props();

  const streamingSet = $derived(new Set(streamingUserIds));
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
          <Avatar.Root class="size-7 shrink-0">
            {#if avatarSrc}
              <Avatar.Image src={avatarSrc} alt={name} />
            {/if}
            <Avatar.Fallback class="bg-primary text-primary-foreground text-[11px]">
              {initial}
            </Avatar.Fallback>
          </Avatar.Root>
          <span class="truncate">{name}</span>
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
