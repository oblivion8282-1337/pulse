<script lang="ts">
  import LegalPage from '$lib/components/LegalPage.svelte';
  import source from '$lib/legal/agb.md?raw';
</script>

<svelte:head>
  <title>AGB · Pulse</title>
</svelte:head>

<LegalPage {source} />
