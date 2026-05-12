<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import SendHorizontalIcon from '@lucide/svelte/icons/send-horizontal';

  let {
    placeholder = 'Nachricht senden',
    onSend
  }: {
    placeholder?: string;
    onSend: (text: string) => void;
  } = $props();

  let text = $state('');

  function fire() {
    const value = text.trim();
    if (!value) return;
    onSend(value);
    text = '';
  }

  function submit(e: SubmitEvent) {
    e.preventDefault();
    fire();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      fire();
    }
  }
</script>

<form class="px-4 pt-2 pb-[calc(1.25rem+env(safe-area-inset-bottom))] md:pb-5" onsubmit={submit}>
  <div class="bg-bg-input flex items-end gap-3 rounded-2xl border border-border px-4 py-3 backdrop-blur-sm">
    <textarea
      rows="1"
      bind:value={text}
      onkeydown={onKeydown}
      {placeholder}
      class="text-text-bright placeholder:text-text-muted max-h-40 min-h-[1.5rem] flex-1 resize-none border-0 bg-transparent text-[15px] outline-none"
      data-testid="message-input"
    ></textarea>
    <Button
      type="submit"
      size="icon-sm"
      disabled={!text.trim()}
      data-testid="message-send"
      aria-label="Senden"
    >
      <SendHorizontalIcon />
    </Button>
  </div>
</form>
