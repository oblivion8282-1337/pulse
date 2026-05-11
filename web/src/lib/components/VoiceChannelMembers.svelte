<script lang="ts">
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import { userCache } from '$lib/stores/users.svelte';

  let { userIds, streamingUserIds = [] }: { userIds: string[]; streamingUserIds?: string[] } = $props();

  $effect(() => {
    for (const id of userIds) userCache.queue(id);
  });
</script>

{#each userIds as uid (uid)}
  {@const user = userCache.get(uid)}
  {@const name = user?.display_name ?? user?.username ?? '…'}
  {@const initial = (name.trim()[0] ?? '?').toUpperCase()}
  <div
    class="flex items-center gap-1.5 rounded px-2 py-0.5 text-xs text-text-muted hover:bg-bg-hover hover:text-text-base"
    data-testid="voice-presence-member"
    data-user-id={uid}
    title={name}
  >
    <Avatar.Root class="size-4 shrink-0">
      {#if user?.avatar_url?.startsWith('https://')}
        <Avatar.Image src={user.avatar_url} alt={name} />
      {/if}
      <Avatar.Fallback class="bg-primary text-primary-foreground text-[8px]">
        {initial}
      </Avatar.Fallback>
    </Avatar.Root>
    <span class="truncate">{name}</span>
    {#if streamingUserIds.includes(uid)}
      <span
        class="ml-auto shrink-0 rounded bg-red-600 px-1 py-px text-[9px] font-bold leading-none text-white"
        data-testid="user-streaming-badge"
        title="teilt seinen Bildschirm"
      >LIVE</span>
    {/if}
  </div>
{/each}
