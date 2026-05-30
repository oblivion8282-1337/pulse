<script lang="ts">
  import LegalPage from '$lib/components/LegalPage.svelte';
  import source from '$lib/legal/impressum.md?raw';
</script>

<svelte:head>
  <title>Impressum · Pulse</title>
</svelte:head>

<LegalPage {source} />
