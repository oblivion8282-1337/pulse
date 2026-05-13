<script lang="ts">
  import { tick, untrack } from 'svelte';
  import HashIcon from '@lucide/svelte/icons/hash';
  import UsersIcon from '@lucide/svelte/icons/users';
  import MenuIcon from '@lucide/svelte/icons/menu';
  import MessageItem from './MessageItem.svelte';
  import MessageInput from './MessageInput.svelte';
  import MemberList from './MemberList.svelte';
  import type { Channel, Message } from '$lib/api/types';
  import { auth } from '$lib/stores/auth.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { safeAvatarUrl } from '$lib/avatar';

  type ChatItem =
    | { kind: 'divider'; label: string; key: string }
    | { kind: 'message'; message: Message; isContinuation: boolean; key: string };

  let {
    channel,
    messages,
    onSend,
    onMenuClick,
    isOwner = false,
    onEditMessage,
    onDeleteMessage,
    onToggleReaction
  }: {
    channel: Channel | null;
    messages: Message[];
    onSend: (text: string, replyToId: string | null) => void;
    onMenuClick?: () => void;
    isOwner?: boolean;
    onEditMessage: (m: Message, newContent: string) => void;
    onDeleteMessage: (m: Message) => void;
    onToggleReaction: (m: Message, emoji: string, currentlyMine: boolean) => void;
  } = $props();

  let replyTarget = $state<Message | null>(null);

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
    return safeAvatarUrl(raw);
  }

  // Mitgliederliste: auf Mobil als Sheet von rechts, auf Desktop als Spalte
  let showMemberOverlay = $derived(memberListOpen && viewport.isMobile);
  let showMemberInline = $derived(memberListOpen && !viewport.isMobile);

  function snippet(text: string): string {
    const t = text.replace(/\s+/g, ' ').trim();
    return t.length > 80 ? t.slice(0, 77) + '…' : t;
  }

  function replyMetaFor(m: Message): { id: string; author: string; snippet: string } | null {
    if (!m.reply_to_id) return null;
    const parent = messages.find((x) => x.id === m.reply_to_id);
    if (!parent) {
      // Parent isn't loaded (older than our window or deleted) — show a stub.
      return { id: m.reply_to_id, author: '…', snippet: '(ältere Nachricht)' };
    }
    return { id: parent.id, author: authorName(parent), snippet: snippet(parent.content) };
  }

  const replyBanner = $derived(
    replyTarget ? { id: replyTarget.id, author: authorName(replyTarget), snippet: snippet(replyTarget.content) } : null
  );

  function startReply(m: Message) {
    replyTarget = m;
  }
  function cancelReply() {
    replyTarget = null;
  }
  function jumpToReply(parentId: string) {
    const el = scrollContainer?.querySelector(`[data-message-id="${parentId}"]`);
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('ring-2', 'ring-primary');
      setTimeout(() => el.classList.remove('ring-2', 'ring-primary'), 1500);
    }
  }

  function handleSend(text: string) {
    const target = replyTarget;
    onSend(text, target?.id ?? null);
    replyTarget = null;
  }

  function canEditMessage(m: Message): boolean {
    return !!auth.user && m.author_id === auth.user.id && !m.id.startsWith('tmp-') && !m.deleted_at;
  }
  function canDeleteMessage(m: Message): boolean {
    if (!auth.user) return false;
    if (m.id.startsWith('tmp-')) return false;
    return m.author_id === auth.user.id || isOwner;
  }
</script>

<section class="glass-panel flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-none md:rounded-2xl">
  <header class="flex h-14 items-center gap-2.5 px-3 md:px-5">
    {#if onMenuClick}
      <button
        class="mr-1 rounded-full p-2 transition-colors hover:bg-bg-hover hover:text-primary md:hidden"
        onclick={onMenuClick}
        aria-label="Menü"
        data-testid="mobile-menu-toggle"
      >
        <MenuIcon class="text-text-muted size-4" />
      </button>
    {/if}
    {#if channel}
      <HashIcon class="text-primary size-5 shrink-0" />
      <span class="text-text-bright truncate text-base font-semibold tracking-tight md:text-lg" data-testid="active-channel-name">{channel.name}</span>
      {#if channel.topic}
        <span class="text-text-muted ml-2 hidden truncate text-sm md:block">· {channel.topic}</span>
      {/if}
      <button
        class="ml-auto rounded-full p-2 transition-colors hover:bg-bg-hover hover:text-primary"
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

  <div class="relative flex min-h-0 flex-1">
    <div bind:this={scrollContainer} class="flex-1 overflow-y-auto py-4" data-testid="message-list">
      {#if channel}
        {#if messages.length === 0}
          <p class="text-text-muted px-4 py-8 text-center text-sm">
            Noch keine Nachrichten in <strong class="text-text-bright">#{channel.name}</strong>. Sei der/die erste!
          </p>
        {:else}
          {#each items as item (item.key)}
            {#if item.kind === 'divider'}
              <div class="mx-5 my-4 flex items-center gap-3" data-testid="date-divider">
                <div class="h-px flex-1 bg-border"></div>
                <span class="bg-bg-input text-text-muted rounded-full px-3 py-0.5 text-xs font-semibold">{item.label}</span>
                <div class="h-px flex-1 bg-border"></div>
              </div>
            {:else}
              <MessageItem
                message={item.message}
                authorName={authorName(item.message)}
                replyTo={replyMetaFor(item.message)}
                avatarUrl={avatarUrl}
                isContinuation={item.isContinuation}
                canEdit={canEditMessage(item.message)}
                canDelete={canDeleteMessage(item.message)}
                onReply={startReply}
                onEditSubmit={onEditMessage}
                onDelete={onDeleteMessage}
                onToggleReaction={onToggleReaction}
                onJumpToReply={jumpToReply}
              />
            {/if}
          {/each}
        {/if}
      {/if}
    </div>

    <!-- Inline auf md+ -->
    {#if channel && showMemberInline}
      <MemberList guildId={channel.guild_id} />
    {/if}

    <!-- Sheet von rechts auf Mobil -->
    {#if channel && showMemberOverlay}
      <div
        class="fixed inset-0 z-30 bg-black/40"
        role="presentation"
        onclick={() => (memberListOpen = false)}
      ></div>
      <div class="fixed inset-y-0 right-0 z-40 flex w-4/5 max-w-xs flex-col">
        <MemberList guildId={channel.guild_id} onClose={() => (memberListOpen = false)} />
      </div>
    {/if}
  </div>

  {#if channel}
    <MessageInput
      placeholder={`Nachricht in #${channel.name}`}
      onSend={handleSend}
      replyTo={replyBanner}
      onCancelReply={cancelReply}
    />
  {/if}
</section>
