<script lang="ts">
  /**
   * Move target picker for a single dropbox entry — the user types
   * the destination parent_path. Currently text-only; a folder tree
   * picker would replace the input.
   */
  import { m as pm } from '$lib/paraglide/messages.js';

  type Props = {
    name: string;
    value: string;
    onInput: (v: string) => void;
    onCancel: () => void;
    onCommit: () => void;
  };

  let { name, value, onInput, onCancel, onCommit }: Props = $props();
</script>

<div
  class="fixed inset-0 z-50 grid place-items-center bg-bg/80 backdrop-blur-sm"
  data-testid="dropbox-move-dialog"
>
  <div class="glass-panel w-96 rounded-2xl p-5">
    <h3 class="mb-3 text-sm font-semibold">{pm.dropbox_move_title()}</h3>
    <p class="text-text-faint mb-2 text-xs">
      {pm.dropbox_move_hint({ name })}
    </p>
    <input
      type="text"
      {value}
      placeholder="screenshots/2026"
      oninput={(e) => onInput((e.currentTarget as HTMLInputElement).value)}
      class="w-full rounded-md border border-border/40 bg-bg-input px-3 py-1.5 font-mono text-sm focus:border-primary focus:outline-none"
      data-testid="dropbox-move-input"
    />
    <div class="mt-4 flex justify-end gap-2">
      <button
        class="rounded-md px-3 py-1 text-sm hover:bg-bg-hover"
        onclick={onCancel}
      >
        {pm.dropbox_cancel()}
      </button>
      <button
        class="rounded-md bg-primary px-3 py-1 text-sm font-medium text-white"
        onclick={onCommit}
      >
        {pm.dropbox_save()}
      </button>
    </div>
  </div>
</div>
