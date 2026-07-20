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

<!-- `text-text-base` statt `text-text-muted`: das ist die einzige Stelle, an der
     Text direkt auf dem Untergrund steht statt auf einer Fläche. Seit der
     Untergrund im hellen Modus Farbe trägt, käme die gedämpfte Stufe dort nur
     noch auf 3,93:1 — auf einer Fläche sind es 4,83:1. -->
<div class="text-text-base flex min-h-dvh items-center justify-center text-sm">
  loading…
</div>
