<!--
  Watch-Popup-Layout — eigenständiger Mini-Shell für entkoppelte Watch-
  Partys, außerhalb von `/app`. Nur Auth + Gateway, kein Guild-Rail.
  Praktisch identisch zum stream-popup-Layout — Multi-Tab/Multi-Window
  ist seitens des Backends unkritisch (jede Gateway-Connection = eigene
  Session am chat-gateway).
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import { gateway } from '$lib/ws/connection';
  import { m } from '$lib/paraglide/messages.js';

  let { children } = $props();
  let hydrated = $state(false);

  onMount(async () => {
    await auth.hydrate();
    if (!auth.isAuthenticated) {
      try { window.close(); } catch {}
      await goto('/login', { replaceState: true });
      return;
    }
    gateway.connect().catch((e) => console.error('watch-popup gateway connect', e));
    hydrated = true;
  });

  onDestroy(() => {
    gateway.disconnect();
  });
</script>

<svelte:head><title>{m.watch_popup_page_title()}</title></svelte:head>

<div class="h-dvh w-screen bg-black text-text-base">
  {#if hydrated}
    {@render children?.()}
  {:else}
    <div class="flex h-full w-full items-center justify-center text-text-muted text-sm">
      {m.watch_popup_loading()}
    </div>
  {/if}
</div>
