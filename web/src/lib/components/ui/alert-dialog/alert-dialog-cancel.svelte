<script lang="ts">
  import type { Snippet } from 'svelte';
  import { AlertDialog } from 'bits-ui';
  let { children, disabled = false }: { children?: Snippet; disabled?: boolean } = $props();
</script>
<AlertDialog.Cancel>
  {#snippet child({ props })}
    <button
      {...props}
      {disabled}
      class="rounded-md border border-neutral-600 px-4 py-2 text-sm font-medium hover:bg-neutral-700 disabled:opacity-50"
    >
      {@render children?.()}
    </button>
  {/snippet}
</AlertDialog.Cancel>
