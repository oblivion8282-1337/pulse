<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { ModeWatcher } from 'mode-watcher';
  import { Toaster } from '$lib/components/ui/sonner/index.js';
  import { settings } from '$lib/stores/settings.svelte';
  import { initDesktopPtt } from '$lib/platform/ptt';

  let { children } = $props();

  // Re-assert the persisted appearance preference (dcc.settings) as the source
  // of truth once ModeWatcher has mounted.
  onMount(() => {
    settings.applyTheme();
    // Bridge the Tauri global push-to-talk shortcut to the voice room. No-op in
    // a plain browser — the in-window keyboard PTT keeps working there as before.
    let dispose: (() => void) | undefined;
    void initDesktopPtt().then((d) => {
      dispose = d;
    });
    return () => dispose?.();
  });
</script>

<svelte:head>
  <title>Pulse</title>
</svelte:head>

<ModeWatcher defaultMode="system" track disableHeadScriptInjection />

<div class="min-h-screen">
  {@render children?.()}
</div>

<Toaster position="bottom-right" richColors />
