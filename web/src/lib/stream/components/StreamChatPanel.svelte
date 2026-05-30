<!--
  StreamChatPanel — Twitch-Style Live-Chat-Seitenpanel für einen einzelnen
  HQ-Streamer (channel × user). Verlauf via REST-Backfill (chronologisch),
  Live-Pushes aus dem WS-`streamChat`-Store, Eingabe → `chatApi.postStreamChat`.

  Ephemer: wenn der Streamer offline geht, ruft der WS-Dispatcher
  `streamChat.pruneAbsent` → unsere `for(...)` ist leer → Empty-State.
-->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { streamChat } from '$lib/stores/streamChat.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { chatApi } from '$lib/api/chat';
  import MessageInput from '$lib/components/MessageInput.svelte';
  import RocketIcon from '@lucide/svelte/icons/rocket';
  import XIcon from '@lucide/svelte/icons/x';
  import { toast } from 'svelte-sonner';
  import { m } from '$lib/paraglide/messages.js';

  let {
    channelId,
    streamerId,
    onClose
  }: {
    channelId: string;
    streamerId: string;
    onClose?: () => void;
  } = $props();

  let messages = $derived(streamChat.for(channelId, streamerId));
  let streamerName = $derived(userCache.displayName(streamerId));
  let listEl = $state<HTMLDivElement | null>(null);
  let loading = $state(true);

  // userCache-Fetch für Streamer + alle Autoren.
  $effect(() => {
    userCache.queue(streamerId);
    for (const m of messages) userCache.queue(m.author_id);
  });

  // Backfill auf Mount + bei Streamer-Wechsel.
  $effect(() => {
    const cid = channelId;
    const sid = streamerId;
    loading = true;
    let cancelled = false;
    void chatApi
      .getStreamChat(cid, sid, 100)
      .then((msgs) => {
        if (cancelled) return;
        streamChat.seed(cid, sid, msgs);
      })
      .catch(() => {
        /* 403 wenn der User den Channel verloren hat, 410 wenn der Stream
           gerade gestorben ist — beides nicht-fatal, Empty-State reicht. */
      })
      .finally(() => {
        if (!cancelled) loading = false;
      });
    return () => {
      cancelled = true;
    };
  });

  // Auto-scroll an den Boden bei neuen Messages.
  $effect(() => {
    if (messages.length === 0) return;
    void tick().then(() => {
      const el = listEl;
      if (el) el.scrollTop = el.scrollHeight;
    });
  });

  async function send(content: string, _attachmentIds: string[] = []) {
    try {
      await chatApi.postStreamChat(channelId, streamerId, content);
      // Kein lokales Echo nötig — der eigene WS-Stream liefert die Message
      // gleich zurück (dedupliziert per id im Store).
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('410')) {
        toast.error(m.stream_chat_panel_streamer_offline());
      } else if (msg.includes('429')) {
        toast.warning(m.stream_chat_panel_too_fast());
      } else {
        toast.error(m.stream_chat_panel_send_failed(), { description: msg });
      }
    }
  }

  function fmtTime(iso: string): string {
    try {
      return new Date(iso).toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return '';
    }
  }

  onMount(() => {
    void tick().then(() => {
      const el = listEl;
      if (el) el.scrollTop = el.scrollHeight;
    });
  });
</script>

<aside
  class="glass-panel flex h-full w-full flex-col overflow-hidden border-l border-border md:w-72"
  data-testid="stream-chat-panel"
  data-streamer-id={streamerId}
>
  <header class="flex h-14 items-center gap-2 border-b border-border px-3">
    <RocketIcon class="size-4 text-red-500" />
    <span class="text-text-bright truncate text-sm font-semibold">
      {m.stream_chat_panel_header({ streamerName })}
    </span>
    {#if onClose}
      <button
        type="button"
        class="ml-auto rounded-full p-3 transition-colors hover:bg-bg-hover hover:text-primary md:p-1.5"
        onclick={onClose}
        aria-label={m.stream_chat_panel_close_aria()}
        title={m.stream_chat_panel_close_title()}
        data-testid="stream-chat-close"
      >
        <XIcon class="text-text-muted size-5 md:size-4" />
      </button>
    {/if}
  </header>

  <div
    bind:this={listEl}
    class="flex-1 overflow-y-auto px-3 py-2"
    data-testid="stream-chat-messages"
  >
    {#if loading && messages.length === 0}
      <p class="text-text-muted py-6 text-center text-xs">{m.stream_chat_panel_loading()}</p>
    {:else if messages.length === 0}
      <p class="text-text-muted py-6 text-center text-xs">
        {m.stream_chat_panel_empty()}
      </p>
    {:else}
      <ul class="flex flex-col gap-1.5">
        {#each messages as msg (msg.id)}
          <li class="text-sm leading-snug">
            <span class="font-semibold text-primary">
              {userCache.displayName(msg.author_id)}
            </span>
            <span class="text-text-muted ml-1 text-[10px]">{fmtTime(msg.created_at)}</span>
            <p class="text-text-bright break-words">{msg.content}</p>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <MessageInput placeholder={m.stream_chat_panel_input_placeholder()} onSend={send} />
</aside>
