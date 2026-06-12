<!--
  WatchChatPanel — Seitenleisten-Chat für eine aktive Watch Party.
  Ein Chat pro Channel (kein streamer_id). Backfill via REST, Live-Updates
  per WS `watch_chat_message`. Wird in VoiceChannelView's rechtem Slot gezeigt.
-->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { watchChat } from '$lib/stores/watchChat.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { chatApi } from '$lib/api/chat';
  import MessageInput from '$lib/components/MessageInput.svelte';
  import MessageReactions from '$lib/components/MessageReactions.svelte';
  import EmojiPicker from '$lib/components/EmojiPicker.svelte';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import PlayCircleIcon from '@lucide/svelte/icons/play-circle';
  import SmilePlusIcon from '@lucide/svelte/icons/smile-plus';
  import XIcon from '@lucide/svelte/icons/x';
  import { toast } from 'svelte-sonner';
  import { m } from '$lib/paraglide/messages.js';

  let {
    channelId,
    onClose
  }: {
    channelId: string;
    onClose?: () => void;
  } = $props();

  let messages = $derived(watchChat.for(channelId));
  let listEl = $state<HTMLDivElement | null>(null);
  let loading = $state(true);

  $effect(() => {
    for (const m of messages) userCache.queue(m.author_id);
  });

  $effect(() => {
    const cid = channelId;
    loading = true;
    let cancelled = false;
    void chatApi
      .getWatchChat(cid, 100)
      .then((msgs) => {
        if (cancelled) return;
        watchChat.seed(cid, msgs);
      })
      .catch(() => {
        /* 403 wenn kein Mitglied, 410 wenn Party schon vorbei — Empty-State reicht. */
      })
      .finally(() => {
        if (!cancelled) loading = false;
      });
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    if (messages.length === 0) return;
    void tick().then(() => {
      if (listEl) listEl.scrollTop = listEl.scrollHeight;
    });
  });

  async function send(content: string, _attachmentIds: string[] = []) {
    try {
      await chatApi.postWatchChat(channelId, content);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('410')) {
        toast.error(m.watch_chat_panel_party_inactive());
      } else if (msg.includes('429')) {
        toast.warning(m.watch_chat_panel_rate_limited());
      } else {
        toast.error(m.watch_chat_panel_send_failed(), { description: msg });
      }
    }
  }

  // Optimistisch togglen; der WS-Broadcast (`watch_chat_reaction`) gleicht
  // den Server-Zustand danach für alle Clients an.
  async function toggleReaction(messageId: string, emoji: string, _currentlyMine: boolean) {
    // KEIN optimistisches Update: der Server-Toggle broadcastet ein
    // watch_chat_reaction-Echo (auch an uns selbst), das applyReaction in den
    // Store foldet. Würden wir hier zusätzlich optimistisch togglen, käme die
    // eigene Reaktion doppelt an. Gleiche Mechanik wie der normale Chat
    // (channel-page toggleReaction → nur API, WS aktualisiert).
    try {
      await chatApi.toggleWatchChatReaction(channelId, messageId, emoji);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('410')) {
        toast.error(m.watch_chat_panel_party_inactive());
      } else if (!msg.includes('429')) {
        toast.error(m.watch_chat_panel_send_failed(), { description: msg });
      }
    }
  }

  function fmtTime(iso: string): string {
    try {
      return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  }

  onMount(() => {
    void tick().then(() => {
      if (listEl) listEl.scrollTop = listEl.scrollHeight;
    });
  });
</script>

<aside
  class="glass-panel flex h-full w-full flex-col overflow-hidden border-l border-border md:w-72"
  data-testid="watch-chat-panel"
>
  <header class="flex h-14 items-center gap-2 border-b border-border px-3">
    <PlayCircleIcon class="size-4 text-primary" />
    <span class="text-text-bright truncate text-sm font-semibold">{m.watch_chat_panel_title()}</span>
    {#if onClose}
      <button
        type="button"
        class="ml-auto rounded-full p-3 transition-colors hover:bg-bg-hover hover:text-primary md:p-1.5"
        onclick={onClose}
        aria-label={m.watch_chat_panel_close_aria()}
        title={m.watch_chat_panel_close_title()}
        data-testid="watch-chat-close"
      >
        <XIcon class="text-text-muted size-5 md:size-4" />
      </button>
    {/if}
  </header>

  <div
    bind:this={listEl}
    class="flex-1 overflow-y-auto px-3 py-2"
    data-testid="watch-chat-messages"
  >
    {#if loading && messages.length === 0}
      <p class="text-text-muted py-6 text-center text-xs">{m.watch_chat_panel_loading()}</p>
    {:else if messages.length === 0}
      <p class="text-text-muted py-6 text-center text-xs">
        {m.watch_chat_panel_empty()}
      </p>
    {:else}
      <ul class="flex flex-col gap-1.5">
        {#each messages as msg (msg.id)}
          <li class="group/msg text-sm leading-snug" data-testid="watch-chat-message">
            <div class="flex items-baseline gap-1">
              <span class="text-primary font-semibold">{userCache.displayName(msg.author_id)}</span>
              <span class="text-text-muted text-[10px]">{fmtTime(msg.created_at)}</span>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                  {#snippet child({ props })}
                    <button
                      {...props}
                      type="button"
                      class="text-text-muted ml-auto rounded-full p-1 opacity-0 transition-opacity hover:bg-bg-hover hover:text-primary focus-visible:opacity-100 group-hover/msg:opacity-100"
                      title={m.message_reactions_add_reaction()}
                      aria-label={m.message_reactions_add_reaction()}
                      data-testid="watch-chat-react-add"
                    >
                      <SmilePlusIcon class="size-3.5" />
                    </button>
                  {/snippet}
                </DropdownMenu.Trigger>
                <DropdownMenu.Content
                  side="top"
                  align="end"
                  sideOffset={6}
                  class="w-auto max-w-[calc(100vw-1rem)] overflow-visible border-0 bg-transparent p-0 shadow-none"
                >
                  <EmojiPicker onPick={(emoji) => toggleReaction(msg.id, emoji, false)} />
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            </div>
            <p class="text-text-bright break-words">{msg.content}</p>
            {#if msg.reactions && msg.reactions.length > 0}
              <MessageReactions
                reactions={msg.reactions}
                onToggle={(emoji, mine) => toggleReaction(msg.id, emoji, mine)}
              />
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <MessageInput placeholder={m.watch_chat_panel_input_placeholder()} onSend={send} />
</aside>
