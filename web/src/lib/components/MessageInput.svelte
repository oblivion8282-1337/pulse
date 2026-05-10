<script lang="ts">
  let {
    placeholder = 'Nachricht senden',
    onSend
  }: {
    placeholder?: string;
    onSend: (text: string) => void;
  } = $props();

  let text = $state('');

  function submit(e: SubmitEvent) {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    onSend(value);
    text = '';
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const value = text.trim();
      if (!value) return;
      onSend(value);
      text = '';
    }
  }
</script>

<form class="px-4 pb-6 pt-2" onsubmit={submit}>
  <div class="flex items-end gap-2 rounded-lg bg-[var(--color-bg-input)] px-4 py-2.5">
    <textarea
      rows="1"
      bind:value={text}
      onkeydown={onKeydown}
      {placeholder}
      class="max-h-40 min-h-[1.5rem] flex-1 resize-none border-0 bg-transparent text-sm text-[var(--color-text-bright)] outline-none placeholder:text-[var(--color-text-muted)]"
      data-testid="message-input"
    ></textarea>
    <button
      type="submit"
      disabled={!text.trim()}
      class="text-sm font-semibold text-[var(--color-accent)] hover:underline disabled:text-[var(--color-text-muted)] disabled:no-underline"
      data-testid="message-send"
    >
      Senden
    </button>
  </div>
</form>
