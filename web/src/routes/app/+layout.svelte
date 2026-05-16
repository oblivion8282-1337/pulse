<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount, onDestroy } from 'svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { gateway } from '$lib/ws/connection';
  import { viewport } from '$lib/stores/viewport.svelte';

  let { children } = $props();
  let hydrated = $state(false);

  onMount(async () => {
    viewport.init();
    await auth.hydrate();
    if (!auth.isAuthenticated) {
      await goto('/login', { replaceState: true });
      return;
    }
    await Promise.all([
      guilds.hydrate().catch((e) => console.error('guilds.hydrate failed', e)),
      gateway.connect().catch((e) => console.error('gateway connect', e))
    ]);
    hydrated = true;
  });

  onDestroy(() => {
    gateway.disconnect();
    void import('$lib/voice/livekit.svelte').then(({ voice }) => voice.disconnect());
  });
</script>

<div class="text-text-base flex h-dvh w-screen gap-0 p-0 md:gap-3 md:p-3" data-testid="app-shell">
  {#if !hydrated}
    <div class="text-text-muted flex flex-1 items-center justify-center text-sm">loading…</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
