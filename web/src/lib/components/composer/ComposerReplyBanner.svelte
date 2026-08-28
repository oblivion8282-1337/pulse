<!--
  Der Zitat-Streifen ueber dem Verfasser-Feld.

  Eigene Datei, seit `MessageInput.svelte` bei der Anhang-Etappe geteilt wurde
  (es lag deutlich ueber der 250-Zeilen-Grenze). Rein darstellend — kein
  Zustand, keine Logik, dieselbe `data-testid`.
-->
<script lang="ts">
  import XIcon from '@lucide/svelte/icons/x';
  import { m } from '$lib/paraglide/messages.js';

  let {
    replyTo,
    onCancel
  }: {
    replyTo: { id: string; author: string; snippet: string };
    onCancel?: () => void;
  } = $props();
</script>

<div
  class="bg-bg-input mb-1 flex items-center gap-2 rounded-t-xl border border-b-0 border-border px-3 py-1.5 text-xs"
  data-testid="reply-banner"
>
  <span class="text-text-muted">{m.message_input_reply_to()}</span>
  <span class="text-text-bright font-semibold">{replyTo.author}</span>
  <span class="text-text-muted truncate">— {replyTo.snippet}</span>
  <button
    type="button"
    class="text-text-muted hover:text-text-bright ml-auto rounded p-0.5"
    aria-label={m.message_input_cancel_reply()}
    onclick={() => onCancel?.()}
  >
    <XIcon class="size-3.5" />
  </button>
</div>
