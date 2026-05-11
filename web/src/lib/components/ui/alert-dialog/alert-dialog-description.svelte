<script lang="ts">
  import type { Snippet } from 'svelte';
  import { AlertDialog } from 'bits-ui';
  let { children }: { children?: Snippet } = $props();
</script>
<AlertDialog.Description class="text-muted-foreground text-sm">
  {@render children?.()}
</AlertDialog.Description>
