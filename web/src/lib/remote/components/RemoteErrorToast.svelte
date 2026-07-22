<!--
  RemoteErrorToast — zeigt Fernsteuerungs-Fehler als Toast. Der Session-Store
  setzt `remoteSession.error` (abgelehnt / Host offline / keine Berechtigung),
  rendert ihn aber selbst nicht. Global gemountet, kein eigenes Markup.
-->
<script lang="ts">
  import { toast } from 'svelte-sonner';
  import { remoteSession } from '$lib/remote/session.svelte';

  $effect(() => {
    const err = remoteSession.error;
    if (err) {
      toast.error(err);
      remoteSession.error = null; // einmal zeigen, dann löschen
    }
  });
</script>
