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

  type ChatItem =
    | { kind: 'divider'; label: string; key: string }
    | { kind: 'message'; message: Message; isContinuation: boolean; key: string };

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
      const isInitialLoad = lastCount === 0;
      lastCount = count;
      void tick().then(() => {
        const el = scrollContainer;
        if (!el) return;
        const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 80;
        if (isInitialLoad || nearBottom) {
          el.scrollTop = el.scrollHeight;
        }
      });
    }
  });

  function formatDividerLabel(date: Date): string {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 86400000);
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    if (d.getTime() === today.getTime()) return 'Heute';
    if (d.getTime() === yesterday.getTime()) return 'Gestern';
    return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  let items = $derived<ChatItem[]>(buildItems(messages));

  function buildItems(msgs: Message[]): ChatItem[] {
    const result: ChatItem[] = [];
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      const prev = msgs[i - 1];
      const mDate = new Date(m.created_at);
      const prevDate = prev ? new Date(prev.created_at) : null;

      // Date divider when day changes
      if (!prevDate || mDate.toDateString() !== prevDate.toDateString()) {
        result.push({ kind: 'divider', label: formatDividerLabel(mDate), key: `div-${m.id}` });
      }

      // Continuation: same author, within 7 min, no divider separating them
      const isContinuation =
        !!prev &&
        m.author_id === prev.author_id &&
        mDate.getTime() - new Date(prev.created_at).getTime() < 7 * 60 * 1000 &&
        mDate.toDateString() === new Date(prev.created_at).toDateString();

      result.push({ kind: 'message', message: m, isContinuation, key: m.id });
    }
    return result;
  }

  function authorName(m: Message): string {
    if (auth.user && m.author_id === auth.user.id) {
      return auth.user.display_name ?? auth.user.username;
    }
    return userCache.displayName(m.author_id);
  }

  function avatarUrl(m: Message): string | null {
    const raw = auth.user && m.author_id === auth.user.id
      ? auth.user.avatar_url
      : (userCache.get(m.author_id)?.avatar_url ?? null);
    if (!raw) return null;
    return raw.startsWith('/') || raw.startsWith('https://') ? raw : null;
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
          {#each items as item (item.key)}
            {#if item.kind === 'divider'}
              <div class="mx-4 my-3 flex items-center gap-3" data-testid="date-divider">
                <div class="h-px flex-1 bg-neutral-700"></div>
                <span class="text-text-muted text-xs font-medium">{item.label}</span>
                <div class="h-px flex-1 bg-neutral-700"></div>
              </div>
            {:else}
              <MessageItem
                message={item.message}
                authorName={authorName(item.message)}
                avatarUrl={avatarUrl}
                isContinuation={item.isContinuation}
              />
            {/if}
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
