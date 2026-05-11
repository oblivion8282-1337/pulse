<script lang="ts">
  import type { Snippet } from 'svelte';
  import { AlertDialog } from 'bits-ui';
  let { children, ...rest }: { children?: Snippet; [key: string]: unknown } = $props();
</script>
<AlertDialog.Portal>
  <AlertDialog.Overlay class="fixed inset-0 z-50 bg-black/60" />
  <AlertDialog.Content class="bg-popover text-popover-foreground fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-neutral-700 p-6 shadow-xl">
    {@render children?.()}
  </AlertDialog.Content>
</AlertDialog.Portal>
