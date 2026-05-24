<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { ModeWatcher } from 'mode-watcher';
  import { Toaster } from '$lib/components/ui/sonner/index.js';
  import { settings } from '$lib/stores/settings.svelte';
  import { initDesktopPtt } from '$lib/platform/ptt';
  import { initStream } from '$lib/stream/state.svelte';
  import { loadAll as loadPlugins } from '$lib/plugins';
  import ShortcutHost from '$lib/components/ShortcutHost.svelte';

  let { children } = $props();

  // Re-assert the persisted appearance preference (dcc.settings) as the source
  // of truth once ModeWatcher has mounted.
  onMount(() => {
    settings.applyTheme();
    // Wire up the desktop global push-to-talk shortcut. Currently a no-op stub
    // (global PTT needs a native key-listener — see ptt.ts); the in-window
    // keyboard PTT in VoiceChannelView keeps working regardless.
    let disposePtt: (() => void) | undefined;
    void initDesktopPtt().then((d) => {
      disposePtt = d;
    });
    // Wire the GSR-sidecar event channel into the reactive stream-state store.
    // No-op outside Electron; safe to call eagerly because the sidecar itself is
    // still lazy-spawned (the first invoke is what brings Python up).
    let disposeStream: (() => void) | undefined;
    void initStream().then((d) => {
      disposeStream = d;
    });
    // Plugin-System Schritt 4: discover + activate plugins. Per-plugin
    // failures are caught inside loadAll(); this top-level guard is just
    // belt-and-suspenders so a broken plugin can never break boot.
    void loadPlugins().catch((err) => console.error('[plugins] loadAll failed', err));
    return () => {
      disposePtt?.();
      disposeStream?.();
    };
  });
</script>

<svelte:head>
  <title>Pulse</title>
</svelte:head>

<ModeWatcher defaultMode="system" track disableHeadScriptInjection />

<div class="min-h-dvh">
  {@render children?.()}
</div>

<ShortcutHost />

<Toaster position="bottom-right" richColors />
