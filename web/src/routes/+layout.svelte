<script lang="ts">
  import '../app.css';
  import { Toaster } from '$lib/components/ui/sonner/index.js';

  let { children } = $props();
</script>

<svelte:head>
  <title>Pulse</title>
</svelte:head>

<div class="min-h-screen">
  {@render children?.()}
</div>

<Toaster theme="dark" position="bottom-right" richColors />
