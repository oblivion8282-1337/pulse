<script lang="ts">
  /**
   * Small modal that lets the user rename a single dropbox entry.
   * Wires `bind:value` so the parent doesn't need two-way plumbing;
   * emits `cancel` / `commit` on dismiss or save.
   */
  import { m as pm } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input/index.js';

  type Props = {
    value: string;
    onInput: (v: string) => void;
    onCancel: () => void;
    onCommit: () => void;
  };

  let { value, onInput, onCancel, onCommit }: Props = $props();
</script>

<div
  class="fixed inset-0 z-50 grid place-items-center bg-bg/80 backdrop-blur-sm"
  data-testid="dropbox-rename-dialog"
>
  <div class="glass-panel w-80 rounded-2xl p-5">
    <h3 class="mb-3 text-sm font-semibold">{pm.dropbox_rename_title()}</h3>
    <Input
      type="text"
      {value}
      oninput={(e) => onInput((e.currentTarget as HTMLInputElement).value)}
      data-testid="dropbox-rename-input"
    />
    <div class="mt-4 flex justify-end gap-2">
      <Button variant="ghost" size="sm" onclick={onCancel}>
        {pm.dropbox_cancel()}
      </Button>
      <Button size="sm" onclick={onCommit}>
        {pm.dropbox_save()}
      </Button>
    </div>
  </div>
</div>
