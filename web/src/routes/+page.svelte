<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { auth } from '$lib/stores/auth.svelte';

  onMount(async () => {
    await auth.hydrate();
    if (auth.isAuthenticated) {
      void goto('/app', { replaceState: true });
    } else {
      void goto('/login', { replaceState: true });
    }
  });
</script>

<div class="text-text-muted flex min-h-dvh items-center justify-center text-sm">
  loading…
</div>
