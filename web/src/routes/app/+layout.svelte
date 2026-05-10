<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount, onDestroy } from 'svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { messages } from '$lib/stores/messages.svelte';
  import { gateway } from '$lib/ws/connection';
  import { logout } from '$lib/api/auth';
  import { loadTokens } from '$lib/api/storage';

  let { children } = $props();
  let hydrated = $state(false);

  onMount(async () => {
    await auth.hydrate();
    if (!auth.isAuthenticated) {
      await goto('/login', { replaceState: true });
      return;
    }
    try {
      await guilds.hydrate();
    } catch (err) {
      console.error('guilds.hydrate failed', err);
    }
    void gateway.connect().catch((e) => console.error('gateway connect', e));
    hydrated = true;
  });

  onDestroy(() => {
    gateway.disconnect();
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
    guilds.clear();
    messages.clear();
    await goto('/login', { replaceState: true });
  }
</script>

<div class="flex h-screen w-screen bg-[var(--color-bg-base)] text-[var(--color-text-base)]" data-testid="app-shell">
  {#if !hydrated}
    <div class="flex flex-1 items-center justify-center text-sm text-[var(--color-text-muted)]">
      loading…
    </div>
  {:else}
    {@render children?.()}
    <button
      class="fixed bottom-4 right-4 rounded-md bg-neutral-800 px-3 py-1 text-xs text-[var(--color-text-muted)] hover:bg-neutral-700"
      onclick={onSignOut}
      data-testid="sign-out"
    >
      Abmelden
    </button>
  {/if}
</div>
