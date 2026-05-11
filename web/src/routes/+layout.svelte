<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { ModeWatcher } from 'mode-watcher';
  import { Toaster } from '$lib/components/ui/sonner/index.js';
  import { settings } from '$lib/stores/settings.svelte';

  let { children } = $props();

  // Re-assert the persisted appearance preference (dcc.settings) as the source
  // of truth once ModeWatcher has mounted.
  onMount(() => settings.applyTheme());
</script>

<svelte:head>
  <title>Pulse</title>
</svelte:head>

<ModeWatcher defaultMode="system" track disableHeadScriptInjection />

<div class="min-h-screen">
  {@render children?.()}
</div>

<Toaster position="bottom-right" richColors />
