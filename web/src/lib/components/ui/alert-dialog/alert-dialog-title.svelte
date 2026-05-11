<script lang="ts">
  import type { Snippet } from 'svelte';
  import { AlertDialog } from 'bits-ui';
  let { children }: { children?: Snippet } = $props();
</script>
<AlertDialog.Title class="text-lg font-semibold">
  {@render children?.()}
</AlertDialog.Title>
