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

<form class="px-4 pb-6 pt-2" onsubmit={submit}>
  <div class="bg-bg-input flex items-end gap-2 rounded-lg px-4 py-2.5">
    <textarea
      rows="1"
      bind:value={text}
      onkeydown={onKeydown}
      {placeholder}
      class="text-text-bright placeholder:text-text-muted max-h-40 min-h-[1.5rem] flex-1 resize-none border-0 bg-transparent text-sm outline-none"
      data-testid="message-input"
    ></textarea>
    <Button
      type="submit"
      variant="ghost"
      size="icon-sm"
      disabled={!text.trim()}
      class="text-primary hover:text-primary"
      data-testid="message-send"
      aria-label="Senden"
    >
      <SendHorizontalIcon />
    </Button>
  </div>
</form>
