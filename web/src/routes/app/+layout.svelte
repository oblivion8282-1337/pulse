<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount, onDestroy } from 'svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { messages } from '$lib/stores/messages.svelte';
  import { gateway } from '$lib/ws/connection';
  // livekit.svelte is lazy-loaded below to keep it out of the main bundle.
  import { logout } from '$lib/api/auth';
  import { loadTokens } from '$lib/api/storage';
  import { Button } from '$lib/components/ui/button/index.js';
  import LogOutIcon from '@lucide/svelte/icons/log-out';

  let { children } = $props();
  let hydrated = $state(false);

  onMount(async () => {
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

  async function onSignOut() {
    const t = loadTokens();
    if (t) {
      try {
        await logout(t.refresh_token);
      } catch {
        /* ignore */
      }
    }
    auth.signOut();
    gateway.disconnect();
    void import('$lib/voice/livekit.svelte').then(({ voice }) => voice.disconnect());
    guilds.clear();
    messages.clear();
    await goto('/login', { replaceState: true });
  }
</script>

<div class="bg-bg-base text-text-base flex h-screen w-screen" data-testid="app-shell">
  {#if !hydrated}
    <div class="text-text-muted flex flex-1 items-center justify-center text-sm">loading…</div>
  {:else}
    {@render children?.()}
    <Button
      variant="secondary"
      size="sm"
      class="fixed bottom-4 right-4 gap-1.5"
      onclick={onSignOut}
      data-testid="sign-out"
    >
      <LogOutIcon class="size-3.5" />
      Abmelden
    </Button>
  {/if}
</div>
