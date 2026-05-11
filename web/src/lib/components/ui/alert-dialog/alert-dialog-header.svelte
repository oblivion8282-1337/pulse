<script lang="ts">
  import type { Snippet } from 'svelte';
  let { children }: { children?: Snippet } = $props();
</script>
<div class="mb-4 flex flex-col gap-1">
  {@render children?.()}
</div>
