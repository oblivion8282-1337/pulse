<script lang="ts">
  import type { Snippet } from 'svelte';
  import { AlertDialog } from 'bits-ui';
  let { children, disabled = false, onclick, ...rest }: {
    children?: Snippet;
    disabled?: boolean;
    onclick?: () => void;
    [key: string]: unknown;
  } = $props();
</script>
<AlertDialog.Action>
  {#snippet child({ props })}
    <button
      {...props}
      {...rest}
      {disabled}
      onclick={onclick}
      class="bg-destructive text-destructive-foreground hover:bg-destructive/90 rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50"
    >
      {@render children?.()}
    </button>
  {/snippet}
</AlertDialog.Action>
