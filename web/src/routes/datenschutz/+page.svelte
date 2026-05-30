<script lang="ts">
  import LegalPage from '$lib/components/LegalPage.svelte';
  import source from '$lib/legal/datenschutz.md?raw';
</script>

<svelte:head>
  <title>Datenschutzerklärung · Pulse</title>
</svelte:head>

<LegalPage {source} />
