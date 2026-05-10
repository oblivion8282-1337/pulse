<script lang="ts">
  let {
    open = false,
    onClose,
    onCreate
  }: {
    open?: boolean;
    onClose: () => void;
    onCreate: (name: string) => void;
  } = $props();

  let name = $state('');

  function submit(e: SubmitEvent) {
    e.preventDefault();
    const trimmed = name.trim().replace(/\s+/g, '-').toLowerCase();
    if (!trimmed) return;
    onCreate(trimmed);
    name = '';
  }
</script>

{#if open}
  <div
    role="presentation"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    onclick={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}
    onkeydown={(e) => {
      if (e.key === 'Escape') onClose();
    }}
  >
    <form
      role="dialog"
      aria-modal="true"
      aria-label="Kanal erstellen"
      class="w-full max-w-md space-y-4 rounded-xl bg-[var(--color-bg-channels)] p-6 shadow-2xl"
      onsubmit={submit}
      data-testid="create-channel-dialog"
    >
      <h2 class="text-xl font-semibold text-[var(--color-text-bright)]">Kanal erstellen</h2>
      <label class="block">
        <span class="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
          Kanal-Name
        </span>
        <input
          type="text"
          bind:value={name}
          class="input-base"
          required
          minlength="1"
          maxlength="64"
          data-testid="create-channel-name"
        />
      </label>
      <div class="flex justify-end gap-2">
        <button type="button" class="rounded px-4 py-2 text-sm hover:underline" onclick={onClose}>
          Abbrechen
        </button>
        <button type="submit" class="btn-primary" data-testid="create-channel-submit">
          Erstellen
        </button>
      </div>
    </form>
  </div>
{/if}
