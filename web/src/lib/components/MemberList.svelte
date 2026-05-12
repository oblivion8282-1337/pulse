<script lang="ts">
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import XIcon from '@lucide/svelte/icons/x';
  import { chatApi } from '$lib/api/chat';
  import { userCache } from '$lib/stores/users.svelte';
  import type { Member } from '$lib/api/types';

  let {
    guildId,
    onClose
  }: {
    guildId: string;
    onClose?: () => void;
  } = $props();

  let members = $state<Member[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);

  $effect(() => {
    if (!guildId) return;
    void load(guildId);
  });

  async function load(id: string) {
    loading = true;
    error = null;
    try {
      members = await chatApi.listMembers(id);
      for (const m of members) userCache.queue(m.user_id);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  function displayName(m: Member): string {
    if (m.nickname) return m.nickname;
    return userCache.displayName(m.user_id);
  }

  function avatarUrl(m: Member): string | null {
    const u = userCache.get(m.user_id);
    const url = u?.avatar_url ?? null;
    return url?.startsWith('https://') ? url : null;
  }

  function initials(m: Member): string {
    return displayName(m).slice(0, 1).toUpperCase();
  }
</script>

<aside
  class="border-border bg-bg-chat flex h-full w-full flex-col border-l md:w-44 md:bg-transparent lg:w-52"
  data-testid="member-list"
>
  <header class="flex h-14 items-center justify-between px-4">
    <span class="text-text-muted text-xs font-bold">
      Mitglieder — {members.length}
    </span>
    {#if onClose}
      <button
        class="rounded-full p-1.5 transition-colors hover:bg-bg-hover md:hidden"
        onclick={onClose}
        aria-label="Schließen"
      >
        <XIcon class="text-text-muted size-4" />
      </button>
    {/if}
  </header>

  <div class="flex-1 overflow-y-auto px-2.5 py-1">
    {#if loading}
      <p class="text-text-muted px-3 py-4 text-xs">Lädt…</p>
    {:else if error}
      <p class="px-3 py-4 text-xs text-red-400">{error}</p>
    {:else}
      {#each members as m (m.user_id)}
        {@const name = displayName(m)}
        {@const url = avatarUrl(m)}
        <div
          class="hover:bg-bg-hover flex items-center gap-2.5 rounded-xl px-3 py-2"
          data-testid="member-item"
          data-user-id={m.user_id}
        >
          <Avatar.Root class="size-8 shrink-0">
            {#if url}
              <Avatar.Image src={url} alt={name} />
            {/if}
            <Avatar.Fallback class="accent-gradient text-primary-foreground text-xs font-semibold">
              {initials(m)}
            </Avatar.Fallback>
          </Avatar.Root>
          <span class="text-text-base truncate text-sm font-medium">{name}</span>
        </div>
      {/each}
      {#if members.length === 0}
        <p class="text-text-muted px-3 py-4 text-xs">Keine Mitglieder.</p>
      {/if}
    {/if}
  </div>
</aside>
