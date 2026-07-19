<script lang="ts">
  /**
   * Modal that collects a new folder name. Same pattern as
   * DropboxRenameDialog (inline fixed overlay + glass-panel body)
   * so the dialogs feel like one family. Parent owns the
   * ``name`` state via ``bind:value``-style callbacks.
   */
  import { onMount } from 'svelte';
  import { m as pm } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button';

  type Props = {
    name: string;
    onInput: (v: string) => void;
    onCancel: () => void;
    onCommit: () => void;
  };

  let { name, onInput, onCancel, onCommit }: Props = $props();

  // ponytail: explicit focus-on-mount instead of the `autofocus` attr.
  // Svelte flags autofocus as a11y-unsafe (screen readers get jumped
  // past); the manual call lands focus only after the dialog has
  // rendered and the user already sees the input.
  let inputEl: HTMLInputElement | undefined;
  onMount(() => inputEl?.focus());

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter') onCommit();
    else if (e.key === 'Escape') onCancel();
  }
</script>

<div
  class="fixed inset-0 z-50 grid place-items-center bg-bg/80 backdrop-blur-sm"
  data-testid="dropbox-folder-dialog"
>
  <div class="glass-panel w-96 rounded-2xl p-5 shadow-2xl">
    <h3 class="mb-3 text-sm font-semibold">{pm.dropbox_new_folder()}</h3>
    <input
      type="text"
      {name}
      bind:this={inputEl}
      oninput={(e) => onInput((e.currentTarget as HTMLInputElement).value)}
      onkeydown={onKey}
      placeholder={pm.dropbox_new_folder_placeholder()}
      class="w-full rounded-md border border-border/40 bg-bg-input px-3 py-2 font-mono text-sm focus:border-primary focus:outline-none"
      data-testid="dropbox-folder-name-input"
    />
    <div class="mt-4 flex justify-end gap-2">
      <Button variant="ghost" size="sm" onclick={onCancel} data-testid="dropbox-folder-cancel">
        {pm.dropbox_cancel()}
      </Button>
      <Button size="sm" onclick={onCommit} data-testid="dropbox-folder-create">
        {pm.dropbox_create()}
      </Button>
    </div>
  </div>
</div>
