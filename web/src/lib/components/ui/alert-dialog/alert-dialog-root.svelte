<script lang="ts">
  import type { Snippet } from 'svelte';
  import { AlertDialog } from 'bits-ui';
  let { open = $bindable(false), children }: { open?: boolean; children?: Snippet } = $props();
</script>
<AlertDialog.Root bind:open>
  {@render children?.()}
</AlertDialog.Root>
