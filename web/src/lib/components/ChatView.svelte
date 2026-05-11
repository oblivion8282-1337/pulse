<script lang="ts">
  import { tick, untrack } from 'svelte';
  import HashIcon from '@lucide/svelte/icons/hash';
  import UsersIcon from '@lucide/svelte/icons/users';
  import MessageItem from './MessageItem.svelte';
  import MessageInput from './MessageInput.svelte';
  import MemberList from './MemberList.svelte';
  import type { Channel, Message } from '$lib/api/types';
  import { auth } from '$lib/stores/auth.svelte';
  import { userCache } from '$lib/stores/users.svelte';

  let {
    channel,
    messages,
    onSend
  }: {
    channel: Channel | null;
    messages: Message[];
    onSend: (text: string) => void;
  } = $props();

  let scrollContainer = $state<HTMLDivElement | null>(null);
  let lastCount = $state(0);
  let memberListOpen = $state(false);

  // Queue unknown author IDs for batch fetch; use untrack to avoid re-runs
  // caused by userCache.byId writes from the same flush.
  $effect(() => {
    const toQueue = messages
      .filter((m) => !auth.user || m.author_id !== auth.user.id)
      .map((m) => m.author_id);
    untrack(() => {
      for (const id of toQueue) userCache.queue(id);
    });
  });

  $effect(() => {
    const count = messages.length;
    if (count !== lastCount) {
      lastCount = count;
      void tick().then(() => {
        if (scrollContainer) scrollContainer.scrollTop = scrollContainer.scrollHeight;
      });
    }
  });

  function authorName(m: Message): string {
    if (auth.user && m.author_id === auth.user.id) {
      return auth.user.display_name ?? auth.user.username;
    }
    return userCache.displayName(m.author_id);
  }

  function avatarUrl(m: Message): string | null {
    if (auth.user && m.author_id === auth.user.id) {
      const url = auth.user.avatar_url;
      return url?.startsWith('https://') ? url : null;
    }
    const u = userCache.get(m.author_id);
    const url = u?.avatar_url ?? null;
    return url?.startsWith('https://') ? url : null;
  }
</script>

<section class="bg-bg-chat flex h-full min-w-0 flex-1 flex-col">
  <header class="flex h-12 items-center gap-2 border-b border-black/30 px-4 shadow-sm">
    {#if channel}
      <HashIcon class="text-text-muted size-5" />
      <span class="text-text-bright font-semibold" data-testid="active-channel-name">{channel.name}</span>
      {#if channel.topic}
        <span class="text-text-muted ml-3 border-l border-neutral-700 pl-3 text-sm">{channel.topic}</span>
      {/if}
      <button
        class="ml-auto rounded p-1.5 hover:bg-neutral-700"
        onclick={() => (memberListOpen = !memberListOpen)}
        aria-label="Mitgliederliste umschalten"
        data-testid="member-list-toggle"
      >
        <UsersIcon class="text-text-muted size-4" />
      </button>
    {:else}
      <span class="text-text-muted text-sm">Wähle einen Kanal aus</span>
    {/if}
  </header>

  <div class="flex min-h-0 flex-1">
    <div bind:this={scrollContainer} class="flex-1 overflow-y-auto py-4" data-testid="message-list">
      {#if channel}
        {#if messages.length === 0}
          <p class="text-text-muted px-4 py-8 text-center text-sm">
            Noch keine Nachrichten in <strong class="text-text-bright">#{channel.name}</strong>. Sei der/die erste!
          </p>
        {:else}
          {#each messages as m (m.id)}
            <MessageItem message={m} authorName={authorName(m)} {avatarUrl} />
          {/each}
        {/if}
      {/if}
    </div>

    {#if channel && memberListOpen}
      <MemberList guildId={channel.guild_id} />
    {/if}
  </div>

  {#if channel}
    <MessageInput placeholder={`Nachricht in #${channel.name}`} {onSend} />
  {/if}
</section>
