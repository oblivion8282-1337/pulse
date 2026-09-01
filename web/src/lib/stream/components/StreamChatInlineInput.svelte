<!--
  StreamChatInlineInput — Pill-shaped Live-Chat-Eingabe für den Fullscreen-
  Modus des WhepPlayer (Bubbles fließen darüber hinweg). Nur das Eingabefeld
  + Send-Button; kein Verlauf — der kommt visuell aus dem StreamChatOverlay.

  Wird vom WhepPlayer nur gemountet wenn `isFullscreen && chatOpen` und holt
  sich automatisch den Fokus.
-->
<script lang="ts">
import { errText } from '$lib/utils/errText';
  import { onMount } from 'svelte';
  import { chatApi } from '$lib/api/chat';
  import { toast } from 'svelte-sonner';
  import SendHorizontalIcon from '@lucide/svelte/icons/send-horizontal';
  import { m } from '$lib/paraglide/messages.js';

  let { channelId, streamerId }: { channelId: string; streamerId: string } = $props();

  let draft = $state('');
  let sending = $state(false);
  let inputEl = $state<HTMLInputElement | null>(null);

  onMount(() => {
    // Im nächsten Tick fokussieren — sonst „klaut" der Toggle-Klick den Fokus zurück.
    queueMicrotask(() => inputEl?.focus());
  });

  async function send(): Promise<void> {
    const text = draft.trim();
    if (!text || sending) return;
    sending = true;
    try {
      await chatApi.postStreamChat(channelId, streamerId, text);
      draft = '';
    } catch (e) {
      const msg = errText(e);
      if (msg.includes('410')) toast.error(m.stream_chat_inline_streamer_offline());
      else if (msg.includes('429')) toast.warning(m.stream_chat_inline_too_fast());
      else toast.error(m.stream_chat_inline_send_failed(), { description: msg });
    } finally {
      sending = false;
    }
  }
</script>

<form
  class="absolute right-2 bottom-14 z-10 flex w-72 max-w-[80%] items-center gap-2 rounded-full bg-black/55 px-3 py-1.5 backdrop-blur-sm"
  onsubmit={(e) => {
    e.preventDefault();
    void send();
  }}
  data-testid="hq-stream-chat-input"
>
  <input
    bind:this={inputEl}
    bind:value={draft}
    onkeydown={(e) => e.key === 'Escape' && inputEl?.blur()}
    type="text"
    maxlength={4000}
    placeholder={m.stream_chat_inline_input_placeholder()}
    class="flex-1 bg-transparent text-sm text-white placeholder:text-white/50 focus:outline-none"
    aria-label={m.stream_chat_inline_input_aria()}
  />
  <button
    type="submit"
    disabled={!draft.trim() || sending}
    class="flex items-center text-white hover:text-white/70 disabled:opacity-30"
    aria-label={m.stream_chat_inline_send_aria()}
  >
    <SendHorizontalIcon class="size-4" />
  </button>
</form>
