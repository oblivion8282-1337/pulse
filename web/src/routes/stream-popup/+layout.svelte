<!--
  Stream-Popup-Layout — eigenständiger Mini-Shell für entkoppelte Streams,
  außerhalb von `/app`. Nur Auth + Gateway, kein Guild-Rail/Channel-Sidebar.

  Multi-Tab/Multi-Window: jeder Tab hat seine eigene `gateway`-Singleton-
  Instanz (Module-State pro JS-Context), die Verbindungen koexistieren ohne
  Probleme — Backend-Side genau wie zwei Discord-Tabs am selben Account.
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
      // Kein gültiges Login → Popup schließt sich; alternativ Redirect, aber
      // ein Popup ohne Login zu öffnen wäre ein Bug im Aufrufer.
      try { window.close(); } catch {}
      await goto('/login', { replaceState: true });
      return;
    }
    gateway.connect().catch((e) => console.error('popup gateway connect', e));
    hydrated = true;
  });

  onDestroy(() => {
    gateway.disconnect();
  });
</script>

<svelte:head><title>{m.stream_popup_page_title()}</title></svelte:head>

<div class="h-dvh w-screen bg-black text-text-base">
  {#if hydrated}
    {@render children?.()}
  {:else}
    <div class="flex h-full w-full items-center justify-center text-text-muted text-sm">
      {m.stream_popup_loading()}
    </div>
  {/if}
</div>
