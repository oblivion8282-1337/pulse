<script lang="ts">
  import { tick } from 'svelte';
  import MessageItem from './MessageItem.svelte';
  import MessageInput from './MessageInput.svelte';
  import type { Channel, Message } from '$lib/api/types';
  import { auth } from '$lib/stores/auth.svelte';

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

  $effect(() => {
    // Auto-scroll to bottom whenever a new message arrives.
    const count = messages.length;
    if (count !== lastCount) {
      lastCount = count;
      void tick().then(() => {
        if (scrollContainer) {
          scrollContainer.scrollTop = scrollContainer.scrollHeight;
        }
      });
    }
  });

  function authorName(m: Message): string {
    if (auth.user && m.author_id === auth.user.id) return auth.user.display_name ?? auth.user.username;
    return `User ${m.author_id.slice(-4)}`;
  }
</script>

<section class="flex h-full min-w-0 flex-1 flex-col bg-[var(--color-bg-chat)]">
  <header class="flex h-12 items-center border-b border-black/30 px-4 shadow-sm">
    {#if channel}
      <span class="text-[var(--color-text-muted)]">#</span>
      <span class="ml-2 font-semibold text-[var(--color-text-bright)]" data-testid="active-channel-name">
        {channel.name}
      </span>
      {#if channel.topic}
        <span class="ml-3 border-l border-neutral-700 pl-3 text-sm text-[var(--color-text-muted)]">
          {channel.topic}
        </span>
      {/if}
    {:else}
      <span class="text-sm text-[var(--color-text-muted)]">Wähle einen Kanal aus</span>
    {/if}
  </header>

  <div
    bind:this={scrollContainer}
    class="flex-1 overflow-y-auto py-4"
    data-testid="message-list"
  >
    {#if channel}
      {#if messages.length === 0}
        <p class="px-4 py-8 text-center text-sm text-[var(--color-text-muted)]">
          Noch keine Nachrichten in <strong class="text-[var(--color-text-bright)]">#{channel.name}</strong>.
          Sei der/die erste!
        </p>
      {:else}
        {#each messages as m (m.id)}
          <MessageItem message={m} authorName={authorName(m)} />
        {/each}
      {/if}
    {/if}
  </div>

  {#if channel}
    <MessageInput placeholder={`Nachricht in #${channel.name}`} {onSend} />
  {/if}
</section>
